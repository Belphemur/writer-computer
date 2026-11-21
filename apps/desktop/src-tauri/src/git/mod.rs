//! Local version history for a vault: the engine behind the built-in feature `git` (ADR
//! 2026-11-18 "sync vaults with a built-in Git feature", spec `SPECs/git-sync-spec.md`; phase 1 is
//! local history only, no remote and no network). Tauri-free, so the app and the `writer git:*`
//! CLI commands (and through them the MCP tools and the agent skill) run the same code.
//!
//! This module is the only code that names `gix` (a test scans the sources for it):
//!
//! - `repo.rs`: open, init, status, commit of a set of paths, history of a path, the commit
//!   identity exactly as `git commit` resolves it (never guessed);
//! - `message.rs`: the commit message builder (`type(scope): subject` plus trailers) and its reader;
//! - `ignore.rs`: the managed block of the vault's `.gitignore`;
//! - `scheduler.rs`: the cadence state machine (pure, time is an argument);
//! - `system.rs`: `git var`, the commit identity from the installed git (the one child process);
//! - `state.rs`: the pause flag; `device.rs`: the device name.
//!
//! [`setup`] and [`commit_user`] are the two operations the app and the CLI share.

pub mod device;
pub mod ignore;
pub mod message;
pub mod repo;
pub mod scheduler;
pub mod state;
pub(crate) mod system;
#[cfg(test)]
mod tests;

pub use message::Change;
pub use repo::{Error, Identities, Identity, LogEntry, Repo, Result};

use message::{Message, Scope, TemplateCtx};
use std::path::Path;

/// How the vault gets its history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    /// `git init` when the vault is not a repository.
    LocalOnly,
    /// The vault already is a repository; its history and branch are kept as they are.
    Existing,
}

/// A vault is set up when it is a repository holding Writer's managed ignore block.
pub fn is_set_up(root: &Path) -> bool {
    root.join(".git").exists()
        && std::fs::read_to_string(root.join(".gitignore")).is_ok_and(|t| ignore::has_block(&t))
}

/// Sets the vault up: the repository, the ignore block, and the first commit (`chore(setup)`) of a
/// repository with no history, or a `chore(ignore)` commit of the `.gitignore` alone when the
/// block changed. Fails with [`Error::NoIdentity`] before writing anything into the vault when git
/// has no name and email (a `git init` done by this call stays: it is what the user asked for).
pub fn setup(root: &Path, mode: SetupMode, device: &str) -> Result<()> {
    let repo = match mode {
        SetupMode::LocalOnly => Repo::init(root)?,
        SetupMode::Existing => Repo::open(root)?.ok_or(Error::NotARepo)?,
    };
    repo.identities()?;
    let ignore_changed = ignore::ensure(root)?;
    if !repo.has_commits() {
        let changes = repo.changes()?;
        let message = Message::chore(Scope::Setup, "start version history", device);
        repo.commit(&changes, &message)?;
    } else if ignore_changed {
        let message = Message::chore(Scope::Ignore, "update ignored files", device);
        repo.commit(&[Change::Edit(".gitignore".into())], &message)?;
    }
    Ok(())
}

/// Commits the user's pending changes. `None` when there is nothing to commit.
pub fn commit_user(
    root: &Path,
    template: &str,
    ctx: &TemplateCtx,
    device: &str,
) -> Result<Option<String>> {
    let Some(repo) = Repo::open(root)? else {
        return Ok(None);
    };
    let changes = repo.changes()?;
    if changes.is_empty() {
        return Ok(None);
    }
    let message = Message::user(&changes, template, ctx, device);
    repo.commit(&changes, &message).map(Some)
}

/// Commits the files a finished agent turn changed (those still different from HEAD). `None` when
/// none of them is.
pub fn commit_agent(
    root: &Path,
    turn: &scheduler::AgentTurn,
    fallback_title: &str,
    device: &str,
) -> Result<Option<String>> {
    let Some(repo) = Repo::open(root)? else {
        return Ok(None);
    };
    let touched: std::collections::BTreeSet<&str> = turn.files.iter().map(String::as_str).collect();
    let changes: Vec<Change> = repo
        .changes()?
        .into_iter()
        .filter(|c| match c {
            Change::Move { from, to } => {
                touched.contains(from.as_str()) || touched.contains(to.as_str())
            }
            other => touched.contains(other.path()),
        })
        .collect();
    if changes.is_empty() {
        return Ok(None);
    }
    let title = if turn.title.trim().is_empty() {
        fallback_title
    } else {
        &turn.title
    };
    let message = Message::agent(&changes, title, turn.info(), device);
    repo.commit(&changes, &message).map(Some)
}

/// The vault's state for the status item and `writer git:status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The vault is a repository (set up by Writer or not).
    pub has_repo: bool,
    pub set_up: bool,
    pub paused: bool,
    pub changes: Vec<Change>,
    /// Committer time of HEAD, seconds.
    pub last_commit: Option<i64>,
    /// The identity problem that would stop a commit, if any.
    pub identity_error: bool,
}

/// Whether git has an identity for a vault, remembered per vault so the status poll does not run
/// `git var` every few seconds. Refreshed when the settings page opens and when a commit fails
/// (`status(.., refresh = true)`, [`IdentityCache::forget`]). Owned by the caller (the feature's
/// `Vaults`, or a CLI command's own), never a static.
#[derive(Default)]
pub struct IdentityCache {
    missing: parking_lot::Mutex<std::collections::HashMap<std::path::PathBuf, bool>>,
}

impl IdentityCache {
    pub fn forget(&self, root: &Path) {
        self.missing.lock().remove(root);
    }

    fn is_missing(&self, repo: &Repo, refresh: bool) -> bool {
        if !refresh {
            if let Some(known) = self.missing.lock().get(repo.root()) {
                return *known;
            }
        }
        let missing = matches!(repo.identities(), Err(Error::NoIdentity));
        self.missing
            .lock()
            .insert(repo.root().to_path_buf(), missing);
        missing
    }
}

pub fn status(root: &Path, identity: &IdentityCache, refresh: bool) -> Result<Status> {
    let Some(repo) = Repo::open(root)? else {
        return Ok(Status {
            has_repo: false,
            set_up: false,
            paused: false,
            changes: Vec::new(),
            last_commit: None,
            identity_error: false,
        });
    };
    Ok(Status {
        has_repo: true,
        set_up: is_set_up(root),
        paused: state::paused(root),
        changes: repo.changes()?,
        last_commit: repo.last_commit_time(),
        identity_error: identity.is_missing(&repo, refresh),
    })
}

/// Placeholder values for a message written now: the local date and time, and the device name.
pub fn template_ctx(device: &str) -> TemplateCtx {
    let now = gix_now();
    TemplateCtx {
        date: now.chars().take(16).collect(),
        hostname: device.to_string(),
    }
}

/// `2026-11-20 14:03:00 -0500`
fn gix_now() -> String {
    repo::now_iso()
}
