//! The `plugin:git|*` handlers. The logic is `crate::git` and `runtime.rs`; this file reads the
//! calling window's vault, keeps the work off the main thread (`commands::blocking`) and answers
//! with the status the status item, the panel and the settings page draw.

use super::runtime;
use crate::commands::blocking;
use crate::error::AppError;
use crate::git::forge::{self, Forge, State};
use crate::git::history::{self, Against, FileDiff};
use crate::git::merge::{Part, Side};
use crate::git::repo::{Version, VersionKind};
use crate::git::resolve::{self, Choice, Take};
use crate::git::transport::{self, Source, Transport};
use crate::git::{self, device, message::Change, plugin_scan, Repo, SetupMode};
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

/// The LFS part of the status.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsRow {
    /// `git.lfs` as the user set it.
    pub on: bool,
    /// New large files go through LFS now: on, and `git-lfs` is installed.
    pub active: bool,
    /// `git-lfs` is installed (the setting is disabled with "Install git-lfs to use this" when not).
    pub available: bool,
    /// Files in LFS (pointers in the current version).
    pub files: u32,
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
    /// Files over the size Writer versions (LFS off), vault-relative: "Not versioned".
    pub too_large: Vec<String>,
    /// Large files (LFS): the setting, whether it applies, and how many files are in it.
    pub lfs: LfsRow,
    pub turn_running: bool,
    /// A commit is being written.
    pub committing: bool,
    /// The last failure, one line.
    pub error: Option<String>,
    /// What failed (`signing`, `other`): what a "Show logs" button switches on.
    pub error_kind: Option<String>,
    /// git's sanitized message of that failure, when it has one.
    pub error_details: Option<String>,
    /// Commit signing: what git says and whether the repository suggests it.
    pub signing: SigningRow,
    /// The remote as `host/owner/repo` (no scheme, no credentials); `None` without one.
    pub remote: Option<String>,
    /// The host of an HTTPS remote as git's credential requests name it (`host[:port]`, lower
    /// case); `None` for no remote or an SSH one. What a forge CLI's login is matched against.
    pub remote_host: Option<String>,
    pub branch: Option<String>,
    /// Commits not pushed, and commits of the remote not taken in.
    pub ahead: u32,
    pub behind: u32,
    /// "Pause sync": versions go on, nothing is fetched or pushed.
    pub sync_paused: bool,
    pub syncing: bool,
    /// Seconds since the epoch of the last successful sync.
    pub last_sync: Option<f64>,
    /// What the last successful sync pushed and took in (commits).
    pub last_pushed: u32,
    pub last_pulled: u32,
    pub sync_error: Option<SyncErrorRow>,
    /// Files the last sync could not settle: their version stays on disk until resolved.
    pub conflicts: Vec<ConflictRow>,
    /// Binaries that changed on both sides: the remote's stays, mine is the copy.
    pub copies: Vec<CopyRow>,
    /// Files restored because one side deleted what the other edited.
    pub restored: Vec<String>,
    /// Plugin settings held back from versions and the push: they look like they hold a token.
    pub held: Vec<HeldRow>,
    /// Paths a remote tree held that the sync refused to write (`.git`, device-local state, a
    /// path through a link): never written.
    pub refused: Vec<String>,
    /// Where HTTPS passwords come from: `token` or a forge CLI's id (`gh`, `fj`).
    pub credentials: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SigningRow {
    /// git's `commit.gpgsign`: Writer's commits are signed through git.
    pub on: bool,
    /// git resolves a signing key (the switch can be turned on).
    pub key: bool,
    /// Signing is off but the repository looks like it signs: recent commits are signed, or the
    /// remote refused a push for missing signatures.
    pub suggested: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncErrorRow {
    /// One line: "Push rejected: authentication failed".
    pub line: String,
    /// The sanitized git output (no credentials in URLs, no tokens), for "Details".
    pub details: String,
    /// The network is unreachable: the status reads Offline.
    pub offline: bool,
    /// What failed (`auth`, `offline`, `local-network`, `other` ...): what a "Show logs" button
    /// switches on.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRow {
    pub path: String,
    pub hunks: u32,
    pub properties: Vec<String>,
    /// Where the other side's version is when it is not at `path` (a rename).
    pub theirs_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyRow {
    pub path: String,
    pub copy: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HeldRow {
    pub id: String,
    pub name: String,
    pub path: String,
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
    let lfs = runtime::lfs_of(app, label, refresh);
    let s = git::status(&root, cache, refresh, lfs).map_err(refused)?;
    let lfs_row = LfsRow {
        on: runtime::config_of(app, label).lfs_on,
        active: lfs.enabled,
        available: match (vaults.as_ref(), super::sync::exec_of(app)) {
            (Some(v), Some(exec)) => v.lfs_available(&exec, refresh),
            _ => false,
        },
        files: s.lfs_files as u32,
    };
    let record = vaults
        .as_ref()
        .map(|v| v.record_of(label))
        .unwrap_or_default();
    let failure = vaults.as_ref().and_then(|v| v.failure_of(label));
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
        lfs: lfs_row,
        turn_running: vaults.as_ref().is_some_and(|v| v.turn_running(label)),
        committing: vaults.as_ref().is_some_and(|v| v.busy()),
        error: failure.as_ref().map(|e| e.line.clone()),
        error_kind: failure.as_ref().map(|e| e.kind.to_string()),
        error_details: failure
            .as_ref()
            .map(|e| e.details.clone())
            .filter(|d| !d.is_empty()),
        signing: SigningRow {
            on: s.signing.on,
            key: s.signing.key,
            suggested: s.signing.suggested()
                || (!s.signing.on
                    && record
                        .failure
                        .as_ref()
                        .is_some_and(|f| f.kind == transport::Kind::SignatureRequired.name())),
        },
        remote: s.remote.url.as_deref().map(transport::display_url),
        remote_host: s.remote.url.as_deref().and_then(transport::https_host),
        branch: s.remote.branch.clone(),
        ahead: s.remote.ahead as u32,
        behind: s.remote.behind as u32,
        sync_paused: s.sync_paused,
        syncing: record.syncing,
        last_sync: record.last_at.map(|t| t as f64),
        last_pushed: record.pushed as u32,
        last_pulled: record.pulled as u32,
        sync_error: record.failure.map(|f| SyncErrorRow {
            line: f.line,
            details: f.details,
            offline: f.offline,
            kind: f.kind.into(),
        }),
        conflicts: s
            .conflicts
            .into_iter()
            .map(|c| ConflictRow {
                path: c.path,
                hunks: c.hunks,
                properties: c.properties,
                theirs_path: c.theirs_path,
            })
            .collect(),
        copies: s
            .copies
            .into_iter()
            .map(|(path, copy)| CopyRow { path, copy })
            .collect(),
        restored: s.restored,
        refused: s.refused,
        held: s
            .held
            .into_iter()
            .map(|h| HeldRow {
                id: h.id,
                name: h.name,
                path: h.path,
            })
            .collect(),
        credentials: git::state::credential_source(&root).arg().to_string(),
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
        let v = runtime::vaults(&app);
        let lock = v.as_ref().map(|v| v.write_lock(&root));
        let _write = lock.as_ref().map(|l| l.lock());
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

/// The "Sign commits" switch of the window's vault: `commit.gpgsign` in its own git config.
#[tauri::command]
#[specta::specta]
pub async fn git_set_signing<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    on: bool,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        let (exec, _) = transport_of(&app, &root)?;
        git::set_signing(&exec, &root, on).map_err(AppError::Refused)?;
        if let Some(v) = runtime::vaults(&app) {
            v.identity.forget(&root);
            // a failed signature no longer describes the setting just changed
            v.set_error(&label, None);
        }
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, true)
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
    let repo = Repo::open_with(&root, runtime::lfs_of(app, label, false))
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
        let lock = v.as_ref().map(|v| v.write_lock(&root));
        let _write = lock.as_ref().map(|l| l.lock());
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

// ---- sync ------------------------------------------------------------------------------------------

/// "Sync now": commits the pending changes, fetches, replays, pushes (the pause does not apply).
#[tauri::command]
#[specta::specta]
pub async fn git_sync_now<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        if !super::sync::ready(&root, true) {
            return Err(AppError::Refused("Add a remote to sync".into()));
        }
        super::sync::run(&app, &label, super::sync::Mode::Manual);
        status_of(&app, &label, false)
    })
    .await
}

/// Pauses or resumes the sync (device-local); versions go on.
#[tauri::command]
#[specta::specta]
pub async fn git_set_sync_paused<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    paused: bool,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        git::state::set_sync_paused(&root, paused)?;
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// The transport for the window's vault, or why there is none.
fn transport_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    root: &std::path::Path,
) -> Result<(transport::Exec, Option<transport::Helper>), AppError> {
    let exec = super::sync::exec_of(app)
        .ok_or_else(|| AppError::Refused("Version history is turned off".into()))?;
    Ok((exec, super::sync::helper_for(app, root)))
}

fn transport_error(e: transport::TransportError) -> AppError {
    AppError::Refused(e.line)
}

/// Links `url` as the vault's remote (SSH or HTTPS), then syncs once so the existing history is
/// pushed. A password in the URL is refused: the token goes in Sign in.
#[tauri::command]
#[specta::specta]
pub async fn git_remote_set<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    url: String,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        if !git::is_set_up(&root) {
            return Err(AppError::Refused("Version history is not set up".into()));
        }
        let (exec, helper) = transport_of(&app, &root)?;
        let t = Transport {
            exec: &exec,
            root: &root,
            helper: helper.as_ref(),
            secrets: Vec::new(),
        };
        t.set_remote(&url).map_err(transport_error)?;
        log::info!(target: "git", "git: remote linked");
        link_done(&app, &label)
    })
    .await
}

/// After a remote was linked: forget the last sync's failure and sync once, now.
fn link_done<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<GitStatus, AppError> {
    if let Some(v) = runtime::vaults(app) {
        v.end_sync_record_reset(label);
    }
    super::sync::run(app, label, super::sync::Mode::Manual);
    status_of(app, label, false)
}

/// Unlinks the remote: back to local history (nothing is deleted anywhere).
#[tauri::command]
#[specta::specta]
pub async fn git_remote_remove<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        let (exec, helper) = transport_of(&app, &root)?;
        let t = Transport {
            exec: &exec,
            root: &root,
            helper: helper.as_ref(),
            secrets: Vec::new(),
        };
        t.remove_remote().map_err(transport_error)?;
        if let Some(v) = runtime::vaults(&app) {
            v.end_sync_record_reset(&label);
        }
        log::info!(target: "git", "git: remote unlinked");
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// What the machine has for git, for the setup page.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    /// `git` is installed.
    pub git: bool,
    /// Every forge CLI of the table ([`forge::FORGES`]) and what the machine has of it.
    pub forges: Vec<ForgeRow>,
    /// macOS: "Install Command Line Tools" is offered when git is missing.
    pub can_install_git: bool,
}

/// One forge CLI for the setup page: its labels (written once, in the table) and its state.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRow {
    /// `gh` or `fj`: what `git_sign_in` and `git_set_credentials` take.
    pub id: String,
    /// "GitHub CLI".
    pub label: String,
    /// "Sign in with GitHub".
    pub sign_in: String,
    /// "Install GitHub CLI".
    pub install: String,
    pub install_url: String,
    /// "gh auth login".
    pub login: String,
    /// `missing`, `signed-out` or `signed-in`.
    pub state: String,
    /// The hosts it is signed in to; empty when it works on its own default host.
    pub hosts: Vec<String>,
}

fn forge_row(exec: &transport::Exec, f: &Forge) -> ForgeRow {
    let probe = forge::probe(exec, f);
    ForgeRow {
        id: f.id.into(),
        label: f.label.into(),
        sign_in: f.sign_in(),
        install: f.install(),
        install_url: f.install_url.into(),
        login: f.login.into(),
        state: probe.state.arg().into(),
        hosts: probe.hosts,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn git_tools<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Tools, AppError> {
    blocking(move || {
        let exec = super::sync::exec_of(&app)
            .ok_or_else(|| AppError::Refused("Version history is turned off".into()))?;
        let git_ok = exec
            .run(
                exec.program("git", &["--version"]),
                transport::QUICK_TIMEOUT,
            )
            .is_ok_and(|o| o.ok());
        Ok(Tools {
            git: git_ok,
            forges: forge::FORGES.iter().map(|f| forge_row(&exec, f)).collect(),
            can_install_git: !git_ok && cfg!(target_os = "macos"),
        })
    })
    .await
}

/// macOS: starts Apple's installer for the Command Line Tools (which include git).
#[tauri::command]
#[specta::specta]
pub async fn git_install_git<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), AppError> {
    blocking(move || {
        if !cfg!(target_os = "macos") {
            return Err(AppError::Refused("Install git from git-scm.com".into()));
        }
        let exec = super::sync::exec_of(&app)
            .ok_or_else(|| AppError::Refused("Version history is turned off".into()))?;
        // the installer is a window of its own; the command returns at once
        exec.run(
            exec.program("xcode-select", &["--install"]),
            transport::QUICK_TIMEOUT,
        )
        .map(drop)
        .map_err(|_| AppError::Refused("Could not start the installer".into()))
    })
    .await
}

/// One step of "Sign in with ...", as the panel lists it.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepRow {
    /// `remote`, `credential` or `push`.
    pub id: String,
    /// `done`, `failed` or `pending` (an earlier step failed).
    pub state: String,
    /// What was linked, who answers, "Synced", or why it failed.
    pub line: String,
    /// What failed (`auth`, `offline`, `local-network`, `taken`, `other` ...), empty when it did
    /// not: what a "Show logs" button switches on.
    pub kind: String,
}

/// What "Sign in with ..." did: the steps in order and the fresh status.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignInResult {
    pub steps: Vec<StepRow>,
    /// The repository name the host already has: offer "Link existing <name>" or another name.
    pub taken: Option<String>,
    pub status: GitStatus,
}

/// "Sign in with GitHub" / "Sign in with Forgejo" ([`git::signin`]): the remote (reused, created
/// or linked), the credential and the first push, one step after the other, the first failure
/// stopping it. `host` for a CLI signed in to several; `name` and `link_existing` after a taken
/// name.
#[tauri::command]
#[specta::specta]
pub async fn git_sign_in<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    forge: String,
    host: Option<String>,
    name: Option<String>,
    link_existing: bool,
) -> Result<SignInResult, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        if !git::is_set_up(&root) {
            return Err(AppError::Refused("Version history is not set up".into()));
        }
        let f = forge::by_id(&forge).ok_or_else(|| AppError::Refused("Choose a CLI".into()))?;
        let (exec, _) = transport_of(&app, &root)?;
        let probe = forge::probe(&exec, f);
        match probe.state {
            State::Missing => return Err(AppError::Refused(format!("{} first", f.install()))),
            State::SignedOut => return Err(AppError::Refused(format!("Run {} first", f.login))),
            State::SignedIn => {}
        }
        // a CLI signed in to several hosts works on the one asked for, never a guessed one
        let host = if probe.hosts.is_empty() {
            None
        } else {
            let asked = host.as_deref().unwrap_or_default();
            Some(
                probe
                    .hosts
                    .iter()
                    .find(|h| h.eq_ignore_ascii_case(asked))
                    .ok_or_else(|| AppError::Refused("Choose a host".into()))?
                    .as_str(),
            )
        };
        let request = git::signin::Request {
            forge: f,
            host,
            name: name.as_deref(),
            link_existing,
        };
        let outcome = git::signin::run(
            &exec,
            &root,
            &request,
            &|| super::sync::helper_for(&app, &root),
            &|| super::sync::first_push(&app, &label),
        );
        log::info!(
            target: "git",
            "git: sign in with {}: {}",
            f.label,
            outcome
                .steps
                .iter()
                .map(|s| format!("{} {}", s.id.name(), s.state.name()))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        Ok(SignInResult {
            steps: outcome
                .steps
                .into_iter()
                .map(|s| StepRow {
                    id: s.id.name().into(),
                    state: s.state.name().into(),
                    line: s.line,
                    kind: s.kind.into(),
                })
                .collect(),
            taken: outcome.taken,
            status: status_of(&app, &label, false)?,
        })
    })
    .await
}

/// Chooses where HTTPS passwords come from for this vault: `token` (the secret) or a forge CLI.
#[tauri::command]
#[specta::specta]
pub async fn git_set_credentials<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    source: String,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        let source = Source::parse(&source)
            .ok_or_else(|| AppError::Refused("Choose token or a CLI".into()))?;
        git::state::set_credential_source(&root, source)?;
        // the credential answers the host of the remote it was chosen for, and no other
        let host = Repo::open(&root)
            .ok()
            .flatten()
            .and_then(|r| r.config_string(&format!("remote.{}.url", transport::REMOTE)))
            .and_then(|u| transport::https_host(&u));
        git::state::set_token_host(&root, host)?;
        if let Some(v) = runtime::vaults(&app) {
            v.end_sync_record_reset(&label);
            v.request_sync(&label);
        }
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// The user's choice for a plugin whose settings look like they hold a token: `allow` ("Sync
/// anyway": this file, until its token values change) or `never` (the file joins the managed
/// `.gitignore` block).
#[tauri::command]
#[specta::specta]
pub async fn git_plugin_decision<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    plugin: String,
    choice: String,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        if plugin.is_empty() || plugin.contains(['/', '\\']) || plugin.starts_with('.') {
            return Err(AppError::Refused("Unknown plugin".into()));
        }
        match choice.as_str() {
            "allow" => plugin_scan::allow(&root, &plugin)?,
            "never" => plugin_scan::never(&root, &plugin)?,
            _ => return Err(AppError::Refused("Choose Sync anyway or Never sync".into())),
        }
        // the settings are a version now (allow) or no longer pending (never): save and sync
        let _ = runtime::commit_user_now(&app, &label);
        if let Some(v) = runtime::vaults(&app) {
            v.request_sync(&label);
        }
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// Forgets the notices about copies and restored files ("Dismiss").
#[tauri::command]
#[specta::specta]
pub async fn git_dismiss_notices<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = window_root(&app, &label)?;
        let v = runtime::vaults(&app);
        let lock = v.as_ref().map(|v| v.write_lock(&root));
        let _write = lock.as_ref().map(|l| l.lock());
        git::conflicts::dismiss_notices(&root)?;
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}

/// The result of merging a note's text three ways.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergedText {
    /// The merged text; `None` when the two sides overlap (the caller keeps what the user has).
    pub text: Option<String>,
}

/// Merges `mine` and `theirs` against `base` with the engine's merge (front matter per property,
/// body by lines): how an open note takes a fetched change without losing what the user typed.
#[tauri::command]
#[specta::specta]
pub async fn git_merge_text<R: Runtime>(
    _app: tauri::AppHandle<R>,
    path: String,
    base: String,
    mine: String,
    theirs: String,
) -> Result<MergedText, AppError> {
    blocking(move || {
        let merged = git::merge::merge_file(
            &path,
            Some(base.as_bytes()),
            Some(mine.as_bytes()),
            Some(theirs.as_bytes()),
        );
        Ok(MergedText {
            text: match merged {
                git::merge::Merged::Clean { bytes: Some(b), .. } => String::from_utf8(b).ok(),
                _ => None,
            },
        })
    })
    .await
}

// ---- the merge view ----------------------------------------------------------------------------

/// A front matter property both sides changed differently: its entry on each side (`None`: absent).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRow {
    pub name: String,
    pub base: Option<String>,
    pub mine: Option<String>,
    pub theirs: Option<String>,
}

/// An overlap of the body: the lines each side made of the same base lines.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HunkRow {
    pub base: String,
    pub mine: String,
    pub theirs: String,
}

/// A piece of the body in order: settled text (`conflict` is `None`) or an overlap (`text` empty).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartRow {
    pub text: String,
    pub conflict: Option<HunkRow>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictViewRow {
    /// Vault-relative: where the user's version is.
    pub path: String,
    /// Where the other side's version is when it differs (a rename): the choice of name.
    pub theirs_path: Option<String>,
    pub markdown: bool,
    /// The user's version as the view opened; Save sends it back.
    pub mine: String,
    pub properties: Vec<PropertyRow>,
    pub parts: Vec<PartRow>,
}

/// A property decided in the merge view.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickRow {
    pub name: String,
    /// `mine` or `theirs`.
    pub side: String,
}

fn resolve_refused(e: resolve::Error) -> AppError {
    match e {
        resolve::Error::Io(e) => AppError::from(e),
        other => AppError::Refused(other.to_string()),
    }
}

/// The confined, vault-relative path of a conflicted file.
pub(super) fn conflict_target(
    app: &tauri::AppHandle<impl Runtime>,
    label: &str,
    path: &str,
) -> Result<(PathBuf, String), AppError> {
    let root = window_root(app, label)?;
    if !git::is_set_up(&root) {
        return Err(AppError::Refused("Version history is not set up".into()));
    }
    let rel = vault_ops::confine(&root, path)
        .map_err(|e| AppError::Refused(e.to_string()))?
        .rel;
    Ok((root, rel))
}

/// The three-column view of a file a sync could not merge: settled text and overlaps, the
/// properties to choose. `mine` is the editor's buffer when the note is open (what the user sees);
/// without it the file is read. Writes nothing.
#[tauri::command]
#[specta::specta]
pub async fn git_conflict_open<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    mine: Option<String>,
) -> Result<ConflictViewRow, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, rel) = conflict_target(&app, &label, &path)?;
        let v = resolve::open(&root, &rel, mine.as_deref()).map_err(resolve_refused)?;
        Ok(ConflictViewRow {
            path: v.path,
            theirs_path: v.theirs_path,
            markdown: v.markdown,
            mine: v.mine,
            properties: v
                .properties
                .into_iter()
                .map(|p| PropertyRow {
                    name: p.name,
                    base: p.base,
                    mine: p.mine,
                    theirs: p.theirs,
                })
                .collect(),
            parts: v
                .parts
                .into_iter()
                .map(|p| match p {
                    Part::Text(text) => PartRow {
                        text,
                        conflict: None,
                    },
                    Part::Conflict(c) => PartRow {
                        text: String::new(),
                        conflict: Some(HunkRow {
                            base: c.base,
                            mine: c.mine,
                            theirs: c.theirs,
                        }),
                    },
                })
                .collect(),
        })
    })
    .await
}

/// Runs one resolution under the repository's write lock, counted as busy, with the editors told
/// which files change first; afterwards the status changed and the sync is asked to resume.
pub(super) fn resolving<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    root: &std::path::Path,
    run: impl FnOnce(resolve::Announce<'_>) -> Result<(), resolve::Error>,
) -> Result<GitStatus, AppError> {
    let v = runtime::vaults(app);
    let _busy = v.as_ref().map(|v| v.busy_guard());
    let lock = v.as_ref().map(|v| v.write_lock(root));
    let _write = lock.as_ref().map(|l| l.lock());
    let told = parking_lot::Mutex::new(Vec::<String>::new());
    let announce = |paths: &[String]| {
        told.lock().extend(paths.iter().cloned());
        runtime::emit_applying(app, label, paths, false);
    };
    let result = run(&announce);
    // the editors release what they held, written or not
    runtime::emit_applying(app, label, &told.lock(), true);
    result.map_err(|e| {
        if let Some(v) = &v {
            v.identity.forget(root);
        }
        resolve_refused(e)
    })?;
    log::info!(target: "git", "git: a conflict was resolved");
    if let Some(v) = &v {
        v.request_sync(label);
    }
    let _ = app.emit_to(label, runtime::CHANGED_EVENT, ());
    status_of(app, label, false)
}

/// "Save" in the merge view: the result column (and the side taken for each conflicting property,
/// and the name kept after a rename) is written, committed as `user(merge)` and the sync resumes.
#[tauri::command]
#[specta::specta]
pub async fn git_conflict_save<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    mine: String,
    body: String,
    picks: Vec<PickRow>,
    final_path: Option<String>,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, rel) = conflict_target(&app, &label, &path)?;
        let picks: Vec<(String, Side)> = picks
            .into_iter()
            .map(|p| match p.side.as_str() {
                "theirs" => Ok((p.name, Side::Theirs)),
                "mine" => Ok((p.name, Side::Mine)),
                _ => Err(AppError::Refused("Choose mine or theirs".into())),
            })
            .collect::<Result<_, _>>()?;
        let final_path = final_path
            .map(|f| {
                vault_ops::confine(&root, &f)
                    .map(|c| c.rel)
                    .map_err(|e| AppError::Refused(e.to_string()))
            })
            .transpose()?;
        resolving(&app, &label, &root, |announce| {
            resolve::save(
                &root,
                &rel,
                &Choice {
                    mine: &mine,
                    body: &body,
                    picks: &picks,
                    final_path: final_path.as_deref(),
                },
                &device::name(),
                Some(announce),
            )
        })
    })
    .await
}

/// Settles a whole file by taking one side (`mine`, `theirs`, or `both` for a binary).
#[tauri::command]
#[specta::specta]
pub async fn git_conflict_take<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    side: String,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, rel) = conflict_target(&app, &label, &path)?;
        let side = Take::parse(&side)
            .ok_or_else(|| AppError::Refused("Choose mine, theirs or both".into()))?;
        resolving(&app, &label, &root, |announce| {
            resolve::take(&root, &rel, side, &device::name(), Some(announce))
        })
    })
    .await
}

/// An open note whose unsaved text overlaps what a sync just wrote (the editor's apply found it,
/// `web/lib/remote-apply.ts`): the conflict is recorded (base: the text the editor last saved) and
/// the buffer `mine` written to disk, under the write lock, so the note bar shows and no automatic
/// commit takes the user's text over the other device's.
#[tauri::command]
#[specta::specta]
pub async fn git_conflict_record<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    base: String,
    mine: String,
) -> Result<GitStatus, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (root, rel) = conflict_target(&app, &label, &path)?;
        let v = runtime::vaults(&app);
        let _busy = v.as_ref().map(|v| v.busy_guard());
        let lock = v.as_ref().map(|v| v.write_lock(&root));
        let _write = lock.as_ref().map(|l| l.lock());
        git::sync::record_editor_conflict(&root, &rel, &base, &mine)
            .map_err(|e| AppError::Refused(super::sync::failure_line(&e)))?;
        log::info!(target: "git", "git: an open note kept its text over a synced change (conflict)");
        let _ = app.emit_to(&label, runtime::CHANGED_EVENT, ());
        status_of(&app, &label, false)
    })
    .await
}
