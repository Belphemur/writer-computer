//! Tauri glue for the Writer-managed agent skills (`managed_skills`, spec
//! `SPECs/managed-vault-skills-spec.md`): sync on workspace open and startup
//! restore, and an on-demand command.

use crate::error::AppError;
use crate::managed_skills::{self, Mode, SyncReport};
use crate::state::AppState;
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Emitted to the window after a sync that changed something or found
/// something the user should know (a user-owned skill in the way, a skill from a
/// newer Writer, an error). The UI may show a notice; nothing listens yet.
const REPORT_EVENT: &str = "skills:sync-report";

#[derive(Serialize, Clone)]
struct ReportEvent {
    root: String,
    report: Option<SyncReport>,
    error: Option<String>,
}

/// `workspace.managed-agent-skills` (global, default on).
fn enabled(app: &tauri::AppHandle, label: &str) -> bool {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    guard
        .as_ref()
        .and_then(|s| s.get_global_or_default(managed_skills::SETTING_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn log_report(root: &std::path::Path, report: &SyncReport) {
    for o in &report.outcomes {
        if o.action.is_change() {
            log::info!(
                "managed skills: {} {} ({})",
                o.dir,
                o.action.as_str(),
                o.detail
            );
        } else if o.action.is_problem() {
            log::warn!(
                "managed skills in {}: {} {} ({})",
                root.display(),
                o.dir,
                o.action.as_str(),
                o.detail
            );
        }
    }
}

/// Sync the skills of a workspace that was just opened, off the calling
/// thread. Never blocks, never panics the caller; failures are logged and sent
/// to the window.
pub fn spawn_workspace_sync(app: &tauri::AppHandle, label: &str, root: std::path::PathBuf) {
    if !enabled(app, label) {
        return;
    }
    let app = app.clone();
    let label = label.to_string();
    let spawned = std::thread::Builder::new()
        .name("managed-skills".into())
        .spawn(move || {
            let root_string = root.to_string_lossy().into_owned();
            let event = match managed_skills::sync(&root, Mode::Apply) {
                Ok(report) => {
                    log_report(&root, &report);
                    if !report.notable() {
                        return;
                    }
                    ReportEvent {
                        root: root_string,
                        report: Some(report),
                        error: None,
                    }
                }
                Err(e) => {
                    log::warn!("managed skills: sync of {root_string} failed: {e}");
                    ReportEvent {
                        root: root_string,
                        report: None,
                        error: Some(e),
                    }
                }
            };
            let _ = app.emit_to(label, REPORT_EVENT, event);
        });
    if let Err(e) = spawned {
        log::warn!("managed skills: could not start the sync thread: {e}");
    }
}

/// Resync the calling window's workspace now (ignores the setting: it is an
/// explicit request). `check` reports without writing.
#[tauri::command]
pub async fn sync_managed_skills(
    check: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<SyncReport, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    let mode = if check.unwrap_or(false) {
        Mode::Check
    } else {
        Mode::Apply
    };
    tauri::async_runtime::spawn_blocking(move || {
        let report = managed_skills::sync(&root, mode).map_err(AppError::Io)?;
        log_report(&root, &report);
        Ok(report)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

/// Absolute paths of the Writer-managed skill folders of this window's workspace (marker in
/// `SKILL.md`), for the sidebar badge and the "overwritten on update" editor warning.
#[tauri::command]
pub async fn list_managed_skill_dirs(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<String>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    super::blocking(move || {
        Ok(managed_skills::managed_dirs(&root)
            .into_iter()
            .map(|rel| root.join(rel).to_string_lossy().into_owned())
            .collect())
    })
    .await
}
