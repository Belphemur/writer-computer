//! Vault index: a SQLite cache of file metadata, frontmatter properties, tags,
//! links, headings and tasks (Obsidian Bases spec, section 4.1).
//!
//! This module is deliberately free of `tauri::` types so the Tauri app
//! (`commands/index.rs`) and the standalone `writer` CLI share one
//! implementation. The database lives in the app data directory, never in the
//! vault; nothing is ever written to the vault or to `.obsidian`.
//!
//! Concurrency: one writer thread owns the only write connection and executes
//! jobs from a queue (scan, re-index paths). Queries use a small pool of
//! read-only WAL connections and never wait for the writer. The index is a
//! cache: deleting the database file is always safe.

pub mod bases_source;
mod build;
pub(crate) mod frontmatter;
pub mod fts;
pub(crate) mod markdown;
pub mod names;
mod note;
pub mod patch;
pub mod paths;
mod query;
pub mod rank;
pub(crate) mod resolve;
mod schema;
mod search;
mod search_query;
mod yaml;

#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod tests;

/// Notes shared by the nested-tag tests of the index, search, CLI and Bases
/// (one fixture, so the rule is checked the same way everywhere): `research`
/// must match the first three notes, `research/hlo` the first two,
/// `research/hlo/docs` the first, and nothing but `researcher` matches the
/// last (a whole-segment prefix, never a substring). Every note
/// contains the word `nested` (Search needs a term next to a `tag:` filter).
#[cfg(test)]
pub(crate) const NESTED_TAG_NOTES: &[(&str, &str)] = &[
    ("Tags/Deep.md", "# Deep\nnested #research/hlo/docs\n"),
    ("Tags/Mid.md", "---\ntags: [Research/HLO]\n---\nnested\n"),
    ("Tags/Top.md", "nested #Research\n"),
    ("Tags/Other.md", "nested #researcher\n"),
];

pub use build::ScanStats;
pub use fts::{fts_size_bytes, FtsMaintenance, FTS_MAX_BODY_BYTES};
pub use paths::{cli_app_data_dir, index_db_path, INDEX_DIR_ENV, RELEASE_IDENTIFIER};
pub use query::*;
pub use schema::{schema_version, PARSER_VERSION};
pub use search::{SearchHit, SearchOptions, SearchPage, Snippet};

use parking_lot::Mutex;
use resolve::PathIndex;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Sender, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("index I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("index scan cancelled")]
    Cancelled,
    #[error("index is closed")]
    Closed,
    #[error("invalid index request: {0}")]
    Invalid(String),
    #[error("index internal error: {0}")]
    Internal(String),
}

/// What changed, for `index://changed`. `full` means "everything may have
/// changed" (cold build or a very large batch); `paths` is then empty.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeBatch {
    pub paths: Vec<String>,
    pub full: bool,
}

pub type ChangeCallback = Arc<dyn Fn(ChangeBatch) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexState {
    Building,
    Ready,
    Error,
}

#[derive(Default)]
struct StatusInner {
    ready: bool,
    scanning: bool,
    built_at: Option<i64>,
    last_error: Option<String>,
    rebuilt_reason: Option<String>,
    last_scan: Option<ScanStats>,
}

pub(crate) struct Shared {
    pub root: PathBuf,
    pub db_path: PathBuf,
    external_cancel: Arc<AtomicBool>,
    stop: AtomicBool,
    pub scanned: AtomicU64,
    /// Bumped after every writer job; keys the derived caches.
    epoch: AtomicU64,
    status: Mutex<StatusInner>,
    on_change: Option<ChangeCallback>,
    /// Perf A/B in tests: build without the full-text rows.
    #[cfg(test)]
    pub(crate) fts_disabled: AtomicBool,
}

impl Shared {
    pub fn cancelled(&self) -> bool {
        self.stop.load(Ordering::Relaxed) || self.external_cancel.load(Ordering::Relaxed)
    }
}

type Reply<T> = Option<SyncSender<Result<T, IndexError>>>;

enum Job {
    Scan(Reply<ScanStats>),
    Paths(Vec<PathBuf>, Reply<Vec<String>>),
    Fts(FtsMaintenance, Reply<()>),
    Shutdown,
}

pub struct OpenParams {
    pub root: PathBuf,
    pub app_data_dir: PathBuf,
    /// Flipped by the owner on workspace switch (the `cancel_index` token).
    pub cancel: Arc<AtomicBool>,
    pub on_change: Option<ChangeCallback>,
}

struct ReadPool {
    db_path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl ReadPool {
    const MAX_IDLE: usize = 4;

    fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        let conn = match self.idle.lock().pop() {
            Some(c) => c,
            None => schema::open_reader(&self.db_path)?,
        };
        let result = f(&conn);
        let mut idle = self.idle.lock();
        if idle.len() < Self::MAX_IDLE {
            idle.push(conn);
        }
        result
    }
}

/// Derived data rebuilt lazily when the index epoch moves.
#[derive(Default)]
struct EpochCache {
    epoch: u64,
    paths: Option<Arc<PathIndex>>,
    backlinks: Option<Arc<BacklinkMap>>,
}

/// Target path -> sorted, distinct source paths (self-links excluded).
pub type BacklinkMap = std::collections::HashMap<String, Vec<String>>;

pub struct Index {
    shared: Arc<Shared>,
    jobs: Sender<Job>,
    worker: Mutex<Option<JoinHandle<()>>>,
    readers: ReadPool,
    cache: Mutex<EpochCache>,
}

impl Index {
    /// Open (creating or rebuilding as needed) the index for `params.root`.
    /// Returns immediately after the database is ready; call [`Self::start_scan`]
    /// or [`Self::refresh_blocking`] to populate it.
    pub fn open(params: OpenParams) -> Result<Index, IndexError> {
        let root = params.root.canonicalize()?;
        if !root.is_dir() {
            return Err(IndexError::Invalid(format!(
                "{} is not a directory",
                root.display()
            )));
        }
        let root_str = root
            .to_str()
            .ok_or_else(|| IndexError::Invalid("workspace path is not valid UTF-8".into()))?
            .to_string();
        let db_path = index_db_path(&params.app_data_dir, &root);
        let opened = schema::open_or_rebuild(&db_path, &root_str)?;
        let shared = Arc::new(Shared {
            root,
            db_path: db_path.clone(),
            external_cancel: params.cancel,
            stop: AtomicBool::new(false),
            scanned: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            status: Mutex::new(StatusInner {
                rebuilt_reason: opened.rebuilt_reason,
                ..Default::default()
            }),
            on_change: params.on_change,
            #[cfg(test)]
            fts_disabled: AtomicBool::new(false),
        });
        let conn = opened.conn;
        let paths = build::load_path_index(&conn)?;
        {
            // A database that already holds a completed build is queryable
            // right away; a warm refresh only brings it up to date.
            let has_build = conn
                .query_row("SELECT value FROM meta WHERE key = 'built_at'", [], |r| {
                    r.get::<_, String>(0)
                })
                .ok();
            let mut st = shared.status.lock();
            st.built_at = has_build.and_then(|v| v.parse().ok());
            st.ready = st.built_at.is_some();
        }
        let (tx, rx) = channel::<Job>();
        let worker_shared = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("vault-index-writer".into())
            .spawn(move || worker_main(conn, paths, worker_shared, rx))?;
        Ok(Index {
            shared,
            jobs: tx,
            worker: Mutex::new(Some(handle)),
            readers: ReadPool {
                db_path,
                idle: Mutex::new(Vec::new()),
            },
            cache: Mutex::new(EpochCache::default()),
        })
    }

    /// Headless entry point for the `writer` CLI: open the same database as the
    /// app and bring it up to date before returning. Pass `None` to use
    /// [`cli_app_data_dir`] (`WRITER_INDEX_DIR` or the release identifier's
    /// app data directory).
    pub fn open_for_cli(root: &Path, app_data_dir: Option<&Path>) -> Result<Index, IndexError> {
        let app_data_dir = match app_data_dir {
            Some(p) => p.to_path_buf(),
            None => cli_app_data_dir().map_err(IndexError::Invalid)?,
        };
        let index = Index::open(OpenParams {
            root: root.to_path_buf(),
            app_data_dir,
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: None,
        })?;
        index.refresh_blocking()?;
        Ok(index)
    }

    /// Counter that changes whenever the indexed data may have changed.
    pub fn epoch(&self) -> u64 {
        self.shared.epoch.load(Ordering::SeqCst)
    }

    /// Path index (link resolution), cached per epoch.
    pub(crate) fn cached_paths(&self) -> Result<Arc<PathIndex>, IndexError> {
        let epoch = self.epoch();
        {
            let c = self.cache.lock();
            if c.epoch == epoch {
                if let Some(p) = &c.paths {
                    return Ok(Arc::clone(p));
                }
            }
        }
        let built = Arc::new(self.read(build::load_path_index)?);
        let mut c = self.cache.lock();
        if c.epoch != epoch {
            *c = EpochCache {
                epoch,
                ..EpochCache::default()
            };
        }
        c.paths = Some(Arc::clone(&built));
        Ok(built)
    }

    /// Reverse link map, cached per epoch (it is the slow part of
    /// `file.backlinks`).
    pub fn cached_backlinks(&self) -> Result<Arc<BacklinkMap>, IndexError> {
        let epoch = self.epoch();
        {
            let c = self.cache.lock();
            if c.epoch == epoch {
                if let Some(b) = &c.backlinks {
                    return Ok(Arc::clone(b));
                }
            }
        }
        let built = Arc::new(self.read(|c| {
            let mut st = c.prepare(
                "SELECT DISTINCT l.target_path, f.path FROM links l JOIN files f ON f.id = l.src_id \
                 WHERE l.target_path IS NOT NULL AND l.target_path != f.path ORDER BY l.target_path, f.path",
            )?;
            let mut map = BacklinkMap::new();
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                map.entry(r.get::<_, String>(0)?)
                    .or_default()
                    .push(r.get::<_, String>(1)?);
            }
            Ok(map)
        })?);
        let mut c = self.cache.lock();
        if c.epoch != epoch {
            *c = EpochCache {
                epoch,
                ..EpochCache::default()
            };
        }
        c.backlinks = Some(Arc::clone(&built));
        Ok(built)
    }

    pub fn root(&self) -> &Path {
        &self.shared.root
    }

    pub fn db_path(&self) -> &Path {
        &self.shared.db_path
    }

    fn send(&self, job: Job) -> Result<(), IndexError> {
        self.jobs.send(job).map_err(|_| IndexError::Closed)
    }

    /// Queue a scan (cold build or warm diff) and return immediately.
    pub fn start_scan(&self) -> Result<(), IndexError> {
        self.send(Job::Scan(None))
    }

    /// Scan and wait for the result.
    pub fn refresh_blocking(&self) -> Result<ScanStats, IndexError> {
        let (tx, rx) = sync_channel(1);
        self.send(Job::Scan(Some(tx)))?;
        rx.recv().map_err(|_| IndexError::Closed)?
    }

    /// Queue a re-index of absolute `paths` and return immediately.
    pub fn queue_paths(&self, paths: Vec<PathBuf>) -> Result<(), IndexError> {
        self.send(Job::Paths(paths, None))
    }

    /// Re-index absolute `paths` and wait. Returns the vault-relative paths
    /// that were written or removed.
    pub fn index_paths_blocking(&self, paths: Vec<PathBuf>) -> Result<Vec<String>, IndexError> {
        let (tx, rx) = sync_channel(1);
        self.send(Job::Paths(paths, Some(tx)))?;
        rx.recv().map_err(|_| IndexError::Closed)?
    }

    pub(crate) fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        self.readers.with(f)
    }

    /// Stop the writer thread (aborting a running scan) and wait for it.
    pub fn close(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let _ = self.jobs.send(Job::Shutdown);
        if let Some(handle) = self.worker.lock().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Index {
    fn drop(&mut self) {
        self.close();
    }
}

fn notify(shared: &Shared, paths: Vec<String>, full: bool) {
    if paths.is_empty() && !full {
        return;
    }
    if let Some(cb) = &shared.on_change {
        cb(ChangeBatch { paths, full });
    }
}

fn worker_main(
    mut conn: Connection,
    mut paths: PathIndex,
    shared: Arc<Shared>,
    rx: std::sync::mpsc::Receiver<Job>,
) {
    for job in rx {
        match job {
            Job::Shutdown => break,
            Job::Scan(reply) => {
                shared.status.lock().scanning = true;
                let result = build::scan(&mut conn, &shared, &mut paths);
                let mut st = shared.status.lock();
                st.scanning = false;
                let outcome = match result {
                    Ok(o) => {
                        st.ready = true;
                        st.built_at = Some(build::now_ms());
                        st.last_error = None;
                        st.last_scan = Some(o.stats.clone());
                        drop(st);
                        notify(&shared, o.changed, o.full);
                        Ok(o.stats)
                    }
                    Err(IndexError::Cancelled) => {
                        drop(st);
                        Err(IndexError::Cancelled)
                    }
                    Err(e) => {
                        st.last_error = Some(e.to_string());
                        drop(st);
                        log::error!("vault index scan failed: {e}");
                        Err(e)
                    }
                };
                shared.epoch.fetch_add(1, Ordering::SeqCst);
                if let Some(r) = reply {
                    let _ = r.send(outcome);
                }
            }
            Job::Fts(op, reply) => {
                let result = search::run_fts_job(&conn, op);
                if let Some(r) = reply {
                    let _ = r.send(result);
                }
            }
            Job::Paths(abs, reply) => {
                let result = if shared.cancelled() {
                    Err(IndexError::Cancelled)
                } else {
                    build::index_paths(&mut conn, &shared, &mut paths, &abs)
                };
                let outcome = match result {
                    Ok(changed) => {
                        log::debug!(
                            target: "index",
                            "paths job: {} written/removed, first: {}",
                            changed.len(),
                            changed.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
                        );
                        notify(&shared, changed.clone(), false);
                        Ok(changed)
                    }
                    Err(e) => {
                        if !matches!(e, IndexError::Cancelled) {
                            shared.status.lock().last_error = Some(e.to_string());
                            log::error!("vault index update failed: {e}");
                        }
                        Err(e)
                    }
                };
                shared.epoch.fetch_add(1, Ordering::SeqCst);
                if let Some(r) = reply {
                    let _ = r.send(outcome);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub root: String,
    pub db_path: String,
    pub schema_version: &'static str,
    pub parser_version: &'static str,
    pub files: i64,
    pub markdown_files: i64,
    /// Files processed by the scan currently running (progress).
    pub scanned: u64,
    pub scanning: bool,
    pub built_at: Option<i64>,
    pub rebuilt_reason: Option<String>,
    pub last_error: Option<String>,
    pub last_scan: Option<ScanStats>,
}

impl Index {
    pub fn status(&self) -> Result<IndexStatus, IndexError> {
        let (files, markdown_files) = self.read(build::count_files)?;
        let st = self.shared.status.lock();
        let state = if st.last_error.is_some() {
            IndexState::Error
        } else if st.ready {
            IndexState::Ready
        } else {
            IndexState::Building
        };
        Ok(IndexStatus {
            state,
            root: self.shared.root.to_string_lossy().into_owned(),
            db_path: self.shared.db_path.to_string_lossy().into_owned(),
            schema_version: schema_version(),
            parser_version: PARSER_VERSION,
            files,
            markdown_files,
            scanned: self.shared.scanned.load(Ordering::Relaxed),
            scanning: st.scanning,
            built_at: st.built_at,
            rebuilt_reason: st.rebuilt_reason.clone(),
            last_error: st.last_error.clone(),
            last_scan: st.last_scan.clone(),
        })
    }
}
