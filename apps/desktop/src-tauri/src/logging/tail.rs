//! A view onto the log pipeline for one target (ADR 2026-11-23 "Show a feature's log lines live
//! in its settings page"): the last lines of a target from today's file ([`tail`]) and a live feed
//! of the lines that follow ([`Hub`]). Both read what the pipeline already redacted: the tail
//! parses the file, the feed is fed by the writer thread with the very line it writes, so the view
//! and the file can never differ. Nothing here names a feature; the targets a view may ask for
//! are the allowlist [`WATCHABLE_TARGETS`], owned by core.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The targets a view may ask for. A feature with logs worth seeing adds its target here.
pub const WATCHABLE_TARGETS: &[&str] = &["git"];
/// Most lines one `tail` returns.
pub const TAIL_MAX_LINES: usize = 500;
/// How much of the end of the file `tail` reads, however large the file is.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// Live lines one subscriber gets per second; the rest are dropped and counted.
pub const LIVE_LINES_PER_SEC: u32 = 50;
/// Lines buffered for a subscriber that is slow to drain before the writer drops them.
const LIVE_QUEUE: usize = 256;
/// Feeds one window may hold at once.
pub const MAX_FEEDS_PER_OWNER: usize = 8;

pub fn watchable(target: &str) -> bool {
    WATCHABLE_TARGETS.contains(&target)
}

/// One log entry as a view shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogLine {
    /// RFC 3339 UTC, as written.
    pub ts: String,
    /// `error`, `warn`, `info`, `debug` or `trace`.
    pub level: String,
    pub target: String,
    pub message: String,
    /// The structured fields other than the message, when there are any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Value>,
}

/// The entry of one JSON line of the log, `None` for anything else.
pub fn parse_line(json_line: &str) -> Option<LogLine> {
    let v: serde_json::Value = serde_json::from_str(json_line).ok()?;
    let level = v.get("level")?.as_str()?.to_ascii_lowercase();
    let target = v.get("target")?.as_str()?.to_owned();
    let ts = v.get("timestamp")?.as_str()?.to_owned();
    let mut fields = v.get("fields")?.as_object()?.clone();
    let message = match fields.remove("message") {
        Some(serde_json::Value::String(s)) => s,
        _ => String::new(),
    };
    Some(LogLine {
        ts,
        level,
        target,
        message,
        fields: (!fields.is_empty()).then_some(serde_json::Value::Object(fields)),
    })
}

/// The last `limit` (at most [`TAIL_MAX_LINES`]) lines of `target` from the newest app file in
/// `dir`, oldest first. Reads the last [`TAIL_BYTES`] of the file only.
pub fn tail(dir: &Path, target: &str, limit: usize) -> Vec<LogLine> {
    let limit = limit.min(TAIL_MAX_LINES);
    let Some(file) = super::log_files(dir).into_iter().rev().find(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(&format!("{}.", super::APP_PREFIX)))
    }) else {
        return Vec::new();
    };
    let Ok(mut f) = std::fs::File::open(file) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let cut = len > TAIL_BYTES;
    if cut && f.seek(SeekFrom::Start(len - TAIL_BYTES)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.take(TAIL_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if cut {
        // the first line starts before the window
        lines.next();
    }
    let mut found: Vec<LogLine> = lines
        .filter_map(parse_line)
        .filter(|l| l.target == target)
        .collect();
    let skip = found.len().saturating_sub(limit);
    found.drain(..skip);
    found
}

struct Feed {
    id: u64,
    owner: String,
    target: String,
    tx: SyncSender<LogLine>,
    /// Start of the current one-second window, lines sent in it and lines dropped in it.
    window: Instant,
    sent: u32,
    skipped: u32,
}

/// The live subscribers of the pipeline. `publish` runs on the log writer thread, so it never
/// blocks: a lock held for a loop over a few feeds, a target compare and a `try_send` each.
pub struct Hub {
    feeds: Mutex<Vec<Feed>>,
    next: AtomicU64,
    /// Feeds open, read without the lock so a line costs nothing while nobody watches.
    open: AtomicUsize,
}

impl Hub {
    pub const fn new() -> Hub {
        Hub {
            feeds: Mutex::new(Vec::new()),
            next: AtomicU64::new(1),
            open: AtomicUsize::new(0),
        }
    }

    fn feeds(&self) -> std::sync::MutexGuard<'_, Vec<Feed>> {
        self.feeds.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Opens a feed of `target` for `owner` (a window label). `None` past
    /// [`MAX_FEEDS_PER_OWNER`]. The feed ends when the receiver is dropped, on [`Hub::close`] or
    /// on [`Hub::close_owner`].
    pub fn open(&self, owner: &str, target: &str) -> Option<(u64, Receiver<LogLine>)> {
        let mut feeds = self.feeds();
        if feeds.iter().filter(|f| f.owner == owner).count() >= MAX_FEEDS_PER_OWNER {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(LIVE_QUEUE);
        feeds.push(Feed {
            id,
            owner: owner.to_owned(),
            target: target.to_owned(),
            tx,
            window: Instant::now(),
            sent: 0,
            skipped: 0,
        });
        self.open.store(feeds.len(), Ordering::Release);
        Some((id, rx))
    }

    /// Ends feed `id` if `owner` opened it.
    pub fn close(&self, owner: &str, id: u64) -> bool {
        let mut feeds = self.feeds();
        let before = feeds.len();
        feeds.retain(|f| !(f.id == id && f.owner == owner));
        self.open.store(feeds.len(), Ordering::Release);
        feeds.len() != before
    }

    /// Ends every feed of a window that is gone.
    pub fn close_owner(&self, owner: &str) {
        let mut feeds = self.feeds();
        feeds.retain(|f| f.owner != owner);
        self.open.store(feeds.len(), Ordering::Release);
    }

    pub fn len(&self) -> usize {
        self.open.load(Ordering::Acquire)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Hands one written (already redacted) JSON line to the feeds of its target.
    pub fn publish(&self, json_line: &str, now: Instant) {
        if self.is_empty() {
            return;
        }
        let Some(line) = parse_line(json_line) else {
            return;
        };
        let mut feeds = self.feeds();
        feeds.retain_mut(|f| {
            if f.target != line.target {
                return true;
            }
            if now.duration_since(f.window) >= Duration::from_secs(1) {
                if f.skipped > 0 {
                    let note = LogLine {
                        ts: line.ts.clone(),
                        level: "warn".into(),
                        target: line.target.clone(),
                        message: format!("{} lines skipped", f.skipped),
                        fields: None,
                    };
                    let _ = f.tx.try_send(note);
                }
                f.window = now;
                f.sent = u32::from(f.skipped > 0);
                f.skipped = 0;
            }
            if f.sent >= LIVE_LINES_PER_SEC {
                f.skipped += 1;
                return true;
            }
            match f.tx.try_send(line.clone()) {
                Ok(()) => {
                    f.sent += 1;
                    true
                }
                Err(TrySendError::Full(_)) => {
                    f.skipped += 1;
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
        self.open.store(feeds.len(), Ordering::Release);
    }
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new()
    }
}

/// The process's hub, fed by the writer thread of the one pipeline.
pub fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(Hub::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(level: &str, target: &str, message: &str) -> String {
        serde_json::json!({
            "pid": 1,
            "timestamp": "2026-11-23T10:00:00.000Z",
            "level": level,
            "fields": {"message": message},
            "target": target
        })
        .to_string()
    }

    fn write_log(dir: &Path, name: &str, lines: &[String]) {
        std::fs::write(dir.join(name), lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn tail_returns_only_the_target_newest_last_and_not_the_cli_file() {
        let tmp = tempfile::tempdir().unwrap();
        let lines: Vec<String> = (0..10)
            .flat_map(|i| {
                [
                    json("INFO", "git", &format!("git {i}")),
                    json("INFO", "app", &format!("app {i}")),
                ]
            })
            .collect();
        write_log(tmp.path(), "writer.2026-11-23.log", &lines);
        write_log(
            tmp.path(),
            "cli.2026-11-24.log",
            &[json("ERROR", "git", "from the cli")],
        );
        write_log(
            tmp.path(),
            "writer.2026-11-22.log",
            &[json("ERROR", "git", "yesterday")],
        );
        let got = tail(tmp.path(), "git", 3);
        let messages: Vec<&str> = got.iter().map(|l| l.message.as_str()).collect();
        assert_eq!(messages, ["git 7", "git 8", "git 9"]);
        assert!(got.iter().all(|l| l.target == "git" && l.level == "info"));
        assert_eq!(tail(tmp.path(), "git", 10_000).len(), 10);
        assert!(tail(tmp.path(), "nothing", 5).is_empty());
    }

    #[test]
    fn tail_reads_a_bounded_end_of_a_large_file() {
        let tmp = tempfile::tempdir().unwrap();
        let filler = json("INFO", "app", &"x".repeat(900));
        let mut text = String::new();
        // well over the window: the old git lines at the start must not be read
        text.push_str(&(json("INFO", "git", "ancient") + "\n"));
        while (text.len() as u64) < TAIL_BYTES * 2 {
            text.push_str(&filler);
            text.push('\n');
        }
        text.push_str(&(json("WARN", "git", "newest") + "\n"));
        std::fs::write(tmp.path().join("writer.2026-11-23.log"), text).unwrap();
        let got = tail(tmp.path(), "git", 500);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].message, "newest");
        assert_eq!(got[0].level, "warn");
    }

    #[test]
    fn parse_line_keeps_extra_fields_and_refuses_junk() {
        let line =
            r#"{"timestamp":"t","level":"ERROR","fields":{"message":"m","code":2},"target":"git"}"#;
        let l = parse_line(line).unwrap();
        assert_eq!(l.level, "error");
        assert_eq!(l.fields.unwrap()["code"], 2);
        assert!(parse_line("not json").is_none());
        assert!(parse_line(r#"{"level":"INFO"}"#).is_none());
    }

    #[test]
    fn a_feed_gets_the_lines_of_its_target_only_and_ends_on_close() {
        let hub = Hub::new();
        let (id, rx) = hub.open("main", "git").unwrap();
        let (_other, other_rx) = hub.open("main", "agent").unwrap();
        let now = Instant::now();
        hub.publish(&json("INFO", "git", "one"), now);
        hub.publish(&json("INFO", "app", "two"), now);
        assert_eq!(rx.try_recv().unwrap().message, "one");
        assert!(rx.try_recv().is_err());
        assert!(other_rx.try_recv().is_err());
        assert_eq!(hub.len(), 2);
        // another window cannot close it
        assert!(!hub.close("second", id));
        assert!(hub.close("main", id));
        assert_eq!(hub.len(), 1);
        hub.publish(&json("INFO", "git", "three"), now);
        assert!(matches!(
            rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn a_window_closing_ends_all_its_feeds_and_a_dropped_receiver_is_removed() {
        let hub = Hub::new();
        let a = hub.open("w1", "git").unwrap();
        let _b = hub.open("w1", "git").unwrap();
        let _c = hub.open("w2", "git").unwrap();
        hub.close_owner("w1");
        assert_eq!(hub.len(), 1);
        drop(a);
        let d = hub.open("w3", "git").unwrap();
        drop(d.1);
        hub.publish(&json("INFO", "git", "x"), Instant::now());
        assert_eq!(hub.len(), 1, "the feed whose receiver is gone is removed");
        for _ in 0..MAX_FEEDS_PER_OWNER {
            hub.open("w4", "git").unwrap();
        }
        assert!(hub.open("w4", "git").is_none());
    }

    #[test]
    fn a_feed_is_capped_per_second_and_says_how_many_lines_it_skipped() {
        let hub = Hub::new();
        let (_id, rx) = hub.open("main", "git").unwrap();
        let t0 = Instant::now();
        for i in 0..80 {
            hub.publish(&json("INFO", "git", &format!("l{i}")), t0);
        }
        let first: Vec<LogLine> = rx.try_iter().collect();
        assert_eq!(first.len(), LIVE_LINES_PER_SEC as usize);
        // the next second opens with the note, then lines flow again
        hub.publish(
            &json("INFO", "git", "later"),
            t0 + Duration::from_millis(1100),
        );
        let next: Vec<String> = rx.try_iter().map(|l| l.message).collect();
        assert_eq!(next, ["30 lines skipped", "later"]);
    }
}
