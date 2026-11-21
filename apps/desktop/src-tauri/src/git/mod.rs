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
//! - `history.rs`: file versions, deleted files, diffs and Restore (shared text diff);
//! - `state.rs`: the pause and stop flags; `device.rs`: the device name.
//!
//! [`setup`] and [`commit_user`] are the two operations the app and the CLI share.

pub mod conflicts;
pub mod credential;
pub mod device;
pub mod gh;
pub mod history;
pub mod ignore;
pub mod merge;
pub mod message;
pub mod plugin_scan;
pub mod renames;
pub mod repo;
pub mod resolve;
pub mod scheduler;
pub mod state;
pub mod sync;
pub(crate) mod system;
#[cfg(test)]
mod tests;
pub mod transport;

pub use message::Change;
pub use repo::{Error, Identities, Identity, LogEntry, Repo, Result};

use message::{Message, Scope, TemplateCtx};
use std::path::Path;
use sync::RemoteInfo;

/// How the vault gets its history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    /// `git init` when the vault is not a repository.
    LocalOnly,
    /// The vault already is a repository; its history and branch are kept as they are.
    Existing,
}

/// A merge, rebase or the like that the user (or a tool) has under way in the repository: Writer
/// commits nothing while one is, and the vault resumes by itself when the markers go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Merge,
    CherryPick,
    Revert,
    Rebase,
    Bisect,
    DetachedHead,
}

impl Operation {
    /// `merge in progress`, `detached HEAD` ...
    pub fn label(self) -> &'static str {
        match self {
            Operation::Merge => "merge in progress",
            Operation::CherryPick => "cherry-pick in progress",
            Operation::Revert => "revert in progress",
            Operation::Rebase => "rebase in progress",
            Operation::Bisect => "bisect in progress",
            Operation::DetachedHead => "detached HEAD",
        }
    }
}

/// What the repository at `root` is in the middle of, read from the markers git leaves in `.git`
/// (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`,
/// `BISECT_LOG`) and from a `HEAD` that names no branch. `None` when it is idle (or not a
/// repository with its own `.git` folder).
pub fn operation(root: &Path) -> Option<Operation> {
    let dir = root.join(".git");
    if !dir.is_dir() {
        return None;
    }
    const MARKERS: [(&str, Operation); 6] = [
        ("MERGE_HEAD", Operation::Merge),
        ("CHERRY_PICK_HEAD", Operation::CherryPick),
        ("REVERT_HEAD", Operation::Revert),
        ("rebase-merge", Operation::Rebase),
        ("rebase-apply", Operation::Rebase),
        ("BISECT_LOG", Operation::Bisect),
    ];
    if let Some((_, op)) = MARKERS.iter().find(|(m, _)| dir.join(m).exists()) {
        return Some(*op);
    }
    let head = std::fs::read_to_string(dir.join("HEAD")).ok()?;
    let head = head.trim();
    (!head.is_empty() && !head.starts_with("ref:")).then_some(Operation::DetachedHead)
}

/// A vault is set up when it is a repository holding Writer's managed ignore block.
/// and the user has not chosen "Stop version history" for it.
pub fn is_set_up(root: &Path) -> bool {
    root.join(".git").exists()
        && std::fs::read_to_string(root.join(".gitignore")).is_ok_and(|t| ignore::has_block(&t))
        && !state::stopped(root)
}

/// A folder above the vault is a repository (a docs folder in a code repo): Writer never sets
/// history up there by itself, and never commits into that repository.
pub fn in_parent_repo(root: &Path) -> bool {
    root.ancestors()
        .skip(1)
        .any(|dir| dir.join(".git").exists())
}

/// What [`auto_setup`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auto {
    /// The vault was already set up.
    Already,
    /// The user chose "Stop version history" for this vault.
    Stopped,
    /// A folder above the vault is a repository: the user chooses (never a silent commit there).
    InParentRepo,
    /// A merge, rebase or the like is under way in the repository: nothing is written.
    Paused,
    /// The vault is now set up. `committed` is false when git has no identity (the first commit
    /// comes with the first commit after the user sets one) or when the vault was already a
    /// repository (no extra commit until there are changes).
    Done { committed: bool },
}

/// Sets a vault up by default when it opens (spec "Setup", the user 2026-11-20): a vault that is
/// itself a repository is used as it is (the managed ignore block is written, no commit); one
/// inside another repository is left for the user to choose; any other gets `git init`, the ignore
/// block and the first commit `chore(setup)`. No identity: the repository and the block are made
/// but no commit, and the "Set your git name and email" state follows.
pub fn auto_setup(root: &Path, device: &str) -> Result<Auto> {
    if state::stopped(root) {
        return Ok(Auto::Stopped);
    }
    if is_set_up(root) {
        return Ok(Auto::Already);
    }
    if operation(root).is_some() {
        return Ok(Auto::Paused);
    }
    if let Some(repo) = Repo::open(root)? {
        let _ = repo;
        ignore::ensure(root)?;
        return Ok(Auto::Done { committed: false });
    }
    if in_parent_repo(root) {
        return Ok(Auto::InParentRepo);
    }
    let repo = Repo::init(root)?;
    ignore::ensure(root)?;
    finish_setup(&repo, device)
}

/// The first commit of a freshly made repository, when git has an identity for it.
fn finish_setup(repo: &Repo, device: &str) -> Result<Auto> {
    if repo.identities().is_err() {
        return Ok(Auto::Done { committed: false });
    }
    let changes = repo.changes()?;
    let message = Message::chore(Scope::Setup, "start version history", device);
    repo.commit(&changes, &message)?;
    Ok(Auto::Done { committed: true })
}

/// "Stop version history" for one vault: Writer forgets its setup (device-local), commits nothing
/// more by itself and does not set the vault up again. `.git` and the history stay untouched.
pub fn stop(root: &Path) -> std::io::Result<()> {
    state::set_stopped(root, true)
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
    state::set_stopped(root, false)?;
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

/// Whether a remote is linked (`remote.origin.url`).
pub fn has_remote(repo: &Repo) -> bool {
    repo.config_string(&format!("remote.{}.url", transport::REMOTE))
        .is_some()
}

/// Splits `changes` into what a version may hold and the plugin settings the token scan holds back.
/// Never in a version: a file the last sync could not settle (`conflicts.json`) and, while a remote
/// is linked, a plugin's `data.json` that looks like it holds a token (spec "Plugin settings and
/// secrets"). Both stay on disk as pending changes the status does not count.
fn committable(
    root: &Path,
    repo: &Repo,
    changes: Vec<Change>,
) -> (Vec<Change>, Vec<plugin_scan::Held>) {
    let blocked = conflicts::paths(root);
    let scan = has_remote(repo);
    let held = if scan {
        plugin_scan::held_among(
            root,
            changes
                .iter()
                .filter(|c| !matches!(c, Change::Delete(_)))
                .map(|c| c.path()),
        )
    } else {
        Vec::new()
    };
    let keep = changes
        .into_iter()
        .filter(|c| {
            !blocked.iter().any(|b| b == c.path()) && !held.iter().any(|h| h.path == c.path())
        })
        .collect();
    (keep, held)
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
    let (changes, _) = committable(root, &repo, repo.changes()?);
    if changes.is_empty() {
        return Ok(None);
    }
    // the first commit of an empty repository is the setup commit (an automatic setup that had no
    // git identity yet)
    let message = if repo.has_commits() {
        Message::user(&changes, template, ctx, device)
    } else {
        Message::chore(Scope::Setup, "start version history", device)
    };
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
    let changes: Vec<Change> = committable(root, &repo, repo.changes()?)
        .0
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
    /// A folder above the vault is a repository: setup is the user's choice.
    pub parent_repo: bool,
    /// The user chose "Stop version history" for this vault.
    pub stopped: bool,
    /// A merge, rebase or the like is under way: Writer commits nothing until it is over.
    pub operation: Option<Operation>,
    pub paused: bool,
    pub changes: Vec<Change>,
    /// Committer time of HEAD, seconds.
    pub last_commit: Option<i64>,
    /// Files over the size Writer versions (no LFS yet), vault-relative.
    pub too_large: Vec<String>,
    /// The identity problem that would stop a commit, if any.
    pub identity_error: bool,
    /// The remote, ahead and behind; `url: None` without one.
    pub remote: RemoteInfo,
    pub sync_paused: bool,
    /// Files the last sync could not settle: their version stays on disk, never committed.
    pub conflicts: Vec<conflicts::Record>,
    /// Binaries kept beside the remote's version, `(file, copy)`.
    pub copies: Vec<(String, String)>,
    /// Files restored because one side deleted what the other edited.
    pub restored: Vec<String>,
    /// Plugin settings the token scan holds back from versions and from the push.
    pub held: Vec<plugin_scan::Held>,
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
            parent_repo: in_parent_repo(root),
            stopped: state::stopped(root),
            operation: None,
            paused: false,
            changes: Vec::new(),
            last_commit: None,
            too_large: Vec::new(),
            identity_error: false,
            remote: RemoteInfo::default(),
            sync_paused: false,
            conflicts: Vec::new(),
            copies: Vec::new(),
            restored: Vec::new(),
            held: Vec::new(),
        });
    };
    let (raw, too_large) = repo.changes_and_skipped()?;
    // a conflict the user settled (the file is back at HEAD's version, or gone) is forgotten
    let mut book = conflicts::read(root);
    let open: Vec<conflicts::Record> = book
        .files
        .iter()
        .filter(|r| raw.iter().any(|c| c.path() == r.path))
        .cloned()
        .collect();
    if open.len() != book.files.len() {
        book.files = open.clone();
        let _ = conflicts::write(root, &book);
    }
    let (changes, held) = committable(root, &repo, raw);
    Ok(Status {
        has_repo: true,
        set_up: is_set_up(root),
        parent_repo: in_parent_repo(root),
        stopped: state::stopped(root),
        operation: operation(root),
        paused: state::paused(root),
        changes,
        last_commit: repo.last_commit_time(),
        too_large,
        identity_error: identity.is_missing(&repo, refresh),
        remote: sync::remote_info(root),
        sync_paused: state::sync_paused(root),
        conflicts: open,
        copies: book.copies,
        restored: book.restored,
        held,
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
