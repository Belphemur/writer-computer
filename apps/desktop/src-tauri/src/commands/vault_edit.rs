//! The write plumbing every feature that edits a vault note by text shares (the Bases cell
//! editor's property edits, the tasks feature's toggles and quick add): confine the path to the
//! window's vault, mark the write as ours so the watcher ignores its echo, run the edit on the
//! blocking pool, refresh the index row and tell the sidebar. The edit itself is `vault_ops` /
//! `tasks::ops` (Tauri-free).

use crate::commands::blocking;
use crate::commands::index::{app_err, window_index};
use crate::error::AppError;
use crate::vault_ops::{self, VaultOpError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Runtime};

pub(crate) fn op_err(e: VaultOpError) -> AppError {
    match e {
        VaultOpError::NotFound(m) => AppError::NotFound(m),
        VaultOpError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

/// Confine `path` (a markdown note when `markdown_only`, else any vault file; it may not exist
/// yet) to the window's vault and run
/// `edit(root, relative path)`, which answers whether it changed the file and its result.
/// `edit` gets the vault root and the confined path and writes through `vault_ops`.
pub(crate) async fn edit_vault_file<R: Runtime, T: Send + 'static>(
    path: String,
    markdown_only: bool,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    edit: impl FnOnce(&Path, &vault_ops::Confined) -> Result<(bool, T), VaultOpError> + Send + 'static,
) -> Result<T, AppError> {
    let label = webview.label().to_string();
    let (state, index) = window_index(&app, &webview)?;
    let c = if markdown_only {
        vault_ops::confine_markdown(index.root(), &path)
    } else {
        vault_ops::confine(index.root(), &path)
    }
    .map_err(op_err)?;
    // Record every spelling of the path the watcher may report.
    crate::watcher::record_write(&state, &c.abs);
    let lexical: PathBuf = index.root().join(&c.rel);
    if lexical != c.abs {
        crate::watcher::record_write(&state, &lexical);
    }
    let confined = c.clone();
    let abs = c.abs.clone();
    let root = index.root().to_path_buf();
    let idx = Arc::clone(&index);
    let (changed, out) = blocking(move || {
        let (changed, out) = edit(&root, &confined).map_err(op_err)?;
        if changed {
            idx.index_paths_blocking(vec![abs]).map_err(app_err)?;
        }
        Ok((changed, out))
    })
    .await?;
    if changed {
        let modified_at = crate::commands::fs::modified_time(&c.abs);
        state.update_index_modified_at(&c.abs, modified_at);
        let _ = app.emit_to(
            label,
            "sidebar:metadata-changed",
            &crate::commands::fs::WriteResult {
                path: c.abs.to_string_lossy().into_owned(),
                modified_at,
            },
        );
    }
    Ok(out)
}
