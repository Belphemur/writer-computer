//! The running half of the feature: which windows have a vault, the cadence of each (the pure
//! state machine is `crate::git::scheduler`), the one ticker thread and the reactions to the
//! agent's points. The commits themselves are `crate::git`; nothing here names `gix`.
//!
//! Everything that writes to a repository runs outside the state's lock, on a thread that may
//! block: the ticker, a hook's caller (the agent's `turn-started` is emitted from a blocking
//! thread) or a command through `commands::blocking`.

use crate::agent::api::{FileChange, FileChangeKind, TurnFinished, TurnStarted};
use crate::git::scheduler::{Action, AgentTurn, Cadence};
use crate::git::{self, device, ignore, state as pause_state};
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const CHANGED_EVENT: &str = "git:changed";
pub const COMMIT_AFTER: &str = "git.commit-after";
pub const AGENT_COMMITS: &str = "git.agent-commits";
pub const COMMIT_MESSAGE: &str = "git.commit-message";

/// The settings the cadence reads, per window, every time they are needed (a change applies at once).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `None`: Manual.
    pub quiet: Option<Duration>,
    pub agent_commits: bool,
    pub template: String,
}

impl Config {
    pub fn from_lookup(get: impl Fn(&str) -> Option<crate::config::ConfigValue>) -> Config {
        let quiet = match get(COMMIT_AFTER)
            .as_ref()
            .and_then(|v| v.as_str().map(str::to_owned))
        {
            Some(s) => match s.as_str() {
                "30s" => Some(Duration::from_secs(30)),
                "5min" => Some(Duration::from_secs(300)),
                "manual" => None,
                _ => Some(Duration::from_secs(60)),
            },
            None => Some(Duration::from_secs(60)),
        };
        let agent_commits = !matches!(
            get(AGENT_COMMITS),
            Some(crate::config::ConfigValue::Bool(false))
        );
        let template = get(COMMIT_MESSAGE)
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| git::message::DEFAULT_TEMPLATE.to_string());
        Config {
            quiet,
            agent_commits,
            template,
        }
    }
}

struct Vault {
    root: PathBuf,
    cadence: Cadence,
    /// The automatic setup of this open vault has been tried (once per open).
    auto_done: bool,
    /// The last failure, one short line (never a path or text of the vault).
    error: Option<String>,
}

/// The one owner of the feature's runtime state, created in `start` and kept in the feature's
/// scope: the vaults and their cadence state and the flags the watcher observer and the point
/// handlers check. The ticker thread and the observer are the scope's; the points are retracted
/// when the scope stops. Everything answers nothing once this is [`shutdown`](Vaults::shutdown).
/// No statics hold feature state.
#[derive(Default)]
pub struct Vaults {
    inner: Mutex<HashMap<String, Vault>>,
    ticker: AtomicBool,
    stopped: AtomicBool,
    /// Whether git has an identity per vault (see `git::IdentityCache`).
    pub identity: git::IdentityCache,
    /// The file logs already built, per HEAD (`git::history::Cache`).
    pub history: git::history::Cache,
    /// Commits in progress.
    committing: AtomicUsize,
}

/// Counts a commit in progress for [`Vaults::busy`].
struct Busy<'a>(&'a AtomicUsize);

impl<'a> Busy<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Busy(counter)
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One short, safe line for a failure: git's own message could carry the vault's path.
pub fn error_line(e: &git::Error) -> String {
    match e {
        git::Error::NoIdentity => e.to_string(),
        git::Error::Operation(_) => e.to_string(),
        git::Error::NotARepo => "Not a Git repository".into(),
        git::Error::Git(_) => "Git failed".into(),
        git::Error::Io(_) => "Could not read or write the vault".into(),
    }
}

impl Vaults {
    /// A commit is running.
    pub fn busy(&self) -> bool {
        self.committing.load(Ordering::SeqCst) > 0
    }

    /// Counts a write to the repository (a restore) as busy until dropped.
    pub fn busy_guard(&self) -> impl Drop + '_ {
        Busy::new(&self.committing)
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Releases everything: the ticker ends at its next second, the observer and the points
    /// answer nothing, the extensions are retracted and the vaults are forgotten.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        crate::features::points::retract("git");
        self.inner.lock().clear();
    }

    pub fn open(&self, label: &str, root: &Path) {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        self.inner.lock().insert(
            label.to_string(),
            Vault {
                root,
                cadence: Cadence::new(),
                auto_done: false,
                error: None,
            },
        );
    }

    pub fn close(&self, label: &str) -> Option<PathBuf> {
        self.inner.lock().remove(label).map(|v| v.root)
    }

    pub fn labels(&self) -> Vec<String> {
        self.inner.lock().keys().cloned().collect()
    }

    pub fn root_of(&self, label: &str) -> Option<PathBuf> {
        self.inner.lock().get(label).map(|v| v.root.clone())
    }

    pub fn error_of(&self, label: &str) -> Option<String> {
        self.inner.lock().get(label).and_then(|v| v.error.clone())
    }

    pub fn set_error(&self, label: &str, error: Option<String>) {
        if let Some(v) = self.inner.lock().get_mut(label) {
            v.error = error;
        }
    }

    pub fn turn_running(&self, label: &str) -> bool {
        self.inner
            .lock()
            .get(label)
            .is_some_and(|v| v.cadence.turn_running())
    }

    /// The watcher saw these paths change in the window's vault.
    pub fn written(&self, label: &str, root: &Path, paths: &[PathBuf], now: Instant) {
        if self.stopped() {
            return;
        }
        let mut g = self.inner.lock();
        let Some(vault) = g.get_mut(label) else {
            return;
        };
        let counts = paths.iter().any(|p| {
            p.strip_prefix(root)
                .or_else(|_| p.strip_prefix(&vault.root))
                .ok()
                .and_then(|r| r.to_str())
                .is_some_and(|rel| !ignore::device_local(&rel.replace('\\', "/")))
        });
        if counts {
            vault.cadence.on_write(now);
        }
    }

    pub fn committed(&self, label: &str) {
        if let Some(v) = self.inner.lock().get_mut(label) {
            v.cadence.committed();
        }
    }

    /// The windows whose vault is `root`.
    fn labels_of(&self, root: &Path) -> Vec<String> {
        self.inner
            .lock()
            .iter()
            .filter(|(_, v)| v.root == root)
            .map(|(l, _)| l.clone())
            .collect()
    }

    fn with<T>(&self, label: &str, f: impl FnOnce(&mut Vault) -> T) -> Option<T> {
        self.inner.lock().get_mut(label).map(f)
    }
}

pub fn config_of<R: Runtime>(app: &AppHandle<R>, label: &str) -> Config {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    match guard.as_ref() {
        Some(s) => Config::from_lookup(|k| s.get(k).cloned()),
        None => Config::from_lookup(|_| None),
    }
}

/// The runtime of the started feature (kept in its scope), `None` while it is off.
pub(crate) fn vaults<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Vaults>> {
    crate::features::state_of::<R, Vaults>(app, "git")
}

fn announce<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let _ = app.emit_to(label, CHANGED_EVENT, ());
}

/// Commits the user's pending changes of `label`'s vault now. `Ok(true)` when a commit was made.
pub fn commit_user_now<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<bool, git::Error> {
    let Some(v) = vaults(app) else {
        return Ok(false);
    };
    let Some(root) = v.root_of(label) else {
        return Ok(false);
    };
    let _busy = Busy::new(&v.committing);
    let cfg = config_of(app, label);
    let dev = device::name();
    let result = git::commit_user(&root, &cfg.template, &git::template_ctx(&dev), &dev);
    v.committed(label);
    match &result {
        Ok(Some(_)) => {
            v.set_error(label, None);
            log::info!(target: "git", "git: committed the user's changes");
            announce(app, label);
        }
        Ok(None) => v.set_error(label, None),
        Err(git::Error::Operation(_)) => announce(app, label),
        Err(e) => {
            log::warn!(target: "git", "git: commit failed: {}", error_line(e));
            v.set_error(label, Some(error_line(e)));
            v.identity.forget(&root);
            announce(app, label);
        }
    }
    result.map(|c| c.is_some())
}

fn commit_agent<R: Runtime>(app: &AppHandle<R>, label: &str, turn: &AgentTurn) {
    let Some(v) = vaults(app) else { return };
    let Some(root) = v.root_of(label) else { return };
    let _busy = Busy::new(&v.committing);
    let dev = device::name();
    match git::commit_agent(&root, turn, "Agent turn", &dev) {
        Ok(Some(_)) => {
            v.set_error(label, None);
            log::info!(target: "git", "git: committed an agent turn");
            announce(app, label);
        }
        Ok(None) => {}
        Err(git::Error::Operation(_)) => announce(app, label),
        Err(e) => {
            log::warn!(target: "git", "git: agent commit failed: {}", error_line(&e));
            v.set_error(label, Some(error_line(&e)));
            v.identity.forget(&root);
            announce(app, label);
        }
    }
}

/// Whether the cadence may act in this window's vault: set up, not paused and no merge, rebase or
/// the like under way (it resumes by itself when the markers go).
fn active(root: &Path) -> bool {
    git::is_set_up(root) && !pause_state::paused(root) && git::operation(root).is_none()
}

/// Sets the vault of `label` up by default, once per open (spec "Setup": the user, 2026-11-20).
/// The first pass of the ticker after the vault opened does it, on the feature's own thread.
fn auto_setup_once<R: Runtime>(app: &AppHandle<R>, v: &Vaults, label: &str) {
    let Some(root) = v
        .with(label, |vault| {
            (!std::mem::replace(&mut vault.auto_done, true)).then(|| vault.root.clone())
        })
        .flatten()
    else {
        return;
    };
    let _busy = Busy::new(&v.committing);
    match git::auto_setup(&root, &device::name()) {
        Ok(git::Auto::Done { committed }) => {
            log::info!(target: "git", "git: set up version history (first commit: {committed})");
            v.identity.forget(&root);
            announce(app, label);
        }
        Ok(_) => {}
        Err(e) => {
            log::warn!(target: "git", "git: automatic setup failed: {}", error_line(&e));
            v.set_error(label, Some(error_line(&e)));
            announce(app, label);
        }
    }
}

/// One pass of the ticker over every window.
pub fn tick<R: Runtime>(app: &AppHandle<R>, now: Instant) {
    let Some(v) = vaults(app) else { return };
    for label in v.labels() {
        auto_setup_once(app, &v, &label);
        let cfg = config_of(app, &label);
        let action = v.with(&label, |vault| {
            let paused = !active(&vault.root);
            vault.cadence.tick(now, cfg.quiet, paused)
        });
        match action {
            Some(Action::CommitUser) => {
                let _ = commit_user_now(app, &label);
            }
            Some(Action::CommitAgent(turn)) => commit_agent(app, &label, &turn),
            _ => {}
        }
    }
}

/// Starts the ticker once (a thread of the feature, contained).
pub fn start_ticker<R: Runtime>(app: &AppHandle<R>) {
    let Some(v) = vaults(app) else { return };
    if v.ticker.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(scope) = crate::features::scope_of(app, "git") else {
        v.ticker.store(false, Ordering::SeqCst);
        return;
    };
    let handle = app.clone();
    let started = scope.spawn("git-cadence", move |token| {
        while token.sleep(Duration::from_secs(1)) {
            match vaults(&handle) {
                Some(v) if !v.stopped() => {}
                _ => break,
            }
            if crate::features::is_live_id(&handle, "git") {
                tick(&handle, Instant::now());
            }
        }
    });
    if let Err(e) = started {
        log::warn!(target: "git", "git: could not start the cadence thread: {e}");
        v.ticker.store(false, Ordering::SeqCst);
    }
}

/// The window is closing or the app is exiting: save what is pending (short, no agent commit
/// waits and nothing while a turn runs: its commit comes at the turn's end).
pub fn flush<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(v) = vaults(app) else { return };
    let Some(root) = v.root_of(label) else { return };
    if !active(&root) || v.turn_running(label) {
        return;
    }
    let _ = commit_user_now(app, label);
}

// ---- the agent's points -----------------------------------------------------------------------

/// `agent.turn-started`: save the user's pending edits, then mark the turn running (no user commit
/// until it ends), so the turn's commit holds only the agent's files.
pub fn turn_started<R: Runtime>(app: &AppHandle<R>, args: &TurnStarted) {
    let Some(v) = vaults(app).filter(|v| !v.stopped()) else {
        return;
    };
    let root = args
        .root
        .canonicalize()
        .unwrap_or_else(|_| args.root.clone());
    for label in v.labels_of(&root) {
        if active(&root) && !v.turn_running(&label) {
            let _ = commit_user_now(app, &label);
        }
        v.with(&label, |vault| vault.cadence.turn_started());
    }
}

fn touched(files: &[FileChange]) -> Vec<String> {
    let mut out = Vec::new();
    for f in files {
        out.push(f.path.clone());
        if f.kind == FileChangeKind::Move {
            out.extend(f.from.clone());
        }
    }
    out
}

/// `agent.turn-finished`: queue the turn's commit (the ticker runs it first, before the quiet timer).
pub fn turn_finished<R: Runtime>(app: &AppHandle<R>, args: &TurnFinished) {
    let Some(v) = vaults(app).filter(|v| !v.stopped()) else {
        return;
    };
    let root = args
        .root
        .canonicalize()
        .unwrap_or_else(|_| args.root.clone());
    for label in v.labels_of(&root) {
        let cfg = config_of(app, &label);
        let commit = (cfg.agent_commits && !args.files.is_empty()).then(|| AgentTurn {
            chat_id: args.chat_id.clone(),
            turn_id: args.turn_id.clone(),
            backend: args.backend.clone(),
            title: args.title.clone().unwrap_or_default(),
            models: args.models.clone(),
            files: touched(&args.files),
        });
        v.with(&label, |vault| vault.cadence.turn_ended(commit));
    }
}
