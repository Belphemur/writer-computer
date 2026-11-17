//! Tauri glue for the agent's memory (`agent/memory.rs`, Tauri-free; ADR "Keep agent memory in
//! the vault ..."). Resolves the window's workspace root (never taken from the UI) and does the
//! IO through `blocking`; every path is built and confined by the core. Logs counts only, never
//! file names, paths or contents.

use super::root_of;
use crate::agent::memory::{self, ImportReport, MemoryOverview, MemoryScope};
use crate::agent::project;
use crate::commands::blocking;
use crate::error::AppError;
use crate::vault_ops::VaultOpError;
use tauri::Runtime;

fn map_err(e: VaultOpError) -> AppError {
    match e {
        VaultOpError::NotFound(m) => AppError::NotFound(m),
        VaultOpError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

/// The vault memory and, with `project_path` (vault-relative), that project's.
#[tauri::command]
#[specta::specta]
pub async fn agent_memory_list<R: Runtime>(
    project_path: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<MemoryOverview, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || memory::list(&root, project_path.as_deref()).map_err(map_err)).await
}

/// Deletes one memory file (a name, not a path) of the vault or the project memory.
#[tauri::command]
#[specta::specta]
pub async fn agent_memory_delete<R: Runtime>(
    scope: MemoryScope,
    project_path: Option<String>,
    name: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        memory::delete(&root, scope, project_path.as_deref(), &name).map_err(map_err)?;
        log::info!("agent memory: deleted 1 file");
        Ok(())
    })
    .await
}

/// Empties the vault memory or the project memory; returns how many entries went.
#[tauri::command]
#[specta::specta]
pub async fn agent_memory_forget_all<R: Runtime>(
    scope: MemoryScope,
    project_path: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<u32, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let n = memory::forget_all(&root, scope, project_path.as_deref()).map_err(map_err)?;
        log::info!("agent memory: forgot {n} entries");
        Ok(n as u32)
    })
    .await
}

/// The user-clicked import of Claude Code's own memory for this vault and its projects (the only
/// place the home folder is read, and only the matching `projects/<key>/memory/` folders).
#[tauri::command]
#[specta::specta]
pub async fn agent_memory_import_claude<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ImportReport, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let home = crate::plugin_env::home_dir()
            .ok_or_else(|| AppError::NotFound("the home folder".into()))?;
        let projects: Vec<String> = project::list(&root, true)
            .map_err(|e| AppError::Io(e.to_string()))?
            .into_iter()
            .map(|p| p.info.path)
            .collect();
        let report = memory::import_claude(&root, &home, &projects).map_err(map_err)?;
        log::info!(
            "agent memory: import found {} folders, imported {}, skipped {}",
            report.folders_found,
            report.imported,
            report.skipped
        );
        Ok(report)
    })
    .await
}
