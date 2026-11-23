//! Local diagnostic logs: the one place that decides where log lines go, what they may contain
//! and how long they live. See `docs/decisions/2026-11-16-always-write-local-error-logs.md`.
//!
//! - Files: `<log dir>/<prefix>.<YYYY-MM-DD>.log`, one JSON object per line, UTC timestamps with
//!   a `Z` offset. `prefix` is `writer` for the app and `cli` for the `writer` command. Daily
//!   rotation, at most [`MAX_LOG_FILES`] files per prefix (older ones are deleted when the
//!   appender starts and on every rotation).
//! - Directory: the identifier-based OS log dir, the same one Tauri's `app_log_dir` resolves to
//!   (`~/Library/Logs/<identifier>` on macOS).
//! - Levels: `info` and above by default (everything is logged; files rotate, 3 days max). The `diagnostics.log-level` setting raises it; the
//!   env var `WRITER_LOG` (`error|warn|info|debug|trace|off`) wins over the setting.
//! - Writing never blocks the caller: events are formatted on the calling thread and handed to
//!   a worker thread through a bounded channel (lossy when the disk stalls, never blocking).
//! - Views: [`tail`] reads a target's last lines back and feeds a live subscriber from the writer
//!   thread, after redaction (a settings page shows its feature's log).
//! - Everything a line contains is redacted in [`sanitize_line`] right before it is queued, so
//!   every source (this crate's `log` macros, `tracing`, the frontend bridge, the panic hook)
//!   gets the same treatment. Logs never leave the machine.

pub mod tail;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::{NonBlocking, NonBlockingBuilder, WorkerGuard};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::Registry;

pub const APP_PREFIX: &str = "writer";
pub const CLI_PREFIX: &str = "cli";
/// Daily files kept per prefix: three days at most.
pub const MAX_LOG_FILES: usize = 3;
/// Env override for the level; wins over the setting.
pub const ENV_VAR: &str = "WRITER_LOG";
pub const LEVEL_SETTING_KEY: &str = "diagnostics.log-level";
const DEFAULT_LEVEL: LevelFilter = LevelFilter::INFO;
/// A line longer than this has its strings truncated (see [`sanitize_line`]).
const MAX_LINE_BYTES: usize = 16 * 1024;
/// Buffered lines before the queue starts dropping instead of blocking.
const QUEUE_LINES: usize = 8192;
const MAX_VAULT_ROOTS: usize = 32;

// ---------- Location ----------

/// The app identifier, read from the one place it is declared.
fn identifier() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
            .ok()
            .and_then(|v| v.get("identifier")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| "com.writer-computer".to_owned())
    })
}

/// Where this OS keeps the log files of `identifier`; mirrors Tauri's `app_log_dir`.
pub fn log_dir_for(identifier: &str) -> Option<PathBuf> {
    let env = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    #[cfg(target_os = "macos")]
    {
        env("HOME").map(|h| h.join("Library/Logs").join(identifier))
    }
    #[cfg(target_os = "windows")]
    {
        env("LOCALAPPDATA").map(|d| d.join(identifier).join("logs"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        env("XDG_DATA_HOME")
            .or_else(|| env("HOME").map(|h| h.join(".local/share")))
            .map(|d| d.join(identifier).join("logs"))
    }
}

pub fn log_dir() -> Option<PathBuf> {
    log_dir_for(identifier())
}

// ---------- Level ----------

/// `WRITER_LOG` first, then the setting, then `warn`. Unknown strings fall through.
pub fn resolve_level(env: Option<&str>, setting: Option<&str>) -> LevelFilter {
    [env, setting]
        .into_iter()
        .flatten()
        .find_map(|s| s.trim().to_ascii_lowercase().parse::<LevelFilter>().ok())
        .unwrap_or(DEFAULT_LEVEL)
}

type LevelSetter = Box<dyn Fn(LevelFilter) + Send + Sync>;
static LEVEL_SETTER: OnceLock<LevelSetter> = OnceLock::new();
static ENV_OVERRIDE: AtomicBool = AtomicBool::new(false);

/// Applies the `diagnostics.log-level` setting to the running logger. No-op when `WRITER_LOG`
/// is set (the env var wins) or before [`init_app`].
pub fn apply_level_setting(value: Option<&str>) {
    if ENV_OVERRIDE.load(Ordering::Relaxed) {
        return;
    }
    if let Some(set) = LEVEL_SETTER.get() {
        set(resolve_level(None, value));
    }
}

pub fn level_setting(settings: &crate::config::Settings) -> Option<String> {
    settings
        .get(LEVEL_SETTING_KEY)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

// ---------- Redaction ----------

static VAULT_ROOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Remembers an open vault root so its absolute path is logged as `<vault>`.
pub fn register_vault_root(root: &Path) {
    let root = root.to_string_lossy().trim_end_matches('/').to_string();
    if root.len() < 2 {
        return;
    }
    let mut roots = VAULT_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if !roots.contains(&root) && roots.len() < MAX_VAULT_ROOTS {
        roots.push(root);
    }
}

fn secret_patterns() -> &'static [(regex_lite::Regex, &'static str)] {
    static P: OnceLock<Vec<(regex_lite::Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        let rules: &[(&str, &str)] = &[
            // `Authorization: Bearer x`, `authorization=Basic x`, `Authorization":"x`
            (
                r#"(?i)(authorization(?:\\?")?\s*[:=]\s*(?:\\?")?)(?:(?:bearer|basic|token)\s+)?[^\s",;\\]+"#,
                "${1}[redacted]",
            ),
            (r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{6,}", "Bearer [redacted]"),
            // Key-like and key=value secrets, in text or inside JSON.
            (
                r#"(?i)((?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|token)(?:\\?")?\s*[:=]\s*(?:\\?")?)[^\s",&;\\]+"#,
                "${1}[redacted]",
            ),
            (r"\bsk-[A-Za-z0-9_-]{8,}", "sk-[redacted]"),
            (r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}", "gh_[redacted]"),
            (r"\bgithub_pat_[A-Za-z0-9_]{16,}", "gh_[redacted]"),
            (r"\bxox[abprs]-[A-Za-z0-9-]{8,}", "xox-[redacted]"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA[redacted]"),
            // URL credentials and query strings.
            (r#"(?i)(\b[a-z][a-z0-9+.-]*://)[^/\s"\\@]+@"#, "${1}[redacted]@"),
            (r#"(?i)(\bhttps?://[^\s"\\?#]*)\?[^\s"\\#]*"#, "${1}?[redacted]"),
            // Anyone's home directory, whichever account the line came from.
            (r#"/(?:Users|home)/[^/\s"\\]+"#, "~"),
        ];
        rules
            .iter()
            .map(|(re, to)| (regex_lite::Regex::new(re).expect("valid redaction pattern"), *to))
            .collect()
    })
}

/// The home-directory pattern, compiled once per distinct home (the process has one).
fn home_regex(home: &str) -> regex_lite::Regex {
    static CACHE: Mutex<Option<(String, regex_lite::Regex)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((h, re)) = cache.as_ref() {
        if h == home {
            return re.clone();
        }
    }
    let re = regex_lite::Regex::new(&format!("{}\\b", regex_lite::escape(home)))
        .expect("escaped literal is a valid pattern");
    *cache = Some((home.to_owned(), re.clone()));
    re
}

/// Redacts a piece of text: vault roots become `<vault>`, the home directory `~`, and secrets
/// (`sk-` keys, bearer tokens, `api_key=`, `Authorization:`, URL query strings and credentials)
/// become `[redacted]`.
pub fn redact_with(text: &str, home: Option<&str>, vault_roots: &[String]) -> String {
    let mut out = text.to_owned();
    let mut roots: Vec<&String> = vault_roots.iter().collect();
    roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
    for root in roots {
        out = out.replace(root.as_str(), "<vault>");
    }
    if let Some(home) = home
        .map(|h| h.trim_end_matches('/'))
        .filter(|h| h.len() > 1)
    {
        out = home_regex(home).replace_all(&out, "~").into_owned();
    }
    for (re, to) in secret_patterns() {
        out = re.replace_all(&out, *to).into_owned();
    }
    out
}

fn home() -> Option<String> {
    ["HOME", "USERPROFILE"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
}

pub fn redact(text: &str) -> String {
    let roots = VAULT_ROOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    redact_with(text, home().as_deref(), &roots)
}

fn truncate_strings(v: &mut serde_json::Value, max: usize) {
    match v {
        serde_json::Value::String(s) => truncate_in_place(s, max),
        serde_json::Value::Array(a) => a.iter_mut().for_each(|x| truncate_strings(x, max)),
        serde_json::Value::Object(o) => o.iter_mut().for_each(|(_, x)| truncate_strings(x, max)),
        _ => {}
    }
}

/// Cuts `s` to at most `max` bytes on a char boundary and marks the cut.
pub fn truncate_in_place(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str("…[truncated]");
}

pub fn truncated(s: &str, max: usize) -> String {
    let mut out = s.to_owned();
    truncate_in_place(&mut out, max);
    out
}

/// Final form of one JSON log line: redacted, bounded, tagged with the process id. Applied to
/// every line before it is queued.
pub fn sanitize_line(line: &str, pid: u32, home: Option<&str>, vault_roots: &[String]) -> String {
    let mut text = redact_with(line.trim_end(), home, vault_roots);
    if text.len() > MAX_LINE_BYTES {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
            for max in [4000, 1000, 200] {
                truncate_strings(&mut v, max);
                let again = v.to_string();
                if again.len() <= MAX_LINE_BYTES {
                    text = again;
                    break;
                }
            }
        }
        if text.len() > MAX_LINE_BYTES {
            // Not JSON (or still huge): keep a valid JSON line anyway.
            text = serde_json::json!({
                "level": "ERROR",
                "fields": {"message": truncated(&text, 4000)},
                "target": "logging"
            })
            .to_string();
        }
    }
    match text.strip_prefix('{') {
        Some(rest) if rest.starts_with('}') => format!("{{\"pid\":{pid}}}\n"),
        Some(rest) => format!("{{\"pid\":{pid},{rest}\n"),
        None => format!("{text}\n"),
    }
}

// ---------- Writer ----------

/// Runs on the worker thread, in front of the file: every queued line is redacted, bounded and
/// tagged with the process id before it reaches the disk. The calling thread only formats the
/// event and queues it, so redaction cost never lands on the UI.
struct SanitizingWriter<W: Write> {
    inner: W,
    pid: u32,
}

impl<W: Write> Write for SanitizingWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(data);
        let roots = VAULT_ROOTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let line = sanitize_line(&text, self.pid, home().as_deref(), &roots);
        self.inner.write_all(line.as_bytes())?;
        // The live feeds of a settings page get the very line the file got: a counter check
        // when nobody watches, else a target compare and a non-blocking send each.
        tail::hub().publish(&line, std::time::Instant::now());
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// One log event per `LineSink`: the fmt layer writes an event and drops the writer, which
/// queues the whole line as one message on the non-blocking worker.
#[derive(Clone)]
struct SinkMaker {
    inner: NonBlocking,
}

struct LineSink {
    buf: Vec<u8>,
    inner: NonBlocking,
}

impl LineSink {
    fn emit(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        // Lossy queue: a full queue drops the line, it never blocks the caller.
        let _ = self.inner.write_all(&self.buf);
        self.buf.clear();
    }
}

impl Write for LineSink {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.emit();
        Ok(())
    }
}

impl Drop for LineSink {
    fn drop(&mut self) {
        self.emit();
    }
}

impl<'a> MakeWriter<'a> for SinkMaker {
    type Writer = LineSink;
    fn make_writer(&'a self) -> LineSink {
        LineSink {
            buf: Vec::with_capacity(256),
            inner: self.inner.clone(),
        }
    }
}

// ---------- Subscriber ----------

pub struct Built {
    pub dispatch: tracing::Dispatch,
    pub guard: WorkerGuard,
    set_level: LevelSetter,
}

impl Built {
    pub fn set_level(&self, level: LevelFilter) {
        (self.set_level)(level);
    }
}

/// Builds (without installing) a subscriber that writes `<prefix>.<date>.log` into `dir`.
pub fn build(dir: &Path, prefix: &str, level: LevelFilter) -> io::Result<Built> {
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)
        .map_err(|e| io::Error::other(e.to_string()))?;
    let (writer, guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(QUEUE_LINES)
        .lossy(true)
        .thread_name("writer-log")
        .finish(SanitizingWriter {
            inner: appender,
            pid: std::process::id(),
        });
    let (filter, handle) = reload::Layer::<LevelFilter, Registry>::new(level);
    let fmt = tracing_subscriber::fmt::layer()
        .json()
        .with_ansi(false)
        .with_writer(SinkMaker { inner: writer });
    let subscriber = Registry::default().with(filter).with(fmt);
    Ok(Built {
        dispatch: tracing::Dispatch::new(subscriber),
        guard,
        set_level: Box::new(move |l| {
            let _ = handle.modify(|f| *f = l);
        }),
    })
}

/// The one `log` logger of the test process (`log` accepts a single logger for the whole process,
/// and tests that each installed their own made the others lose their records): every record goes
/// to the tracing dispatcher of the calling thread (what `LogTracer` does, so a test can scope a
/// subscriber with `with_default`) and is kept for [`test_records`].
#[cfg(test)]
static TEST_RECORDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) fn test_logger() {
    struct Shared;
    impl log::Log for Shared {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, r: &log::Record<'_>) {
            TEST_RECORDS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("{}", r.args()));
            let _ = tracing_log::format_trace(r);
        }
        fn flush(&self) {}
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = log::set_logger(&Shared);
        log::set_max_level(log::LevelFilter::Trace);
    });
}

/// Every `log` record of the test process so far (see [`test_logger`]).
#[cfg(test)]
pub(crate) fn test_records() -> Vec<String> {
    test_logger();
    TEST_RECORDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

// ---------- Global install ----------

static GUARD: Mutex<Option<WorkerGuard>> = Mutex::new(None);
static INSTALLED: AtomicBool = AtomicBool::new(false);

fn install(prefix: &str, panic_hook: bool) -> Option<PathBuf> {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return None;
    }
    let env = std::env::var(ENV_VAR).ok();
    ENV_OVERRIDE.store(
        env.as_deref()
            .is_some_and(|e| e.trim().to_ascii_lowercase().parse::<LevelFilter>().is_ok()),
        Ordering::Relaxed,
    );
    let level = resolve_level(env.as_deref(), None);
    let Some(dir) = log_dir() else {
        eprintln!("logging: no log directory for this OS; file logs are off");
        return None;
    };
    let built = match std::fs::create_dir_all(&dir).and_then(|_| build(&dir, prefix, level)) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("logging: cannot write logs to {}: {e}", dir.display());
            return None;
        }
    };
    if tracing::dispatcher::set_global_default(built.dispatch.clone()).is_err() {
        return None;
    }
    // `log` macros (this crate, tauri, plugins) flow into the same subscriber.
    let _ = tracing_log::LogTracer::init();
    let Built {
        guard, set_level, ..
    } = built;
    let _ = LEVEL_SETTER.set(set_level);
    *GUARD.lock().unwrap_or_else(|e| e.into_inner()) = Some(guard);
    if panic_hook {
        install_panic_hook();
    }
    Some(dir)
}

/// App startup: call first thing in `run()`.
pub fn init_app() {
    if let Some(dir) = install(APP_PREFIX, true) {
        tracing::info!(
            target: "app",
            version = env!("CARGO_PKG_VERSION"),
            dir = %dir.display(),
            "writer started"
        );
        mark_running(&dir);
    }
}

const RUNNING_FILE: &str = "writer.running";

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Crash detector: a `writer.running` file holds the pid while the app runs and is removed on a
/// clean exit. Finding one whose process is gone means the last run ended without going through
/// exit (native crash, SIGKILL, power loss, force quit) and no panic line explains it.
fn mark_running(dir: &Path) {
    let file = dir.join(RUNNING_FILE);
    if let Some(prev) = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| t.trim().parse::<u32>().ok())
    {
        if prev != std::process::id() && !pid_alive(prev) {
            tracing::warn!(
                target: "app",
                previous_pid = prev,
                "previous run did not exit cleanly (crash, force quit, kill or power loss; a panic would be logged separately)"
            );
        }
    }
    let _ = std::fs::write(&file, std::process::id().to_string());
}

/// Records why the app is going away. Call from the run loop (`stage` is `exit-requested` or
/// `exit`); the final stage also removes the crash-detector file.
pub fn log_exit(stage: &str, code: Option<i32>) {
    match code {
        Some(c) => tracing::info!(target: "app", stage, code = c, "writer exiting"),
        None => tracing::info!(target: "app", stage, "writer exiting"),
    }
    if stage == "exit" {
        if let Some(dir) = log_dir() {
            let _ = std::fs::remove_file(dir.join(RUNNING_FILE));
        }
    }
}

/// `writer` CLI: same directory and retention, `cli.<date>.log`. Call [`shutdown`] before exit.
pub fn init_cli() {
    install(CLI_PREFIX, true);
}

/// Flushes and stops the writer thread (process exit).
pub fn shutdown() {
    let guard = GUARD.lock().unwrap_or_else(|e| e.into_inner()).take();
    drop(guard);
}

// ---------- Panics ----------

pub fn describe_panic(payload: &dyn std::any::Any) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = describe_panic(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let thread = std::thread::current();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        tracing::error!(
            target: "panic",
            thread = thread.name().unwrap_or("<unnamed>"),
            location = %location,
            backtrace = %truncated(&backtrace, 8000),
            "panic: {}",
            truncated(&message, 2000)
        );
        // `panic = "abort"` (release) ends the process right after this hook: flush first.
        #[cfg(panic = "abort")]
        shutdown();
        previous(info);
    }));
}

// ---------- Reading recent errors ----------

fn log_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.ends_with(".log") && (name.starts_with("writer.") || name.starts_with("cli."))
        })
        .collect();
    files.sort();
    files
}

/// One readable line for an error or warn JSON log line; `None` for other levels or junk.
pub fn render_error_line(json_line: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json_line).ok()?;
    let level = v.get("level")?.as_str()?;
    if level != "ERROR" && level != "WARN" {
        return None;
    }
    let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
    let fields = v.get("fields").and_then(|f| f.as_object());
    let get = |k: &str| fields.and_then(|f| f.get(k)).and_then(|x| x.as_str());
    let mut line = format!(
        "{ts} {level} {} {}",
        v.get("target").and_then(|t| t.as_str()).unwrap_or(""),
        get("message").unwrap_or("")
    );
    for key in [
        "source", "window", "plugin", "phase", "version", "command", "location",
    ] {
        if let Some(val) = get(key) {
            line.push_str(&format!(" {key}={val}"));
        }
    }
    for key in ["stack", "backtrace"] {
        if let Some(val) = get(key) {
            line.push_str(&format!(
                " {key}={}",
                truncated(&val.replace('\n', " | "), 800)
            ));
        }
    }
    Some((ts.to_owned(), line.replace('\n', " | ")))
}

/// The newest `limit` error/warn lines from the files in `dir` (app and CLI merged by
/// timestamp), redacted again on the way out.
pub fn recent_errors(dir: &Path, limit: usize) -> Vec<String> {
    const TAIL_BYTES: u64 = 2 * 1024 * 1024;
    let mut found: Vec<(String, String)> = Vec::new();
    for file in log_files(dir) {
        let Ok(mut f) = std::fs::File::open(&file) else {
            continue;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut text = String::new();
        {
            use std::io::{Read, Seek, SeekFrom};
            if len > TAIL_BYTES {
                let _ = f.seek(SeekFrom::Start(len - TAIL_BYTES));
            }
            let mut bytes = Vec::new();
            let _ = f.read_to_end(&mut bytes);
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
        found.extend(text.lines().filter_map(render_error_line));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let skip = found.len().saturating_sub(limit);
    found
        .into_iter()
        .skip(skip)
        .map(|(_, l)| redact(&l))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Waits for the worker thread to have written `n` lines (it runs behind a queue).
    fn wait_lines(dir: &Path, n: usize) -> Vec<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let lines = read_all(dir);
            if lines.len() >= n || std::time::Instant::now() > deadline {
                return lines;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    fn read_all(dir: &Path) -> Vec<String> {
        let mut lines = Vec::new();
        for f in log_files(dir) {
            lines.extend(
                std::fs::read_to_string(f)
                    .unwrap()
                    .lines()
                    .map(str::to_owned),
            );
        }
        lines
    }

    fn red(s: &str) -> String {
        redact_with(
            s,
            Some("/Users/ann"),
            &["/Users/ann/Notes/Vault".to_owned()],
        )
    }

    #[test]
    fn redacts_paths() {
        assert_eq!(red("open /Users/ann/Notes/Vault/a.md"), "open <vault>/a.md");
        assert_eq!(red("cfg /Users/ann/.config/x"), "cfg ~/.config/x");
        assert_eq!(red("/Users/annabel/x"), "~/x");
        assert_eq!(red("/home/bob/x"), "~/x");
    }

    #[test]
    fn redacts_secrets() {
        for (input, leaked) in [
            ("key sk-ant-api03-abcdefghijkl", "abcdefghijkl"),
            ("Authorization: Bearer abc123def456", "abc123def456"),
            ("authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            ("sent Bearer eyJhbGciOi.payload.sig", "eyJhbGciOi"),
            ("api_key=hunter2hunter2 next", "hunter2"),
            ("ANTHROPIC_API_KEY=sk-live-zzzzzzzz1234", "zzzzzzzz"),
            (r#"{"password":"p4ssw0rd!"}"#, "p4ssw0rd"),
            (r#"\"token\":\"abcdef123456\""#, "abcdef123456"),
            ("GET https://x.test/path?code=abc&state=def ok", "code=abc"),
            ("https://user:pw123@host.test/a", "pw123"),
            ("token ghp_abcdefghijklmnopqrstuv", "abcdefghijkl"),
        ] {
            let out = red(input);
            assert!(!out.contains(leaked), "{input} -> {out}");
            assert!(out.contains("redacted"), "{input} -> {out}");
        }
    }

    #[test]
    fn keeps_harmless_text_and_url_path() {
        let out = red("fetched https://api.test/v1/models ok in 20ms");
        assert_eq!(out, "fetched https://api.test/v1/models ok in 20ms");
    }

    #[test]
    fn running_marker_holds_our_pid_and_stale_pid_is_not_alive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(RUNNING_FILE), "999999999").unwrap();
        assert!(!pid_alive(999_999_999));
        assert!(pid_alive(std::process::id()));
        mark_running(tmp.path());
        let text = std::fs::read_to_string(tmp.path().join(RUNNING_FILE)).unwrap();
        assert_eq!(text, std::process::id().to_string());
    }

    #[test]
    fn sanitize_adds_pid_and_keeps_json_valid() {
        let line = r#"{"level":"WARN","fields":{"message":"x /Users/ann/a"}}"#;
        let out = sanitize_line(line, 42, Some("/Users/ann"), &[]);
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(v["pid"], 42);
        assert_eq!(v["fields"]["message"], "x ~/a");
    }

    #[test]
    fn sanitize_truncates_long_lines_to_valid_json() {
        let big = "x".repeat(100_000);
        let line = format!(r#"{{"level":"ERROR","fields":{{"message":"{big}"}}}}"#);
        let out = sanitize_line(&line, 1, None, &[]);
        assert!(out.len() <= MAX_LINE_BYTES + 64);
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert!(v["fields"]["message"]
            .as_str()
            .unwrap()
            .ends_with("[truncated]"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let mut s = "é".repeat(50);
        truncate_in_place(&mut s, 11);
        assert!(s.starts_with("ééééé"));
    }

    #[test]
    fn level_resolution_order() {
        assert_eq!(resolve_level(None, None), LevelFilter::INFO);
        assert_eq!(resolve_level(None, Some("debug")), LevelFilter::DEBUG);
        assert_eq!(
            resolve_level(Some("error"), Some("debug")),
            LevelFilter::ERROR
        );
        assert_eq!(
            resolve_level(Some("nonsense"), Some("info")),
            LevelFilter::INFO
        );
        assert_eq!(resolve_level(Some(" DEBUG "), None), LevelFilter::DEBUG);
    }

    #[test]
    fn log_dir_uses_the_identifier() {
        let dir = log_dir_for("com.writer-computer").unwrap();
        assert!(dir.to_string_lossy().contains("com.writer-computer"));
        assert_eq!(identifier(), "com.writer-computer");
        #[cfg(target_os = "macos")]
        assert!(dir
            .to_string_lossy()
            .contains("Library/Logs/com.writer-computer"));
    }

    #[test]
    fn writes_json_lines_with_level_filter_pid_and_redaction() {
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            tracing::info!("hidden at warn");
            tracing::warn!(
                plugin = "p1",
                "bad Authorization: Bearer abcdef123456 at /Users/x/y"
            );
            tracing::error!(target: "frontend", "boom");
        });
        drop(built);
        let lines = read_all(tmp.path());
        assert_eq!(lines.len(), 2, "{lines:?}");
        let first: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(first["pid"], std::process::id());
        assert_eq!(first["level"], "WARN");
        assert_eq!(first["fields"]["plugin"], "p1");
        let msg = first["fields"]["message"].as_str().unwrap();
        assert!(
            !msg.contains("abcdef123456") && !msg.contains("/Users/x"),
            "{msg}"
        );
        let ts = first["timestamp"].as_str().unwrap();
        assert!(ts.ends_with('Z') && ts.contains('T'), "{ts}");
        assert!(lines[1].contains(r#""target":"frontend""#));
    }

    #[test]
    fn level_can_be_raised_at_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            tracing::debug!("d1");
            built.set_level(LevelFilter::DEBUG);
            tracing::debug!("d2");
        });
        let Built { guard, .. } = built;
        drop(guard);
        let lines = read_all(tmp.path()).join("\n");
        assert!(!lines.contains("d1") && lines.contains("d2"), "{lines}");
    }

    #[test]
    fn file_name_is_prefix_date_log() {
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "cli", LevelFilter::WARN).unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || tracing::error!("x"));
        drop(built);
        let name = log_files(tmp.path())[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let re = regex_lite::Regex::new(r"^cli\.\d{4}-\d{2}-\d{2}\.log$").unwrap();
        assert!(re.is_match(&name), "{name}");
    }

    #[test]
    fn retention_keeps_at_most_three_files_per_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        for day in 1..=6 {
            std::fs::write(
                tmp.path().join(format!("writer.2026-01-0{day}.log")),
                "{}\n",
            )
            .unwrap();
            std::fs::write(tmp.path().join(format!("cli.2026-01-0{day}.log")), "{}\n").unwrap();
        }
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        let built_cli = build(tmp.path(), "cli", LevelFilter::WARN).unwrap();
        drop((built, built_cli));
        let names: Vec<String> = log_files(tmp.path())
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        let app = names.iter().filter(|n| n.starts_with("writer.")).count();
        let cli = names.iter().filter(|n| n.starts_with("cli.")).count();
        assert!(app <= MAX_LOG_FILES && cli <= MAX_LOG_FILES, "{names:?}");
        assert!(names.contains(&"writer.2026-01-06.log".to_owned()) || app == MAX_LOG_FILES);
        assert!(
            !names.contains(&"writer.2026-01-01.log".to_owned()),
            "{names:?}"
        );
    }

    #[test]
    fn concurrent_writers_produce_whole_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        let dispatch = Arc::new(built.dispatch.clone());
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let d = Arc::clone(&dispatch);
                std::thread::spawn(move || {
                    tracing::dispatcher::with_default(&d, || {
                        for i in 0..250 {
                            tracing::warn!(thread = t, i, "line {t}-{i}");
                        }
                    });
                })
            })
            .collect();
        handles.into_iter().for_each(|h| h.join().unwrap());
        drop(dispatch);
        let lines = wait_lines(tmp.path(), 2000);
        drop(built);
        assert_eq!(lines.len(), 2000);
        for l in &lines {
            serde_json::from_str::<serde_json::Value>(l).expect("each line is whole JSON");
        }
    }

    #[test]
    fn logging_never_blocks_the_caller() {
        // Point the appender at a directory that disappears: writes fail on the worker thread,
        // the calling thread keeps going.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("gone");
        std::fs::create_dir_all(&dir).unwrap();
        let built = build(&dir, "writer", LevelFilter::WARN).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let start = std::time::Instant::now();
        tracing::dispatcher::with_default(&built.dispatch, || {
            for i in 0..50_000 {
                tracing::warn!("flood {i}");
            }
        });
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "50k events took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn recent_errors_merges_files_and_skips_info() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("writer.2026-11-15.log"),
            concat!(
                r#"{"timestamp":"2026-11-15T10:00:00Z","level":"ERROR","fields":{"message":"old"},"target":"a"}"#, "\n",
                r#"{"timestamp":"2026-11-15T10:00:01Z","level":"INFO","fields":{"message":"skip"},"target":"a"}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("cli.2026-11-16.log"),
            concat!(
                r#"{"timestamp":"2026-11-16T09:00:00Z","level":"WARN","fields":{"message":"cli bad","plugin":"p","stack":"a\nb"},"target":"cli"}"#, "\n",
                "not json\n",
            ),
        )
        .unwrap();
        let lines = recent_errors(tmp.path(), 200);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("old") && lines[1].contains("cli bad plugin=p"));
        assert!(lines[1].contains("a | b"));
        assert_eq!(recent_errors(tmp.path(), 1).len(), 1);
    }

    #[test]
    fn log_crate_records_reach_the_same_file_with_the_same_filter() {
        test_logger();
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            log::debug!("log debug hidden");
            log::warn!(target: "plugin_proc", "log warn via /Users/zed/x api_key=abc12345");
        });
        let lines = wait_lines(tmp.path(), 1);
        drop(built);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("log warn via ~/x"), "{}", lines[0]);
        assert!(!lines[0].contains("abc12345"));
        assert!(lines[0].contains("plugin_proc"));
    }

    #[test]
    fn describes_panic_payloads() {
        assert_eq!(describe_panic(&"boom"), "boom");
        assert_eq!(describe_panic(&String::from("bang")), "bang");
        assert_eq!(describe_panic(&5_u8), "non-string panic payload");
    }

    #[test]
    fn panic_events_carry_message_and_location() {
        let tmp = tempfile::tempdir().unwrap();
        let built = build(tmp.path(), "writer", LevelFilter::WARN).unwrap();
        tracing::dispatcher::with_default(&built.dispatch, || {
            tracing::error!(target: "panic", location = "a.rs:1", backtrace = "frames", "panic: oops");
        });
        drop(built);
        let lines = read_all(tmp.path());
        assert!(lines[0].contains("panic: oops") && lines[0].contains("a.rs:1"));
    }
}
