//! IPC for the keyboard shortcut overrides (`crate::hotkeys`, spec `SPECs/hotkeys-spec.md`):
//! `hotkeys.json` in the app data dir (read, validated write that tells every window), and the
//! vault's `.obsidian/hotkeys.json` read-only for the import.

use super::blocking;
use crate::error::AppError;
use crate::hotkeys::{self, HotkeysError};
use crate::state::AppState;
use tauri::{Emitter, Manager};

/// Sent to every window after a write, so each one reloads (a window never keeps stale keys).
pub const CHANGED_EVENT: &str = "hotkeys:changed";

fn err(e: HotkeysError) -> AppError {
    match e {
        HotkeysError::Invalid(m) => AppError::Refused(m),
        HotkeysError::Io(m) => AppError::Io(m),
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))
}

/// The text of `hotkeys.json`, or null when the user has changed nothing yet. An invalid file is
/// an error (the page says so and the defaults apply).
#[tauri::command]
pub async fn hotkeys_read(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let dir = data_dir(&app)?;
    blocking(move || hotkeys::read(&dir).map_err(err)).await
}

/// Validates and atomically replaces `hotkeys.json`, then emits [`CHANGED_EVENT`].
#[tauri::command]
pub async fn hotkeys_write(app: tauri::AppHandle, content: String) -> Result<(), AppError> {
    let dir = data_dir(&app)?;
    blocking(move || hotkeys::write(&dir, &content).map_err(err)).await?;
    app.emit(CHANGED_EVENT, ())
        .map_err(|e| AppError::Io(e.to_string()))
}

/// The text of the open vault's `.obsidian/hotkeys.json`, or null when it has none. Read-only.
#[tauri::command]
pub async fn hotkeys_read_obsidian(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    blocking(move || {
        let root = root.canonicalize().map_err(AppError::from)?;
        // A symlinked `.obsidian` that points out of the vault is refused here.
        state.authorize_path(&root.join(".obsidian"))?;
        hotkeys::read_obsidian(&root).map_err(err)
    })
    .await
}
