//! The agent's Tauri commands, one file per concern; all thin glue that resolves the calling
//! window and its vault and calls the Tauri-free `crate::agent` core.
pub mod chats;
pub mod mcp;
pub mod memory;
pub mod projects;
pub mod session;
pub mod skills;

use crate::error::AppError;
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{Manager, Runtime};

/// The calling window's canonical workspace root: the one authorization every agent command
/// uses, like the core fs commands. The agent feature being enabled is its approval; it does not
/// depend on the Obsidian community-plugin vault trust (ADR 2026-11-17).
pub(super) fn root_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview: &tauri::Webview<R>,
) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    root.canonicalize().map_err(|e| AppError::Io(e.to_string()))
}
