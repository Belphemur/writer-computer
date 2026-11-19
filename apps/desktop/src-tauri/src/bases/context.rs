//! Injected dependencies of the interpreter: a clock and the per-row data
//! access trait. Everything the evaluator knows about the outside world goes
//! through these two seams, so the engine is deterministic and testable.

use super::value::{LinkValue, Value};
use std::rc::Rc;

/// Source of "now". Injected so tests and probes are deterministic.
pub trait Clock {
    /// Milliseconds since the Unix epoch (UTC).
    fn now_utc_ms(&self) -> i64;
    /// Local UTC offset in minutes (east positive), at `now`. Dates are
    /// time-zone-less; the offset is only used to place `now()` on the local
    /// wall clock and to convert strings that carry an explicit offset.
    fn utc_offset_minutes(&self) -> i32;

    fn now_local_ms(&self) -> i64 {
        self.now_utc_ms() + self.utc_offset_minutes() as i64 * 60_000
    }
}

/// A clock frozen at one instant.
#[derive(Clone, Copy, Debug)]
pub struct FixedClock {
    pub utc_ms: i64,
    pub offset_minutes: i32,
}

impl FixedClock {
    /// Convenience for tests: a local wall-clock string such as
    /// `"2024-03-15T10:30:00"` at offset 0.
    pub fn at(local: &str) -> FixedClock {
        let (ms, _) = super::datetime::parse_date(local, 0).unwrap_or((0, false));
        FixedClock {
            utc_ms: ms,
            offset_minutes: 0,
        }
    }
}

impl Clock for FixedClock {
    fn now_utc_ms(&self) -> i64 {
        self.utc_ms
    }
    fn utc_offset_minutes(&self) -> i32 {
        self.offset_minutes
    }
}

/// The wall clock. `std` cannot tell the local zone, so the caller supplies
/// the offset (the app knows it from the webview, the CLI from the OS).
#[derive(Clone, Copy, Debug)]
pub struct SystemClock {
    pub offset_minutes: i32,
}

impl Clock for SystemClock {
    fn now_utc_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
    fn utc_offset_minutes(&self) -> i32 {
        self.offset_minutes
    }
}

/// Size and timestamps of a file (`file.size`, `file.ctime`, `file.mtime`).
/// Timestamps are local-naive milliseconds, like every date in the engine.
#[derive(Clone, Copy, Debug, Default)]
pub struct FileMeta {
    pub size: u64,
    pub ctime_ms: i64,
    pub mtime_ms: i64,
}

/// Everything the evaluator may ask about one file ("row").
///
/// Implementations wrap the vault index (app/CLI) or an in-memory fixture
/// (tests). Methods are cheap lookups; the evaluator calls them lazily, so an
/// implementation may fetch tags/links/backlinks on demand and cache them.
pub trait RowContext {
    /// Vault-relative path with forward slashes, e.g. `Projects/Plan.md`.
    fn path(&self) -> String;

    fn meta(&self) -> FileMeta;

    /// Frontmatter properties in file order. Values should already carry the
    /// property's type (dates as `Value::Date`, ...); see
    /// [`Value::from_json`](super::value::Value::from_json).
    fn properties(&self) -> Vec<(String, Value)>;

    /// One frontmatter property by exact key.
    fn property(&self, key: &str) -> Option<Value> {
        self.properties()
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `file.tags`: tags of the file (content and frontmatter), without the
    /// leading `#`, nested tags as written (`a/b`).
    fn tags(&self) -> Vec<String>;

    /// `file.links`: outgoing links (content and frontmatter). The
    /// implementation fills `resolved` when the target exists.
    fn links(&self) -> Vec<LinkValue>;

    /// `file.embeds`.
    fn embeds(&self) -> Vec<LinkValue>;

    /// `file.backlinks`: paths of files that link to this one.
    fn backlinks(&self) -> Vec<String>;

    /// Resolve link text (`Note`, `Folder/Note`, `Note.md`; no brackets, no
    /// `#heading`, no `|alias`) as written in this file to a vault path.
    fn resolve_link(&self, text: &str) -> Option<String>;

    /// Row context of another file by vault path, for linked-note lookups
    /// (`link.asFile().properties`, `file("x").hasTag(..)`).
    fn context_for_path(&self, path: &str) -> Option<Rc<dyn RowContext>>;

    /// Dataview inline fields (`key:: value`) as `(key, value)` pairs, the raw key and its
    /// canonical form both present. Only the DQL dialect reads them (Bases results never see
    /// them); a source without inline fields keeps the empty default.
    fn inline_fields(&self) -> Vec<(String, Value)> {
        Vec::new()
    }

    /// The file's list items as objects (`text`, `line`, `task`, `status`, `completed`, ...):
    /// `file.lists` and `file.tasks` of the DQL dialect.
    fn list_items(&self) -> Vec<Value> {
        Vec::new()
    }
}

/// `name` of `a/b/c.md` is `c.md`.
pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `basename` of `a/b/c.md` is `c`; of `.hidden` it is `.hidden`.
pub fn file_basename(path: &str) -> &str {
    let name = file_name(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

/// `ext` of `a/b/c.md` is `md`, of `a/b/c` is `` (no dot).
pub fn file_ext(path: &str) -> &str {
    let name = file_name(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i + 1..],
        _ => "",
    }
}

/// `folder` of `a/b/c.md` is `a/b`; of a root file it is `` (empty).
pub fn file_folder(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_parts() {
        assert_eq!(file_name("a/b/c.md"), "c.md");
        assert_eq!(file_basename("a/b/c.md"), "c");
        assert_eq!(file_ext("a/b/c.md"), "md");
        assert_eq!(file_folder("a/b/c.md"), "a/b");
        assert_eq!(file_folder("c.md"), "");
        assert_eq!(file_ext("noext"), "");
        assert_eq!(file_basename("x/archive.tar.gz"), "archive.tar");
        assert_eq!(file_basename(".hidden"), ".hidden");
    }
}
