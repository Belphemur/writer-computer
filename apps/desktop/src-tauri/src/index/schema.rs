//! Schema v6 (`edges`, the note-graph table; `inline_fields`; `list_items` and the extended
//! `tasks`), open-or-rebuild.

use super::IndexError;
use rusqlite::{Connection, OpenFlags};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

/// The core schema's version. The version stored in `meta` and compared on open is
/// [`schema_version`]: this plus the suffix for the DDL features contribute.
pub const SCHEMA_VERSION: &str = "6";

/// Core version plus `features::index_schema_suffix` (empty while no feature adds DDL), so a
/// feature adding or changing a table rebuilds the rebuildable cache from its own folder.
pub fn schema_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| format!("{SCHEMA_VERSION}{}", crate::features::index_schema_suffix()))
}
/// Bump whenever the parsing output changes (tag rules, link rules, property
/// typing, counts) so stale rows are rebuilt instead of trusted.
pub const PARSER_VERSION: &str = "5";

const SCHEMA: &str = "
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE files(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, basename TEXT NOT NULL, ext TEXT NOT NULL, folder TEXT NOT NULL,
  size INTEGER NOT NULL, ctime INTEGER NOT NULL, mtime INTEGER NOT NULL,
  fm_json TEXT, fm_error TEXT, body_hash INTEGER,
  words INTEGER, chars INTEGER
);
CREATE INDEX files_folder ON files(folder);
CREATE INDEX files_ext ON files(ext);
CREATE INDEX files_base ON files(basename COLLATE NOCASE);
CREATE TABLE props(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  key TEXT NOT NULL, vtype TEXT NOT NULL,
  v_text TEXT, v_num REAL, v_date INTEGER,
  PRIMARY KEY(file_id, key)
);
CREATE INDEX props_text ON props(key, v_text);
CREATE INDEX props_num ON props(key, v_num);
CREATE INDEX props_date ON props(key, v_date);
CREATE TABLE prop_items(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  key TEXT NOT NULL, idx INTEGER NOT NULL, vtype TEXT NOT NULL,
  v_text TEXT, link_target TEXT
);
CREATE INDEX prop_items_file ON prop_items(file_id);
CREATE INDEX prop_items_kv ON prop_items(key, v_text);
CREATE TABLE tags(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, source TEXT NOT NULL,
  UNIQUE(file_id, tag, source)
);
CREATE INDEX tags_tag ON tags(tag);
-- The note graph (SPECs/note-graph-spec.md 4.2): one row per link occurrence. `dst_id` NULL is
-- unresolved. `dst_key` is `resolve::bucket_key` of the target, so a change to the set of vault
-- files can find the edges it affects. STRICT (new table, SQLite 3.37+, bundled 3.54).
CREATE TABLE edges(
  id INTEGER PRIMARY KEY,
  src_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dst_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  dst_key TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  syntax TEXT NOT NULL,
  label TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL,
  line INTEGER,
  section TEXT,
  display TEXT,
  subpath TEXT
) STRICT;
-- Every list item with its parent (SPECs/tasks-spec.md 4.1): nesting for the task rows and the
-- Dataview queries. `parent_line` is the line of the enclosing item in the same file.
CREATE TABLE list_items(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL, parent_line INTEGER, indent INTEGER NOT NULL, marker TEXT NOT NULL,
  task_status TEXT, text TEXT NOT NULL, section_heading TEXT
);
CREATE INDEX list_items_file ON list_items(file_id, line);
-- A task is a list item with a checkbox (`task_status` set), parsed by `tasks::grammar`. Dates are
-- `YYYY-MM-DD` text, `priority` is `highest..lowest` (NULL = none), `tags` and `depends_on` are
-- comma-joined. The status *type* is not stored: it depends on the vault's custom statuses, which
-- are read when the rows are (Bases `task.status`).
CREATE TABLE tasks(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL, status_symbol TEXT NOT NULL, text TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due TEXT, scheduled TEXT, start TEXT, created TEXT, done TEXT, cancelled TEXT,
  priority TEXT, recurrence TEXT, on_completion TEXT, task_id TEXT, depends_on TEXT,
  tags TEXT, block_id TEXT, parent_line INTEGER
);
CREATE INDEX tasks_file ON tasks(file_id);
CREATE INDEX tasks_due ON tasks(due) WHERE due IS NOT NULL;
CREATE TABLE headings(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL
);
CREATE INDEX headings_file ON headings(file_id);
-- Dataview inline fields (SPECs/dataview-spec.md, scanner in `inline_fields.rs`): one row per
-- field occurrence; `raw` is the value text, parsed on read. `wrapping` is `[`, `(` or NULL
-- (a whole-line field).
CREATE TABLE inline_fields(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL, key TEXT NOT NULL, canonical_key TEXT NOT NULL,
  raw TEXT NOT NULL, wrapping TEXT
);
CREATE INDEX inline_fields_file ON inline_fields(file_id);
CREATE INDEX inline_fields_key ON inline_fields(canonical_key);
";

/// The `edges` indexes: out-neighbours, backlinks (partial: resolved only), re-resolution by
/// target name, and relationships by property name. Kept apart from [`SCHEMA`] because a cold
/// build drops them for the bulk load and recreates them once (much cheaper than maintaining
/// them per row); `IF NOT EXISTS` makes the creation safe to repeat.
pub(crate) const EDGE_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id, dst_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id, src_id) WHERE dst_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS edges_key ON edges(dst_key);
CREATE INDEX IF NOT EXISTS edges_label ON edges(label, src_id) WHERE label IS NOT NULL;
";
pub(crate) const DROP_EDGE_INDEXES: &str = "
DROP INDEX IF EXISTS edges_src;
DROP INDEX IF EXISTS edges_dst;
DROP INDEX IF EXISTS edges_key;
DROP INDEX IF EXISTS edges_label;
";

pub struct Opened {
    pub conn: Connection,
    /// Why an existing database was discarded, if it was.
    pub rebuilt_reason: Option<String>,
}

fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// `Ok(None)` when the existing database is usable, `Ok(Some(reason))` when it
/// must be rebuilt.
fn check_existing(conn: &Connection, root: &str) -> rusqlite::Result<Option<String>> {
    let check: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
    if check != "ok" {
        return Ok(Some(format!("integrity check failed: {check}")));
    }
    let version = meta(conn, "schema_version")?;
    if version.as_deref() != Some(schema_version()) {
        return Ok(Some(format!(
            "schema version {version:?} != {}",
            schema_version()
        )));
    }
    let parser = meta(conn, "parser_version")?;
    if parser.as_deref() != Some(PARSER_VERSION) {
        return Ok(Some(format!(
            "parser version {parser:?} != {PARSER_VERSION}"
        )));
    }
    let stored_root = meta(conn, "workspace_root")?;
    if stored_root.as_deref() != Some(root) {
        return Ok(Some("workspace root mismatch".to_string()));
    }
    Ok(None)
}

fn remove_db_files(db_path: &Path) -> Result<(), IndexError> {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_owned();
        p.push(suffix);
        match std::fs::remove_file(PathBuf::from(p)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn create_fresh(db_path: &Path, root: &str) -> Result<Connection, IndexError> {
    let conn = Connection::open(db_path)?;
    apply_pragmas(&conn)?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(EDGE_INDEXES)?;
    conn.execute_batch(super::fts::FTS_DDL)?;
    for ddl in crate::features::index_ddl() {
        conn.execute_batch(ddl)?;
    }
    set_meta(&conn, "schema_version", schema_version())?;
    set_meta(&conn, "parser_version", PARSER_VERSION)?;
    set_meta(&conn, "workspace_root", root)?;
    Ok(conn)
}

/// Open the index database for `root`, creating it or discarding and
/// recreating it on schema/parser version mismatch, workspace mismatch or
/// corruption. Concurrent openers (app and CLI) are serialised by an advisory
/// lock on `<db>.lock` for the duration of this call.
pub fn open_or_rebuild(db_path: &Path, root: &str) -> Result<Opened, IndexError> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut lock_path = db_path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(PathBuf::from(lock_path))?;
    // Another Writer process (app or CLI) holds the lock only while opening;
    // waiting longer than this means something is wrong: fail explicitly.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(IndexError::Invalid(format!(
                        "the index database {} is locked by another Writer process; try again",
                        db_path.display()
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
    }
    let result = open_locked(db_path, root);
    let _ = lock.unlock();
    result
}

fn open_locked(db_path: &Path, root: &str) -> Result<Opened, IndexError> {
    if !db_path.exists() {
        remove_db_files(db_path)?; // stale -wal/-shm without a main file
        return Ok(Opened {
            conn: create_fresh(db_path, root)?,
            rebuilt_reason: None,
        });
    }
    let reason = match Connection::open(db_path).and_then(|conn| {
        apply_pragmas(&conn)?;
        match check_existing(&conn, root)? {
            None => Ok(Ok(conn)),
            Some(reason) => Ok(Err(reason)),
        }
    }) {
        Ok(Ok(conn)) => {
            return Ok(Opened {
                conn,
                rebuilt_reason: None,
            })
        }
        Ok(Err(reason)) => reason,
        Err(e) => format!("unreadable database: {e}"),
    };
    log::warn!("rebuilding vault index {}: {reason}", db_path.display());
    remove_db_files(db_path)?;
    Ok(Opened {
        conn: create_fresh(db_path, root)?,
        rebuilt_reason: Some(reason),
    })
}

pub fn open_reader(db_path: &Path) -> Result<Connection, IndexError> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(conn)
}
