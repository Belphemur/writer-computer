//! Running a sync from the app (spec `SPECs/git-sync-spec.md` "Cadence" and "Sync"): the engine is
//! `crate::git::sync`; this file is the glue that owns when and how it runs here:
//!
//! - **who runs it**: a thread of the feature's scope started by the cadence (about 10 s after a
//!   commit, every `git.sync-interval`, when the vault opens: the ticker never waits on the
//!   network), "Sync now" (a command on the blocking pool), the window close and the exit (a scope
//!   thread with ONE deadline for all its rounds, [`CLOSE_BUDGET`]; the closing side waits for it
//!   that long at most and never runs network git itself). One at a time per window, and never while a commit runs; commits and agent commits
//!   wait for it (`runtime::commit_user_now`);
//! - **its children** (`git`, `gh`, `fj`) are the feature scope's (`Exec::new(scope.spawner())`): turning
//!   git off kills them, and the feature is busy (it asks first) for as long as a sync runs;
//! - **credentials**: Writer's own binary registered as the credential helper, with the source the
//!   user chose (`token` from the Keychain secret `features.git.token`, or a forge CLI: `gh`, `fj`); this file never
//!   reads a token;
//! - **what it tells the window**: `git:changed` (status), and `git:applying` (one payload,
//!   `runtime::Applying`) with the files about to be written, before they are, then with
//!   `done: true` and the files it did write, so the editors that have them open hold their saves,
//!   claim the watcher's events and apply them after the typing idle (`web/lib/remote-apply.ts`).

use super::runtime::{self, SyncFailure, Vaults};
use crate::git::sync::{self as engine, Options};
use crate::git::transport::{Exec, Helper, Kind};
use crate::git::{self, device, state as local_state};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The cadence: honours the pause.
    Background,
    /// "Sync now": the user asked, the pause does not apply.
    Manual,
    /// The window is closing: short timeouts.
    Close,
}

/// The whole budget of a sync at close or exit, every call and round included.
pub const CLOSE_BUDGET: Duration = Duration::from_secs(6);
/// How long the closing side waits for that sync's thread beyond its budget (the local work after
/// the network).
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// The secret the token source answers from.
pub const TOKEN_KEY: &str = "features.git.token";

/// May this vault sync: set up, a remote linked, no merge or rebase under way, and (for the
/// cadence) not paused. `explicit` is "Sync now".
pub fn ready(root: &Path, explicit: bool) -> bool {
    git::is_set_up(root)
        && git::operation(root).is_none()
        && (explicit || !local_state::sync_paused(root))
        && git::Repo::open(root)
            .ok()
            .flatten()
            .is_some_and(|r| git::has_remote(&r))
}

/// The credential helper for this build: Writer's own binary, the keychain service of this app
/// identifier, the vault's chosen source and the host its token was saved for. `None` when the
/// binary's path is unknown or Writer has no credential for the vault (no token saved): git then
/// uses the user's own helpers. Only whether the token is set is read, never its value.
pub fn helper_for<R: Runtime>(app: &AppHandle<R>, root: &Path) -> Option<Helper> {
    let token_saved = crate::features::secrets::secret_keys_set(app, runtime::ID)
        .is_ok_and(|keys| keys.iter().any(|k| k == TOKEN_KEY));
    Helper::for_vault(
        root,
        std::env::current_exe().ok()?,
        crate::plugin_secrets::PluginSecrets::service_name(&app.config().identifier),
        token_saved,
    )
}

/// The children runner of the running feature (its scope's), `None` while it is off.
pub fn exec_of<R: Runtime>(app: &AppHandle<R>) -> Option<Exec> {
    crate::features::scope_of(app, runtime::ID).map(|s| Exec::new(s.spawner()))
}

/// One short line for a failure (never a path or a credential).
pub(super) fn failure_line(e: &engine::Error) -> String {
    failure(e).line
}

pub(super) fn failure(e: &engine::Error) -> SyncFailure {
    match e {
        engine::Error::Transport(t) => SyncFailure {
            line: t.line.clone(),
            details: t.details.clone(),
            offline: matches!(t.kind, Kind::Offline | Kind::Timeout | Kind::LocalNetwork),
            kind: t.kind.name(),
        },
        engine::Error::Repo(r) => SyncFailure {
            line: runtime::error_line(r),
            details: String::new(),
            offline: false,
            kind: Kind::Other.name(),
        },
        engine::Error::Io(_) => SyncFailure {
            line: "Could not read or write the vault".into(),
            details: String::new(),
            offline: false,
            kind: Kind::Other.name(),
        },
        other => SyncFailure {
            line: other.to_string(),
            details: String::new(),
            offline: false,
            kind: Kind::Other.name(),
        },
    }
}

/// Why a requested sync did not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// The feature is stopping or off.
    Stopped,
    /// The vault cannot sync now: not set up, no remote, a merge or rebase under way.
    NotReady,
    /// Another sync or a commit is running.
    Busy,
}

impl Skip {
    /// One terse line for whoever asked.
    pub fn line(self) -> &'static str {
        match self {
            Skip::Stopped => "Version history is turned off",
            Skip::NotReady => "Cannot sync now: finish the merge or rebase first",
            Skip::Busy => "A sync is already running: try again",
        }
    }
}

/// What [`run`] did: a whole sync with its result, or why it did not run.
#[derive(Debug, Clone)]
pub enum Ran {
    Done(Result<(), SyncFailure>),
    Skipped(Skip),
}

/// One whole sync of `label`'s vault: commit the pending changes, fetch, replay, push. Quiet when
/// another is running or the vault cannot sync (the cadence ignores that; [`Ran::Skipped`] says
/// which, for the callers that must not take a skipped sync for a finished one). The result is
/// also in the vault's [`SyncRecord`] (`runtime::Vaults::record_of`) and announced with
/// `git:changed`.
pub fn run<R: Runtime>(app: &AppHandle<R>, label: &str, mode: Mode) -> Ran {
    let Some(v) = runtime::vaults(app).filter(|v| !v.stopped()) else {
        return Ran::Skipped(Skip::Stopped);
    };
    let Some(root) = v.root_of(label) else {
        return Ran::Skipped(Skip::Stopped);
    };
    if !ready(&root, mode == Mode::Manual) {
        return Ran::Skipped(Skip::NotReady);
    }
    if v.committing_now() || !v.begin_sync(label) {
        return Ran::Skipped(Skip::Busy);
    }
    let _busy = SyncBusy::new(&v);
    runtime::announce_changed(app, label);
    let started = Instant::now();
    // step 1: the pending changes
    let _ = runtime::commit_user_unchecked(app, &v, label);
    let Some(mut exec) = exec_of(app) else {
        v.end_sync(label, |_| {});
        return Ran::Skipped(Skip::Stopped);
    };
    if mode == Mode::Close {
        exec = exec.with_deadline(started + CLOSE_BUDGET);
    }
    let helper = helper_for(app, &root);
    let dev = device::name();
    runtime::ensure_lfs_installed(app, &v, &root, runtime::lfs_of(app, label, false));
    // the sync owns the repository for as long as it runs
    let lock = v.write_lock(&root);
    let write = std::cell::RefCell::new(lock.lock());
    // large-file transfers run with the lock let go (they only append to the object store)
    let unlock = |f: &mut dyn FnMut()| {
        parking_lot::MutexGuard::unlocked(&mut *write.borrow_mut(), f);
    };
    let announce = |paths: &[String]| runtime::emit_applying(app, label, paths, false);
    let outcome = engine::sync(
        &root,
        &Options {
            exec: &exec,
            helper: helper.as_ref(),
            secrets: Vec::new(),
            device: &dev,
            unlocked: Some(&unlock),
            announce: Some(&announce),
        },
    );
    runtime::emit_applying(app, label, &outcome.report.written, true);
    let ms = started.elapsed().as_millis();
    let failed = outcome.error.as_ref().map(|e| {
        let mut f = failure(e);
        // a refused login of a CLI whose saved login expires says what to do about it
        if matches!(e, engine::Error::Transport(t) if t.kind == Kind::Auth) {
            if let Some(line) = helper.as_ref().and_then(Helper::sign_in_again) {
                f.line = line;
            }
        }
        f
    });
    match &outcome.error {
        None => log::info!(
            target: "git",
            "git: synced in {ms} ms (pushed {}, pulled {}, conflicts {})",
            outcome.report.pushed,
            outcome.report.pulled,
            outcome.report.conflicts.len()
        ),
        Some(engine::Error::NoRemote) => {}
        Some(e) => {
            log::warn!(target: "git", "git: sync stopped after {ms} ms: {}", failure(e).line)
        }
    }
    for held in &outcome.report.held {
        // the plugin's id only, never a value
        log::info!(target: "git", "git: plugin {} settings held back from the push", held.id);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let result = failed.clone().map_or(Ok(()), Err);
    v.end_sync(label, |r| {
        if failed.is_none() {
            r.last_at = Some(now);
            r.pushed = outcome.report.pushed;
            r.pulled = outcome.report.pulled;
        }
        r.failure = failed;
    });
    v.identity.forget(&root);
    runtime::announce_changed(app, label);
    Ran::Done(result)
}

/// The first push of "Sign in with ...": one whole sync now, as a step's result. A sync that did
/// not run is a failed step, never a finished one. An already running sync is not waited for: it
/// started before the remote and the credential were set, so its outcome is not this one's, and
/// "try again" is true without any race.
pub fn first_push<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<(), git::signin::StepError> {
    if let Some(v) = runtime::vaults(app) {
        v.end_sync_record_reset(label);
    }
    match run(app, label, Mode::Manual) {
        Ran::Done(Ok(())) => Ok(()),
        Ran::Done(Err(f)) => Err(git::signin::StepError {
            line: f.line,
            kind: f.kind,
        }),
        Ran::Skipped(skip) => Err(git::signin::StepError {
            line: skip.line().into(),
            kind: Kind::Other.name(),
        }),
    }
}

/// Counts a running sync for [`Vaults::busy`].
struct SyncBusy<'a>(&'a Vaults);

impl<'a> SyncBusy<'a> {
    fn new(v: &'a Vaults) -> Self {
        v.syncing_counter()
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        SyncBusy(v)
    }
}

impl Drop for SyncBusy<'_> {
    fn drop(&mut self) {
        self.0
            .syncing_counter()
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// [`run`] on a thread of the feature's scope; the receiver hears when it is over. `None` while
/// the feature is off or the thread could not start.
pub fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    mode: Mode,
) -> Option<mpsc::Receiver<()>> {
    let scope = crate::features::scope_of(app, runtime::ID)?;
    let (tx, rx) = mpsc::channel();
    let (handle, label) = (app.clone(), label.to_string());
    match scope.spawn("git-sync", move |_| {
        run(&handle, &label, mode);
        let _ = tx.send(());
    }) {
        Ok(()) => Some(rx),
        Err(e) => {
            log::warn!(target: "git", "git: could not start a sync: {e}");
            None
        }
    }
}

/// The sync of a closing window or of the exit: on a scope thread with one deadline for all of
/// it, waited for [`CLOSE_BUDGET`] plus a grace at most. Past that the caller goes on; the thread
/// ends at its deadline (or when the scope stops and kills its child).
pub fn run_bounded<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(done) = spawn(app, label, Mode::Close) {
        if done.recv_timeout(CLOSE_BUDGET + CLOSE_GRACE).is_err() {
            log::warn!(target: "git", "git: the sync at close did not finish in time");
        }
    }
}
