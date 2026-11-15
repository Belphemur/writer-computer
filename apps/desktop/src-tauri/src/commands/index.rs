//! Tauri wrappers around [`crate::index`]. The index itself is Tauri-free so
//! the `writer` CLI can share it; this file only owns the per-window
//! registry, path authorisation, and the `index://changed` event.

use crate::error::AppError;
use crate::index::{
    ChangeBatch, FileFilter, FilePage, Index, IndexError, IndexState, IndexStatus, MetaSelector,
    MetadataResult, OpenParams, SearchOptions, SearchPage,
};
use crate::state::{AppState, WorkspaceState};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

struct Entry {
    root: PathBuf,
    epoch: u64,
    index: Arc<Index>,
}

/// One index per window, bound to the workspace root and epoch it was opened
/// for. A workspace switch (new epoch) replaces the entry.
#[derive(Default)]
pub struct IndexRegistry {
    entries: Mutex<HashMap<String, Entry>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexChangedEvent {
    root: String,
    epoch: u64,
    /// Vault-relative paths written or removed. Empty with `full` set.
    paths: Vec<String>,
    full: bool,
}

pub(crate) fn app_err(e: IndexError) -> AppError {
    match e {
        IndexError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

/// Return this window's index, opening it (and queueing a warm scan) when the
/// window has none for the current workspace and epoch.
fn ensure_index(
    app: &tauri::AppHandle,
    label: &str,
    state: &Arc<WorkspaceState>,
) -> Result<Arc<Index>, AppError> {
    ensure_index_with(app, label, state, true)
}

/// [`ensure_index`], optionally without queueing the warm scan (the workspace
/// bootstrap runs its own scan and waits for it).
pub(crate) fn ensure_index_with(
    app: &tauri::AppHandle,
    label: &str,
    state: &Arc<WorkspaceState>,
    scan: bool,
) -> Result<Arc<Index>, AppError> {
    let (root, epoch) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    let registry = app.state::<IndexRegistry>();
    let mut entries = registry.entries.lock();
    if let Some(e) = entries.get(label) {
        if e.root == root && e.epoch == epoch {
            return Ok(Arc::clone(&e.index));
        }
    }
    // Close the outgoing index first so two writers never share a database.
    if let Some(old) = entries.remove(label) {
        old.index.close();
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let handle = app.clone();
    let event_label = label.to_string();
    let event_root = root.clone();
    // The name mirror (quick open, recents) follows the same feed as the UI.
    let names_generation = state.names.reset();
    let on_change = Arc::new(move |batch: ChangeBatch| {
        // Drop batches from a workspace the window has since left.
        let window = handle.state::<AppState>().get(&event_label);
        let current = window.as_ref().and_then(|s| s.workspace_snapshot());
        if current.as_ref() != Some(&(event_root.clone(), epoch)) {
            return;
        }
        if let Some(window) = &window {
            if let Err(e) = window.names.apply(names_generation, &batch) {
                log::error!("file-name mirror update failed for window {event_label}: {e}");
                window.names.mark_stale(names_generation);
            }
        }
        let payload = IndexChangedEvent {
            root: event_root.to_string_lossy().into_owned(),
            epoch,
            paths: batch.paths,
            full: batch.full,
        };
        let _ = handle.emit_to(event_label.clone(), "index://changed", &payload);
    });
    let index = Arc::new(
        Index::open(OpenParams {
            root: root.clone(),
            app_data_dir,
            cancel: Arc::clone(&state.cancel_index.read()),
            on_change: Some(on_change),
        })
        .map_err(app_err)?,
    );
    state.names.bind(
        names_generation,
        index.root().to_path_buf(),
        index.db_path().to_path_buf(),
    );
    if scan {
        index.start_scan().map_err(app_err)?;
    }
    entries.insert(
        label.to_string(),
        Entry {
            root,
            epoch,
            index: Arc::clone(&index),
        },
    );
    Ok(index)
}

/// Watcher feed: forward changed absolute paths (and `.gitignore` changes as a
/// rescan) to this window's index. Does nothing when the window has not opened
/// an index for this workspace epoch; the next open diffs against disk.
pub fn feed(
    app: &tauri::AppHandle,
    label: &str,
    root: &Path,
    epoch: u64,
    paths: Vec<PathBuf>,
    rescan: bool,
) {
    if paths.is_empty() && !rescan {
        return;
    }
    let Some(registry) = app.try_state::<IndexRegistry>() else {
        return;
    };
    let index = {
        let entries = registry.entries.lock();
        match entries.get(label) {
            Some(e) if e.root == root && e.epoch == epoch => Arc::clone(&e.index),
            _ => return,
        }
    };
    let result = if rescan {
        index.start_scan()
    } else {
        index.queue_paths(paths)
    };
    if let Err(e) = result {
        log::warn!("index feed failed for window {label}: {e}");
    }
}

/// A window closed: stop its index (off-thread; joining waits for the writer).
pub fn stop_window(app: &tauri::AppHandle, label: &str) {
    let Some(registry) = app.try_state::<IndexRegistry>() else {
        return;
    };
    let removed = registry.entries.lock().remove(label);
    if let Some(entry) = removed {
        std::thread::spawn(move || entry.index.close());
    }
}

/// Accept a workspace-relative path or an absolute path inside the workspace
/// and return the vault-relative form the index uses.
fn to_vault_relative(
    state: &WorkspaceState,
    index: &Index,
    path: &str,
) -> Result<String, AppError> {
    let p = Path::new(path);
    let rel: PathBuf = if p.is_absolute() {
        let resolved = state.authorize_path(p)?;
        resolved
            .strip_prefix(index.root())
            .map_err(|_| AppError::InvalidPath(format!("{path} is outside the workspace")))?
            .to_path_buf()
    } else {
        if p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(AppError::InvalidPath(format!(
                "{path} must stay inside the workspace"
            )));
        }
        p.to_path_buf()
    };
    crate::index::paths::rel_to_string(&rel)
        .ok_or_else(|| AppError::InvalidPath(format!("{path} is not valid UTF-8")))
}

pub(crate) fn window_index(
    app: &tauri::AppHandle,
    webview: &tauri::Webview,
) -> Result<(Arc<WorkspaceState>, Arc<Index>), AppError> {
    let label = webview.label();
    let state = app.state::<AppState>().get_or_create(label);
    let index = ensure_index(app, label, &state)?;
    Ok((state, index))
}

#[tauri::command]
pub async fn index_status(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<IndexStatus, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        index.status().map_err(app_err)
    })
    .await
}

/// Every frontmatter property name in the vault with its note count and value
/// types (`[{key, count, types}]`), for the Bases property pickers.
#[tauri::command]
pub async fn index_properties(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<crate::index::PropertyCount>, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        index.properties().map_err(app_err)
    })
    .await
}

#[tauri::command]
pub async fn index_query_files(
    filter: FileFilter,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<FilePage, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        index.query_files(&filter).map_err(app_err)
    })
    .await
}

/// `paths: null` returns every markdown note (the plugin host's bulk
/// hydration); otherwise only the listed notes, with unknown ones in `missing`.
#[tauri::command]
pub async fn index_get_metadata(
    paths: Option<Vec<String>>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<MetadataResult, AppError> {
    blocking(move || {
        let (state, index) = window_index(&app, &webview)?;
        let selector = match paths {
            None => MetaSelector::All,
            Some(list) => MetaSelector::Paths(
                list.iter()
                    .map(|p| to_vault_relative(&state, &index, p))
                    .collect::<Result<_, _>>()?,
            ),
        };
        index.get_metadata(&selector).map_err(app_err)
    })
    .await
}

/// Full-text search request: the query string plus [`SearchOptions`]
/// (`folder`, `tags`, `limit`, `offset`, `snippetLen`, `maxSnippets`,
/// `asYouType`, `caseSensitive`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(flatten)]
    pub options: SearchOptions,
}

/// Content search runs over the index: while the cold build is still running
/// it would silently miss notes, so it fails with the same "still being built"
/// message the Bases commands use (the UI retries on `index://changed`).
pub(crate) const INDEX_BUILDING_MESSAGE: &str =
    "the vault index is still being built; try again when it is ready";

#[tauri::command]
pub async fn index_search(
    request: SearchRequest,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<SearchPage, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        if index.status().map_err(app_err)?.state == IndexState::Building {
            return Err(AppError::Io(INDEX_BUILDING_MESSAGE.into()));
        }
        index
            .search(&request.query, &request.options)
            .map_err(app_err)
    })
    .await
}
