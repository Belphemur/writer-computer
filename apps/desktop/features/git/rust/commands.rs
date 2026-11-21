//! The `plugin:git|*` handlers. The logic is `crate::git` and `runtime.rs`; this file reads the
//! calling window's vault, keeps the work off the main thread (`commands::blocking`) and answers
//! with the status the status item, the panel and the settings page draw.

use super::runtime;
use crate::commands::blocking;
use crate::error::AppError;
use crate::git::history::{self, Against, FileDiff};
use crate::git::repo::{Version, VersionKind};
use crate::git::{self, device, message::Change, Repo, SetupMode};
use crate::vault_ops;
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
    /// A folder above the vault is a repository: setup is the user's choice, never silent.
    pub parent_repo: bool,
    /// The user chose "Stop version history" for this vault.
    pub stopped: bool,
    pub paused: bool,
    pub changes: Vec<ChangeRow>,
    /// Committer time of the last commit, seconds since the epoch.
    pub last_commit: Option<f64>,
    /// Git has no name and email: nothing can be committed.
    pub identity_error: bool,
    /// A merge, rebase, cherry-pick, revert, bisect or a detached HEAD: nothing is committed
    /// until it is over (`merge in progress`, `detached HEAD`, ...).
    pub operation: Option<String>,
    /// Files over the size Writer versions (no LFS yet), vault-relative: "Not versioned".
    pub too_large: Vec<String>,
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
        parent_repo: s.parent_repo,
        stopped: s.stopped,
        paused: s.paused,
        changes: s.changes.iter().map(row).collect(),
        last_commit: s.last_commit.map(|t| t as f64),
        identity_error: s.identity_error,
        operation: s.operation.map(|o| o.label().to_string()),
        too_large: s.too_large,
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

/// Stops version history for the window's vault (device-local; `.git` is never touched).
#[tauri::command]
#[specta::specta]
pub async fn git_stop<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        git::stop(&root)?;
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// One version of a file in the History tab.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    /// The commit id.
    pub rev: String,
    /// Seconds since the epoch.
    pub time: f64,
    /// `add`, `edit`, `delete` or `move`.
    pub kind: String,
    /// The file's path in this version (a rename shows the old name on older versions).
    pub path: String,
    pub from: Option<String>,
    /// Who: `user`, `agent`, `chore`; `None` for a commit Writer did not make.
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub scope: Option<String>,
    pub subject: String,
    pub device: Option<String>,
    pub chat: Option<String>,
    pub agent: Option<String>,
    pub models: Vec<String>,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

fn version_row(r: history::Row) -> VersionRow {
    let Version {
        id,
        time,
        message: m,
        path,
        from,
        kind,
        ..
    } = r.version;
    VersionRow {
        rev: id,
        time: time as f64,
        kind: match kind {
            VersionKind::Add => "add",
            VersionKind::Edit => "edit",
            VersionKind::Delete => "delete",
            VersionKind::Move => "move",
        }
        .into(),
        path,
        from,
        ty: m.ty.map(|t| t.as_str().to_string()),
        scope: m.scope.map(|s| s.as_str().to_string()),
        subject: m.subject,
        device: m.device,
        chat: m.chat,
        agent: m.agent,
        models: m.models,
        added: r.added,
        removed: r.removed,
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedRow {
    pub path: String,
    /// The commit that removed it.
    pub rev: String,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoredRow {
    /// Where the content went (a free name when a new file took the old path).
    pub path: String,
}

/// The repository of a set-up vault and its confined, vault-relative path.
fn history_target(
    app: &tauri::AppHandle<impl Runtime>,
    label: &str,
    path: &str,
) -> Result<(PathBuf, Repo, String), AppError> {
    let root = window_root(app, label)?;
    if !git::is_set_up(&root) {
        return Err(AppError::Refused("Version history is not set up".into()));
    }
    let rel = vault_ops::confine(&root, path)
        .map_err(|e| AppError::Refused(e.to_string()))?
        .rel;
    let repo = Repo::open(&root)
        .map_err(refused)?
        .ok_or_else(|| AppError::Refused("Not a Git repository".into()))?;
    Ok((root, repo, rel))
}

/// The versions of a file, newest first, following renames.
#[tauri::command]
#[specta::specta]
pub async fn git_history<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    limit: Option<u32>,
) -> Result<Vec<VersionRow>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (_, repo, rel) = history_target(&app, &label, &path)?;
        let limit = limit.unwrap_or(200) as usize;
        // the per-HEAD cache when the runtime exists (feature on), the plain walk otherwise
        let rows = match runtime::vaults(&app) {
            Some(v) => v.history.versions(&repo, &rel, limit),
            None => history::versions(&repo, &rel, limit),
        }
        .map_err(refused)?;
        Ok(rows.into_iter().map(version_row).collect())
    })
    .await
}

/// The files removed from the vault that are not there now, newest removal first.
#[tauri::command]
#[specta::specta]
pub async fn git_deleted<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<DeletedRow>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        if !git::is_set_up(&root) {
            return Ok(Vec::new());
        }
        let repo = Repo::open(&root)
            .map_err(refused)?
            .ok_or_else(|| AppError::Refused("Not a Git repository".into()))?;
        Ok(history::deleted(&repo)
            .map_err(refused)?
            .into_iter()
            .map(|d| DeletedRow {
                path: d.path,
                rev: d.id,
                time: d.time as f64,
            })
            .collect())
    })
    .await
}

/// What a version changed: against its parent (`against` empty or `parent`), against the file
/// now (`current`), or against another version (its id).
#[tauri::command]
#[specta::specta]
pub async fn git_version_diff<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    rev: String,
    against: Option<String>,
) -> Result<FileDiff, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, repo, rel) = history_target(&app, &label, &path)?;
        let against = match against.as_deref() {
            None | Some("") | Some("parent") => Against::Parent,
            Some("current") => Against::Current,
            Some(other) => Against::Version(other.to_string()),
        };
        history::diff(&repo, &root, &rel, &rev, &against).map_err(refused)
    })
    .await
}

/// The text of a version (to copy or to read), `None` for a deletion or a file that is not text.
#[tauri::command]
#[specta::specta]
pub async fn git_version_text<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    rev: String,
) -> Result<Option<String>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (_, repo, rel) = history_target(&app, &label, &path)?;
        let v = history::find(&repo, &rel, &rev).map_err(refused)?;
        let bytes = history::content(&repo, &v).map_err(refused)?;
        Ok(bytes.and_then(|b| history::as_text(&b).map(str::to_string)))
    })
    .await
}

/// Restores a version as a new change, committed as `user(restore)`.
#[tauri::command]
#[specta::specta]
pub async fn git_restore<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    rev: String,
) -> Result<RestoredRow, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, repo, rel) = history_target(&app, &label, &path)?;
        let v = runtime::vaults(&app);
        let _busy = v.as_ref().map(|v| v.busy_guard());
        let done = history::restore(&repo, &root, &rel, &rev, &device::name()).map_err(|e| {
            if let Some(v) = &v {
                v.identity.forget(&root);
            }
            refused(e)
        })?;
        log::info!(target: "git", "git: restored a version");
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        Ok(RestoredRow { path: done.path })
    })
    .await
}

/// Where git is with an agent turn's commit (found by chat id and turn id).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnCommitRow {
    pub rev: Option<String>,
    /// Nothing more to wait for: found, or git moved on without one.
    pub settled: bool,
}

/// The commit of an agent turn, by its chat id and turn id (the `Writer-Chat` and `Writer-Turn`
/// trailers). `finished_at` (seconds) lets the answer settle. The agent's Changes card asks.
#[tauri::command]
#[specta::specta]
pub async fn git_turn_commit<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    chat_id: String,
    turn_id: String,
    finished_at: Option<f64>,
) -> Result<TurnCommitRow, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let nothing = TurnCommitRow {
            rev: None,
            settled: true,
        };
        let root = window_root(&app, &label)?;
        if !git::is_set_up(&root) {
            return Ok(nothing);
        }
        let Some(repo) = Repo::open(&root).map_err(refused)? else {
            return Ok(nothing);
        };
        let t = history::turn_commit(&repo, &chat_id, &turn_id, finished_at.map(|f| f as i64))
            .map_err(refused)?;
        Ok(TurnCommitRow {
            rev: t.rev,
            settled: t.settled,
        })
    })
    .await
}
