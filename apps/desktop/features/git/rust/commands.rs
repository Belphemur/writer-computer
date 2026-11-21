//! The `plugin:git|*` handlers. The logic is `crate::git` and `runtime.rs`; this file reads the
//! calling window's vault, keeps the work off the main thread (`commands::blocking`) and answers
//! with the status the status item, the panel and the settings page draw.

use super::runtime;
use crate::commands::blocking;
use crate::error::AppError;
use crate::git::{self, device, message::Change, SetupMode};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{Emitter, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    /// Vault-relative, forward slashes (a move's new path).
    pub path: String,
    /// `add`, `edit`, `delete` or `move`.
    pub kind: String,
    pub from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The vault is a Git repository (set up by Writer or not).
    pub has_repo: bool,
    pub set_up: bool,
    pub paused: bool,
    pub changes: Vec<ChangeRow>,
    /// Committer time of the last commit, seconds since the epoch.
    pub last_commit: Option<f64>,
    /// Git has no name and email: nothing can be committed.
    pub identity_error: bool,
    pub turn_running: bool,
    /// A commit is being written.
    pub committing: bool,
    /// The last failure, one line.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Setup {
    /// "Local history only": `git init` when needed.
    Local,
    /// "Use existing repository".
    Existing,
}

fn row(c: &Change) -> ChangeRow {
    match c {
        Change::Add(p) => ChangeRow {
            path: p.clone(),
            kind: "add".into(),
            from: None,
        },
        Change::Edit(p) => ChangeRow {
            path: p.clone(),
            kind: "edit".into(),
            from: None,
        },
        Change::Delete(p) => ChangeRow {
            path: p.clone(),
            kind: "delete".into(),
            from: None,
        },
        Change::Move { from, to } => ChangeRow {
            path: to.clone(),
            kind: "move".into(),
            from: Some(from.clone()),
        },
    }
}

fn refused(e: git::Error) -> AppError {
    match e {
        git::Error::Io(e) => AppError::from(e),
        other => AppError::Refused(runtime::error_line(&other)),
    }
}

fn window_root<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<PathBuf, AppError> {
    let state = app.state::<crate::state::AppState>().get_or_create(label);
    let root = state.workspace_root.read().clone();
    root.ok_or(AppError::NoWorkspace)?
        .canonicalize()
        .map_err(AppError::from)
}

fn status_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    refresh: bool,
) -> Result<GitStatus, AppError> {
    let root = window_root(app, label)?;
    let vaults = super::runtime::vaults(app);
    let fallback = git::IdentityCache::default();
    let cache = vaults.as_ref().map_or(&fallback, |v| &v.identity);
    let s = git::status(&root, cache, refresh).map_err(refused)?;
    Ok(GitStatus {
        has_repo: s.has_repo,
        set_up: s.set_up,
        paused: s.paused,
        changes: s.changes.iter().map(row).collect(),
        last_commit: s.last_commit.map(|t| t as f64),
        identity_error: s.identity_error,
        turn_running: vaults.as_ref().is_some_and(|v| v.turn_running(label)),
        committing: vaults.as_ref().is_some_and(|v| v.busy()),
        error: vaults.as_ref().and_then(|v| v.error_of(label)),
    })
}

/// The window's vault state. `refresh` asks git for the commit identity again instead of using
/// the remembered answer (the settings page does when it opens).
#[tauri::command]
#[specta::specta]
pub async fn git_status<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    refresh: bool,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || status_of(&app, &label, refresh)).await
}

/// Sets the window's vault up (the repository, the ignore block, the first version).
#[tauri::command]
#[specta::specta]
pub async fn git_setup<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    mode: Setup,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        let mode = match mode {
            Setup::Local => SetupMode::LocalOnly,
            Setup::Existing => SetupMode::Existing,
        };
        git::setup(&root, mode, &device::name()).map_err(refused)?;
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, true)
    })
    .await
}

/// Saves a version now.
#[tauri::command]
#[specta::specta]
pub async fn git_commit_now<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        window_root(&app, &label)?;
        runtime::commit_user_now(&app, &label).map_err(refused)?;
        status_of(&app, &label, true)
    })
    .await
}

/// Pauses or resumes the automatic versions of the window's vault (device-local).
#[tauri::command]
#[specta::specta]
pub async fn git_set_paused<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    paused: bool,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        git::state::set_paused(&root, paused)?;
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}
