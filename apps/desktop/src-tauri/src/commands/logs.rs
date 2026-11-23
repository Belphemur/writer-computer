//! IPC for the local diagnostic logs (`crate::logging`): the frontend's one `log_event` sink,
//! the log folder info the Settings block shows, "Open log folder" and "Copy recent errors".

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

use super::blocking;
use crate::error::AppError;
use crate::logging::tail::{self, LogLine};
use crate::logging::{self, truncated};

const MAX_BATCH: usize = 100;
const MAX_MESSAGE: usize = 4000;
const MAX_STACK: usize = 8000;
const MAX_SHORT: usize = 200;
const MAX_RECENT: usize = 1000;
/// Frontend entries accepted per window; the frontend dedupes too, this is the backstop.
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_MAX: u32 = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// `error | warn | info | debug`.
    level: String,
    /// Where it came from: `console`, `window.onerror`, `unhandledrejection`, `react`,
    /// `plugin`, `ipc`, `app`.
    source: String,
    message: String,
    stack: Option<String>,
    plugin: Option<String>,
    phase: Option<String>,
    version: Option<String>,
    /// Times this entry was suppressed as a repeat since it was last sent.
    repeats: Option<u32>,
}

/// Fixed-window counter: at most `RATE_MAX` entries per `RATE_WINDOW`.
pub struct RateLimiter {
    state: Mutex<(Instant, u32, u32)>,
}

impl RateLimiter {
    pub fn new(now: Instant) -> Self {
        Self {
            state: Mutex::new((now, 0, 0)),
        }
    }

    /// Returns how many of `n` entries are accepted and, when a window just ended, the number
    /// that were dropped in it.
    pub fn admit(&self, now: Instant, n: u32) -> (u32, u32) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut dropped_before = 0;
        if now.duration_since(s.0) >= RATE_WINDOW {
            dropped_before = s.2;
            *s = (now, 0, 0);
        }
        let room = RATE_MAX.saturating_sub(s.1);
        let take = room.min(n);
        s.1 += take;
        s.2 += n - take;
        (take, dropped_before)
    }
}

fn limiter() -> &'static RateLimiter {
    static L: std::sync::OnceLock<RateLimiter> = std::sync::OnceLock::new();
    L.get_or_init(|| RateLimiter::new(Instant::now()))
}

fn emit(window: &str, e: LogEntry) {
    let message = truncated(&e.message, MAX_MESSAGE);
    let source = truncated(&e.source, MAX_SHORT);
    let stack = e
        .stack
        .map(|s| truncated(&s, MAX_STACK))
        .unwrap_or_default();
    let plugin = e
        .plugin
        .map(|s| truncated(&s, MAX_SHORT))
        .unwrap_or_default();
    let phase = e
        .phase
        .map(|s| truncated(&s, MAX_SHORT))
        .unwrap_or_default();
    let version = e
        .version
        .map(|s| truncated(&s, MAX_SHORT))
        .unwrap_or_default();
    let repeats = e.repeats.unwrap_or(0);
    macro_rules! ev {
        ($lvl:expr) => {
            tracing::event!(
                target: "frontend",
                $lvl,
                window = window,
                source = %source,
                plugin = %plugin,
                phase = %phase,
                version = %version,
                stack = %stack,
                repeats,
                "{}",
                message
            )
        };
    }
    match e.level.as_str() {
        "error" => ev!(tracing::Level::ERROR),
        "warn" => ev!(tracing::Level::WARN),
        "debug" => ev!(tracing::Level::DEBUG),
        _ => ev!(tracing::Level::INFO),
    }
}

pub fn log_entries(window: &str, entries: Vec<LogEntry>, now: Instant) {
    let batch: Vec<LogEntry> = entries.into_iter().take(MAX_BATCH).collect();
    let (take, dropped) = limiter().admit(now, batch.len() as u32);
    if dropped > 0 {
        tracing::warn!(target: "frontend", window, "frontend log rate limit: dropped {dropped} entries");
    }
    for e in batch.into_iter().take(take as usize) {
        emit(window, e);
    }
}

/// The single frontend sink. It only queues on the log writer thread, so it does no IO itself.
#[tauri::command]
pub async fn log_event(webview: tauri::Webview, entries: Vec<LogEntry>) -> Result<(), AppError> {
    log_entries(webview.label(), entries, Instant::now());
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    dir: String,
    /// `WRITER_LOG` is set: it wins over the Settings level.
    env_override: bool,
}

#[tauri::command]
pub async fn log_info() -> Result<LogInfo, AppError> {
    let dir = logging::log_dir().ok_or_else(|| AppError::NotFound("log folder".into()))?;
    Ok(LogInfo {
        dir: dir.to_string_lossy().into_owned(),
        env_override: std::env::var(logging::ENV_VAR).is_ok_and(|v| !v.trim().is_empty()),
    })
}

/// Opens the log folder in the OS file manager. Done here (Rust side of the opener plugin) so
/// the webview needs no `opener:allow-open-path` grant for a path outside the workspace.
#[tauri::command]
pub async fn open_log_folder(app: tauri::AppHandle) -> Result<(), AppError> {
    let dir = logging::log_dir().ok_or_else(|| AppError::NotFound("log folder".into()))?;
    blocking(move || {
        std::fs::create_dir_all(&dir)?;
        app.opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<String>)
            .map_err(|e| AppError::Io(e.to_string()))
    })
    .await
}

/// The newest error and warn lines (readable, redacted), oldest first.
#[tauri::command]
pub async fn recent_log_errors(limit: Option<usize>) -> Result<Vec<String>, AppError> {
    let limit = limit.unwrap_or(200).min(MAX_RECENT);
    blocking(move || {
        let dir = logging::log_dir().ok_or_else(|| AppError::NotFound("log folder".into()))?;
        Ok(logging::recent_errors(&dir, limit))
    })
    .await
}

/// The event a live feed emits to the window that opened it.
const LINE_EVENT: &str = "log:line";

fn watchable(target: &str) -> Result<(), AppError> {
    if tail::watchable(target) {
        Ok(())
    } else {
        Err(AppError::Refused(format!("No log view for {target}")))
    }
}

/// The last `limit` (at most 500) redacted lines of `target` from today's app log, oldest first.
#[tauri::command]
pub async fn log_tail(target: String, limit: Option<usize>) -> Result<Vec<LogLine>, AppError> {
    watchable(&target)?;
    let limit = limit.unwrap_or(200);
    blocking(move || {
        let dir = logging::log_dir().ok_or_else(|| AppError::NotFound("log folder".into()))?;
        Ok(tail::tail(&dir, &target, limit))
    })
    .await
}

#[derive(Serialize, Clone)]
struct LinePayload {
    /// The feed the line belongs to (`log_watch`'s answer): a window may hold several.
    id: u64,
    line: LogLine,
}

/// Opens a live feed of `target`: each new redacted line reaches the asking window as a
/// `log:line` event `{ id, line }`, at most 50 a second. Returns the feed's id.
#[tauri::command]
pub async fn log_watch(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    target: String,
) -> Result<u64, AppError> {
    watchable(&target)?;
    let label = webview.label().to_owned();
    let (id, rx) = tail::hub()
        .open(&label, &target)
        .ok_or_else(|| AppError::Refused("Too many log views are open".into()))?;
    // The pipeline's writer thread only queues (never blocks); this thread does the emitting and
    // ends when the feed is closed (the sender drops).
    let spawned = std::thread::Builder::new()
        .name("log-feed".into())
        .spawn(move || {
            for line in rx {
                if app
                    .emit_to(&label, LINE_EVENT, LinePayload { id, line })
                    .is_err()
                {
                    break;
                }
            }
        });
    if let Err(e) = spawned {
        tail::hub().close(webview.label(), id);
        return Err(AppError::Io(e.to_string()));
    }
    Ok(id)
}

#[tauri::command]
pub async fn log_unwatch(webview: tauri::Webview, id: u64) -> Result<(), AppError> {
    tail::hub().close(webview.label(), id);
    Ok(())
}

/// A window is gone: its feeds end.
pub fn window_gone(label: &str) {
    tail::hub().close_owner(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_caps_a_window_and_reports_drops_next_window() {
        let t0 = Instant::now();
        let l = RateLimiter::new(t0);
        assert_eq!(l.admit(t0, 200), (200, 0));
        assert_eq!(l.admit(t0, 200), (100, 0));
        assert_eq!(l.admit(t0, 5), (0, 0));
        let later = t0 + RATE_WINDOW;
        assert_eq!(l.admit(later, 10), (10, 105));
    }

    #[test]
    fn frontend_entries_become_structured_capped_events() {
        let tmp = tempfile::tempdir().unwrap();
        let built = logging::build(
            tmp.path(),
            "writer",
            tracing::level_filters::LevelFilter::WARN,
        )
        .unwrap();
        let entries: Vec<LogEntry> = serde_json::from_str(
            r#"[{"level":"error","source":"plugin","message":"boom api_key=abc12345","plugin":"copilot","phase":"load","version":"1.2.3","stack":"at x"},
                {"level":"info","source":"app","message":"hidden"}]"#,
        )
        .unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            let big = LogEntry {
                level: "warn".into(),
                source: "console".into(),
                message: "y".repeat(50_000),
                stack: None,
                plugin: None,
                phase: None,
                version: None,
                repeats: Some(3),
            };
            log_entries("w-1", entries, Instant::now() + Duration::from_secs(100));
            log_entries("w-1", vec![big], Instant::now() + Duration::from_secs(100));
        });
        drop(built);
        let text: String = logging_files(tmp.path());
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert_eq!(lines[0]["fields"]["plugin"], "copilot");
        assert_eq!(lines[0]["fields"]["phase"], "load");
        assert_eq!(lines[0]["fields"]["window"], "w-1");
        assert!(!lines[0].to_string().contains("abc12345"));
        assert!(lines[1]["fields"]["message"].as_str().unwrap().len() < 4100);
    }

    #[test]
    fn a_feed_through_the_real_pipeline_gets_redacted_lines_of_its_target_only() {
        let tmp = tempfile::tempdir().unwrap();
        let built = logging::build(
            tmp.path(),
            "writer",
            tracing::level_filters::LevelFilter::INFO,
        )
        .unwrap();
        let (id, rx) = tail::hub().open("feed-test", "feed-test-target").unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            tracing::info!(target: "somewhere-else", "not for the feed");
            tracing::warn!(
                target: "feed-test-target",
                "failed https://me:hunter2pw@host.test/r.git token=abcd1234efgh"
            );
        });
        let line = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(line.level, "warn");
        assert!(
            line.message.contains("https://[redacted]@host.test"),
            "{line:?}"
        );
        assert!(!line.message.contains("hunter2pw") && !line.message.contains("abcd1234"));
        assert!(rx.try_recv().is_err());
        drop(built);
        // the feed carries what the file has
        let text = logging_files(tmp.path());
        assert!(!text.contains("hunter2pw"));
        assert!(tail::hub().close("feed-test", id));
        window_gone("feed-test");
    }

    #[test]
    fn only_allowlisted_targets_have_a_view() {
        assert!(watchable("git").is_ok());
        assert!(watchable("frontend").is_err());
        assert!(watchable("panic").is_err());
    }

    fn logging_files(dir: &std::path::Path) -> String {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| std::fs::read_to_string(e.path()).unwrap())
            .collect()
    }
}
