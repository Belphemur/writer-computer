//! Schema v2 (v1 + the `notes_fts` full-text table), open-or-rebuild.

use super::IndexError;
use rusqlite::{Connection, OpenFlags};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: &str = "2";
/// Bump whenever the parsing output changes (tag rules, link rules, property
/// typing, counts) so stale rows are rebuilt instead of trusted.
pub const PARSER_VERSION: &str = "1";

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
CREATE TABLE links(
  src_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw TEXT NOT NULL, target_path TEXT, kind TEXT NOT NULL, in_fm INTEGER NOT NULL,
  display TEXT, subpath TEXT
);
CREATE INDEX links_src ON links(src_id);
CREATE INDEX links_target ON links(target_path);
CREATE TABLE tasks(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX tasks_file ON tasks(file_id);
CREATE TABLE headings(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL
);
CREATE INDEX headings_file ON headings(file_id);
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
    if version.as_deref() != Some(SCHEMA_VERSION) {
        return Ok(Some(format!(
            "schema version {version:?} != {SCHEMA_VERSION}"
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
    conn.execute_batch(super::fts::FTS_DDL)?;
    set_meta(&conn, "schema_version", SCHEMA_VERSION)?;
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
