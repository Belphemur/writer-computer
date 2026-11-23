//! The running half of the feature: which windows have a vault, the cadence of each (the pure
//! state machine is `crate::git::scheduler`), the one ticker thread and the reactions to the
//! agent's points. The commits themselves are `crate::git`; nothing here names `gix`.
//!
//! Everything that writes to a repository runs outside the state's lock, on a thread that may
//! block: the ticker, a hook's caller (the agent's `turn-started` is emitted from a blocking
//! thread) or a command through `commands::blocking`.

use crate::agent::api::{
    Baseline, FileChange, FileChangeKind, TurnBaseline, TurnFinished, TurnStarted,
    BASELINE_MAX_BYTES,
};
use crate::git::scheduler::{Action, AgentTurn, Cadence, SyncTimer};
use crate::git::transport::Exec;
use crate::git::{self, device, ignore, state as pause_state};
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The feature id (the manifest's `id`, the key of its scope, state and points).
pub const ID: &str = "git";
pub const CHANGED_EVENT: &str = "git:changed";
pub const COMMIT_AFTER: &str = "git.commit-after";
pub const AGENT_COMMITS: &str = "git.agent-commits";
pub const COMMIT_MESSAGE: &str = "git.commit-message";
pub const SYNC_INTERVAL: &str = "git.sync-interval";
pub const LFS: &str = "git.lfs";
pub const LFS_THRESHOLD: &str = "git.lfs-threshold-mb";
/// How long a "is git-lfs installed" answer is trusted (it runs the user's login shell).
const LFS_PROBE_TTL: Duration = Duration::from_secs(60);
/// The web half hears which files a sync is about to write (vault-relative), before it writes,
/// and which it wrote once it is done ([`Applying`]).
pub const APPLYING_EVENT: &str = "git:applying";

/// The one payload of [`APPLYING_EVENT`] (twin: `ApplyingPayload` in `web/ipc.ts`): `done: false`
/// before the files are written (the editors hold their saves of them), `done: true` after, with
/// the files actually written (the others are released).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applying<'a> {
    pub paths: &'a [String],
    pub done: bool,
}

/// Tells `label`'s window which files are about to be written (`done: false`) or were (`true`).
pub fn emit_applying<R: Runtime>(app: &AppHandle<R>, label: &str, paths: &[String], done: bool) {
    let _ = app.emit_to(label, APPLYING_EVENT, Applying { paths, done });
}

/// The settings the cadence reads, per window, every time they are needed (a change applies at once).
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// `None`: Manual.
    pub quiet: Option<Duration>,
    pub agent_commits: bool,
    pub template: String,
    /// `git.sync-interval`; `None`: Manual.
    pub sync_every: Option<Duration>,
    /// `git.lfs` and `git.lfs-threshold-mb`: what the user asked for (whether `git-lfs` is
    /// installed decides what applies, see [`lfs_of`]).
    pub lfs_on: bool,
    pub lfs_threshold_mb: f64,
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
        let sync_every = match get(SYNC_INTERVAL)
            .as_ref()
            .and_then(|v| v.as_str().map(str::to_owned))
            .as_deref()
        {
            Some("1min") => Some(Duration::from_secs(60)),
            Some("15min") => Some(Duration::from_secs(900)),
            Some("manual") => None,
            _ => Some(Duration::from_secs(300)),
        };
        let lfs_on = matches!(get(LFS), Some(crate::config::ConfigValue::Bool(true)));
        let lfs_threshold_mb = get(LFS_THRESHOLD)
            .and_then(|v| v.as_f64())
            .unwrap_or(git::lfs::DEFAULT_THRESHOLD_MB);
        Config {
            quiet,
            agent_commits,
            template,
            sync_every,
            lfs_on,
            lfs_threshold_mb,
        }
    }
}

/// Where the last sync of a vault stands, for the status.
#[derive(Debug, Clone, Default)]
pub struct SyncRecord {
    /// A sync is running.
    pub syncing: bool,
    /// Seconds since the epoch of the last successful sync.
    pub last_at: Option<i64>,
    pub pushed: usize,
    pub pulled: usize,
    /// The last failure, `None` when the last sync went through.
    pub failure: Option<SyncFailure>,
}

/// A failed sync: one line for the status and the sanitized git output for "Details".
#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub line: String,
    pub details: String,
    /// The network is unreachable (the status reads Offline, not Error).
    pub offline: bool,
}

struct Vault {
    root: PathBuf,
    cadence: Cadence,
    sync: SyncTimer,
    record: SyncRecord,
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
    /// Syncs in progress (a sync is a git child and a replay: turning git off asks).
    syncing: AtomicUsize,
    /// One write lock per repository: every path that moves the branch or writes the index (the
    /// cadence's commits, an agent turn's, restore, setup, the sync) holds it, so two of them never
    /// interleave.
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    /// Whether `git-lfs` was found, and when (the login-shell lookup is not free).
    lfs_probe: Mutex<Option<(Instant, bool)>>,
    /// The repository at the start of each chat's running or last turn, per vault and chat: what
    /// the agent's `turn-baseline` question is answered from (`git::baseline`). Memory only; a
    /// chat's next turn, its vault closing and `shutdown` drop it.
    turn_starts: Mutex<HashMap<(PathBuf, String), git::baseline::TurnStart>>,
    /// Repositories `git lfs install --local` was run for (or found done) since the feature started.
    lfs_installed_in: Mutex<std::collections::HashSet<PathBuf>>,
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
    /// A commit or a sync is running.
    pub fn busy(&self) -> bool {
        self.committing.load(Ordering::SeqCst) > 0 || self.syncing.load(Ordering::SeqCst) > 0
    }

    /// Why git is busy, for the question "turn it off anyway?".
    pub fn busy_reason(&self) -> Option<&'static str> {
        if self.syncing.load(Ordering::SeqCst) > 0 {
            Some("a sync in progress")
        } else if self.committing.load(Ordering::SeqCst) > 0 {
            Some("a commit in progress")
        } else {
            None
        }
    }

    pub(super) fn syncing_counter(&self) -> &AtomicUsize {
        &self.syncing
    }

    pub(super) fn committing_now(&self) -> bool {
        self.committing.load(Ordering::SeqCst) > 0
    }

    /// Counts a write to the repository (a restore) as busy until dropped.
    pub fn busy_guard(&self) -> impl Drop + '_ {
        Busy::new(&self.committing)
    }

    /// The write lock of the repository at `root` (take it with `.lock()`).
    pub fn write_lock(&self, root: &Path) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .entry(root.to_path_buf())
            .or_default()
            .clone()
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Releases everything: the ticker ends at its next second, the observer and the points
    /// answer nothing, the extensions are retracted and the vaults are forgotten.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.inner.lock().clear();
        self.turn_starts.lock().clear();
    }

    pub fn open(&self, label: &str, root: &Path) {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        self.inner.lock().insert(
            label.to_string(),
            Vault {
                root,
                cadence: Cadence::new(),
                sync: {
                    let mut t = SyncTimer::new();
                    t.on_open();
                    t
                },
                record: SyncRecord::default(),
                auto_done: false,
                error: None,
            },
        );
    }

    pub fn close(&self, label: &str) -> Option<PathBuf> {
        let (root, last) = {
            let mut g = self.inner.lock();
            let root = g.remove(label).map(|v| v.root)?;
            // another window may still have the vault open
            let last = !g.values().any(|v| v.root == root);
            (root, last)
        };
        if last {
            self.turn_starts.lock().retain(|(r, _), _| *r != root);
        }
        Some(root)
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

    pub fn record_of(&self, label: &str) -> SyncRecord {
        self.inner
            .lock()
            .get(label)
            .map(|v| v.record.clone())
            .unwrap_or_default()
    }

    pub fn is_syncing(&self, label: &str) -> bool {
        self.inner
            .lock()
            .get(label)
            .is_some_and(|v| v.record.syncing)
    }

    /// Marks the start of a sync; `false` when one already runs for this window.
    pub(super) fn begin_sync(&self, label: &str) -> bool {
        self.with(label, |v| !std::mem::replace(&mut v.record.syncing, true))
            .unwrap_or(false)
    }

    /// Forgets the last sync's failure (a new remote or other credentials start clean).
    pub(super) fn end_sync_record_reset(&self, label: &str) {
        self.with(label, |v| v.record.failure = None);
    }

    pub(super) fn end_sync(&self, label: &str, update: impl FnOnce(&mut SyncRecord)) {
        self.with(label, |v| {
            v.record.syncing = false;
            update(&mut v.record);
        });
    }

    /// "Sync now", or a trigger the cadence should honour at its next pass.
    pub fn request_sync(&self, label: &str) {
        self.with(label, |v| v.sync.request());
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

impl Vaults {
    /// Is `git-lfs` installed? Asked of the user's login shell like `git` is, remembered for a
    /// minute; `fresh` asks again (the settings page opens, a status refresh).
    pub fn lfs_available(&self, exec: &Exec, fresh: bool) -> bool {
        let mut probe = self.lfs_probe.lock();
        if let (false, Some((at, found))) = (fresh, *probe) {
            if at.elapsed() < LFS_PROBE_TTL {
                return found;
            }
        }
        let found = exec.lfs_installed();
        *probe = Some((Instant::now(), found));
        found
    }
}

/// The LFS settings that apply to `label`'s vault: on only when the setting is on and `git-lfs` is
/// installed; the feature being off gives LFS off (no probe, no work).
pub fn lfs_of<R: Runtime>(app: &AppHandle<R>, label: &str, fresh: bool) -> git::Lfs {
    let cfg = config_of(app, label);
    let installed = cfg.lfs_on
        && match (vaults(app), super::sync::exec_of(app)) {
            (Some(v), Some(exec)) => v.lfs_available(&exec, fresh),
            _ => false,
        };
    git::Lfs::from_settings(cfg.lfs_on, cfg.lfs_threshold_mb, installed)
}

/// With LFS on, the repository gets `git lfs install --local` once (filters and hooks in its own
/// config, for the user's own git; Writer records pointers itself). A failure is logged and kept
/// off the commit: versions still work, the status line says what happened.
pub(super) fn ensure_lfs_installed<R: Runtime>(
    app: &AppHandle<R>,
    v: &Vaults,
    root: &Path,
    lfs: git::Lfs,
) {
    if !lfs.enabled || v.lfs_installed_in.lock().contains(root) {
        return;
    }
    let Some(exec) = super::sync::exec_of(app) else {
        return;
    };
    if let Err(e) = git::ensure_lfs(&exec, root, lfs) {
        log::warn!(target: "git", "git: git lfs install failed: {}", e.line);
        return;
    }
    v.lfs_installed_in.lock().insert(root.to_path_buf());
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
    crate::features::state_of::<R, Vaults>(app, ID)
}

fn announce<R: Runtime>(app: &AppHandle<R>, label: &str) {
    announce_changed(app, label);
}

/// Tells the window its status changed (`git:changed`).
pub(super) fn announce_changed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let _ = app.emit_to(label, CHANGED_EVENT, ());
}

/// Commits the user's pending changes of `label`'s vault now. `Ok(true)` when a commit was made.
/// While a sync runs nothing is committed (the sync commits first and owns the repository until it
/// is done): the cadence tries again at its next pass.
pub fn commit_user_now<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<bool, git::Error> {
    let Some(v) = vaults(app) else {
        return Ok(false);
    };
    // a sync holds the repository lock while it replays and writes (not while a large-file
    // transfer runs): the commit waits for the next pass instead of for the sync
    let held = v.is_syncing(label)
        && v.root_of(label)
            .is_some_and(|root| v.write_lock(&root).try_lock().is_none());
    if held {
        v.with(label, |vault| vault.cadence.on_write(Instant::now()));
        log::info!(target: "git", "git: a sync holds the repository, the commit waits");
        return Ok(false);
    }
    commit_user_unchecked(app, &v, label)
}

/// [`commit_user_now`] without the sync check: the sync's own first step.
pub(super) fn commit_user_unchecked<R: Runtime>(
    app: &AppHandle<R>,
    v: &Vaults,
    label: &str,
) -> Result<bool, git::Error> {
    let Some(root) = v.root_of(label) else {
        return Ok(false);
    };
    let _busy = Busy::new(&v.committing);
    let lock = v.write_lock(&root);
    let _write = lock.lock();
    let cfg = config_of(app, label);
    let dev = device::name();
    recover_now(app, label, &root, &dev);
    let lfs = lfs_of(app, label, false);
    ensure_lfs_installed(app, v, &root, lfs);
    let result = git::commit_user(&root, &cfg.template, &git::template_ctx(&dev), &dev, lfs);
    v.committed(label);
    match &result {
        Ok(Some(_)) => {
            v.set_error(label, None);
            v.with(label, |vault| vault.sync.on_commit(Instant::now()));
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
    let lock = v.write_lock(&root);
    let _write = lock.lock();
    let dev = device::name();
    recover_now(app, label, &root, &dev);
    let lfs = lfs_of(app, label, false);
    ensure_lfs_installed(app, &v, &root, lfs);
    match git::commit_agent(&root, turn, "Agent turn", &dev, lfs) {
        Ok(Some(_)) => {
            v.set_error(label, None);
            v.with(label, |vault| vault.sync.on_commit(Instant::now()));
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

/// Finishes a sync that was interrupted after it moved the branch, telling the window's editors
/// which files it writes. The caller holds the write lock; every commit runs it first (the
/// engine's commits run it too, without the editors, and refuse while its record exists).
pub(super) fn recover_now<R: Runtime>(app: &AppHandle<R>, label: &str, root: &Path, device: &str) {
    let announce = |paths: &[String]| emit_applying(app, label, paths, false);
    match git::sync::recover(root, Some(&announce), device) {
        Ok(Some(report)) => {
            emit_applying(app, label, &report.written, true);
            log::info!(target: "git", "git: finished an interrupted sync");
            announce_changed(app, label);
        }
        Ok(None) => {}
        Err(e) => {
            log::warn!(target: "git", "git: could not finish an interrupted sync: {}", super::sync::failure_line(&e))
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
    let lock = v.write_lock(&root);
    let _write = lock.lock();
    // a sync interrupted by a crash or a quit is finished when the vault opens
    recover_now(app, label, &root, &device::name());
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
            Some(Action::CommitAgent(turn)) if v.is_syncing(&label) => {
                // the sync owns the repository: the turn's commit goes at the next pass
                v.with(&label, |vault| vault.cadence.requeue(turn));
            }
            Some(Action::CommitAgent(turn)) => commit_agent(app, &label, &turn),
            _ => {}
        }
        if let Some(n) = v
            .with(&label, |vault| vault.cadence.take_expired())
            .filter(|n| *n > 0)
        {
            log::warn!(target: "git", "git: {n} agent turn(s) never finished; saving versions again");
        }
        let due = v.with(&label, |vault| {
            let root = vault.root.clone();
            let blocked = vault.cadence.turn_running() || vault.record.syncing;
            vault.sync.tick(now, cfg.sync_every, || {
                !blocked && super::sync::ready(&root, false)
            })
        });
        if due == Some(true) {
            // on its own thread: the ticker never waits on the network
            let _ = super::sync::spawn(app, &label, super::sync::Mode::Background);
        }
    }
}

/// Starts the ticker once (a thread of the feature, contained).
pub fn start_ticker<R: Runtime>(app: &AppHandle<R>) {
    let Some(v) = vaults(app) else { return };
    if v.ticker.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(scope) = crate::features::scope_of(app, ID) else {
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
            if crate::features::is_live(&handle, ID) {
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
    // a short sync so the other devices have it (spec "Cadence"): on a scope thread with one
    // deadline, waited for a few seconds at most, never on the caller's (the main) thread
    if super::sync::ready(&root, false) && !v.is_syncing(label) {
        super::sync::run_bounded(app, label);
    }
}

// ---- the agent's points -----------------------------------------------------------------------

/// `agent.turn-started`: save the user's pending edits, then mark the turn running (no user commit
/// until it ends), so the turn's commit holds only the agent's files. Then note the repository's
/// state for the chat (`git::baseline`), so a file a shell command changes can be compared with
/// what it was; nothing is noted when the commit above could not run (the chat's earlier note is
/// dropped either way).
pub fn turn_started<R: Runtime>(app: &AppHandle<R>, args: &TurnStarted) {
    let Some(v) = vaults(app).filter(|v| !v.stopped()) else {
        return;
    };
    let root = args
        .root
        .canonicalize()
        .unwrap_or_else(|_| args.root.clone());
    let key = (root.clone(), args.chat_id.clone());
    v.turn_starts.lock().remove(&key);
    let labels = v.labels_of(&root);
    let mut vouchable = !labels.is_empty();
    for label in labels {
        if active(&root) && !v.turn_running(&label) {
            // an error (no identity, a merge begun, ...) or a sync that holds the repository:
            // the history was not brought up to the start of the turn
            vouchable &= commit_user_now(app, &label).is_ok() && !v.is_syncing(&label);
        } else {
            vouchable &= active(&root);
        }
        v.with(&label, |vault| {
            vault.cadence.turn_started(&args.chat_id, Instant::now())
        });
    }
    if vouchable && !v.stopped() {
        if let Some(start) = git::baseline::record(&root) {
            v.turn_starts.lock().insert(key, start);
        }
    }
}

/// `agent.turn-baseline`: the text of a file as it was when the chat's turn started, when the
/// history can vouch for it (`git::baseline::answer`); no answer otherwise.
pub fn turn_baseline<R: Runtime>(app: &AppHandle<R>, query: &TurnBaseline) -> Option<Baseline> {
    let v = vaults(app).filter(|v| !v.stopped())?;
    let root = query
        .root
        .canonicalize()
        .unwrap_or_else(|_| query.root.clone());
    let start = v
        .turn_starts
        .lock()
        .get(&(root.clone(), query.chat_id.clone()))
        .cloned()?;
    Some(
        match git::baseline::answer(&root, &start, &query.path, BASELINE_MAX_BYTES)? {
            git::baseline::Vouched::Text(text) => Baseline::Text(text),
            git::baseline::Vouched::Absent => Baseline::Absent,
        },
    )
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
        v.with(&label, |vault| {
            vault.cadence.turn_ended(&args.chat_id, commit)
        });
    }
}
