//! Tauri wrappers for the graph view's data. All logic is Tauri-free (`index::graph` for the
//! slice and stats, `config_file` for `.writer/graph.json`); this file owns the per-window
//! plumbing: the workspace index, the window's vault root and `commands::blocking`.

use super::config_file;
use crate::commands::blocking;
use crate::commands::index::{app_err, ensure_ready, window_index};
use crate::error::AppError;
use crate::index::graph::{GraphSlice, GraphSliceRequest, GraphStats};
use tauri::Runtime;

fn config_err(e: config_file::ConfigError) -> AppError {
    match e {
        config_file::ConfigError::Invalid(m) => AppError::InvalidPath(m),
        config_file::ConfigError::Io(m) => AppError::Io(m),
    }
}

/// The view's data (spec 8.5): the neighbourhood of `request.center`, or the whole vault's
/// highest-degree notes (at most `limit`, default 10,000), with the edges among them. One
/// request object, because a command takes at most 12 typed arguments.
#[tauri::command]
#[specta::specta]
pub async fn graph_slice<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    request: GraphSliceRequest,
) -> Result<GraphSlice, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        index.graph_slice(&request).map_err(app_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_stats<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GraphStats, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        index.graph_stats().map_err(app_err)
    })
    .await
}

/// The text of `.writer/graph.json`, or null when the vault has none.
#[tauri::command]
#[specta::specta]
pub async fn graph_config_read<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        config_file::read(index.root()).map_err(config_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_config_write<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    content: String,
) -> Result<(), AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        config_file::write(index.root(), &content).map_err(config_err)
    })
    .await
}
