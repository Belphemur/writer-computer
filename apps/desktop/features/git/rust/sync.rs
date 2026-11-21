//! Running a sync from the app (spec `SPECs/git-sync-spec.md` "Cadence" and "Sync"): the engine is
//! `crate::git::sync`; this file is the glue that owns when and how it runs here:
//!
//! - **who runs it**: the cadence thread (about 10 s after a commit, every `git.sync-interval`, when
//!   the vault opens), "Sync now" (a command on the blocking pool), the window close (a few seconds
//!   at most). One at a time per window, and never while a commit runs; commits and agent commits
//!   wait for it (`runtime::commit_user_now`);
//! - **its children** (`git`, `gh`) are the feature scope's (`Exec::new(scope.spawner())`): turning
//!   git off kills them, and the feature is busy (it asks first) for as long as a sync runs;
//! - **credentials**: Writer's own binary registered as the credential helper, with the source the
//!   user chose (`token` from the Keychain secret `features.git.token`, or `gh`); this file never
//!   reads a token;
//! - **what it tells the window**: `git:changed` (status), and `git:applying` with the files about
//!   to be written, before they are, so the editors that have them open claim the watcher's events
//!   and apply them after the typing idle (`web/lib/remote-apply.ts`).

use super::runtime::{self, SyncFailure, Vaults};
use crate::git::sync::{self as engine, Options};
use crate::git::transport::{Exec, Helper, Kind};
use crate::git::{self, device, state as local_state};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The cadence: honours the pause.
    Background,
    /// "Sync now": the user asked, the pause does not apply.
    Manual,
    /// The window is closing: short timeouts.
    Close,
}

/// How long a sync at close may wait on the network.
const CLOSE_CAP: Duration = Duration::from_secs(6);

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
/// identifier and the vault's chosen source. `None` when the binary's path is unknown.
pub fn helper_for<R: Runtime>(app: &AppHandle<R>, root: &Path) -> Option<Helper> {
    Some(Helper {
        exe: std::env::current_exe().ok()?,
        source: local_state::credential_source(root),
        service: crate::plugin_secrets::PluginSecrets::service_name(&app.config().identifier),
    })
}

/// The children runner of the running feature (its scope's), `None` while it is off.
pub fn exec_of<R: Runtime>(app: &AppHandle<R>) -> Option<Exec> {
    crate::features::scope_of(app, runtime::ID).map(|s| Exec::new(s.spawner()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Applying<'a> {
    paths: &'a [String],
}

fn failure(e: &engine::Error) -> SyncFailure {
    match e {
        engine::Error::Transport(t) => SyncFailure {
            line: t.line.clone(),
            details: t.details.clone(),
            offline: matches!(t.kind, Kind::Offline | Kind::Timeout),
        },
        engine::Error::Repo(r) => SyncFailure {
            line: runtime::error_line(r),
            details: String::new(),
            offline: false,
        },
        engine::Error::Io(_) => SyncFailure {
            line: "Could not read or write the vault".into(),
            details: String::new(),
            offline: false,
        },
        other => SyncFailure {
            line: other.to_string(),
            details: String::new(),
            offline: false,
        },
    }
}

/// One whole sync of `label`'s vault: commit the pending changes, fetch, replay, push. Quiet when
/// another is running or the vault cannot sync. The result is in the vault's [`SyncRecord`]
/// (`runtime::Vaults::record_of`) and announced with `git:changed`.
pub fn run<R: Runtime>(app: &AppHandle<R>, label: &str, mode: Mode) {
    let Some(v) = runtime::vaults(app).filter(|v| !v.stopped()) else {
        return;
    };
    let Some(root) = v.root_of(label) else { return };
    if !ready(&root, mode == Mode::Manual) || v.committing_now() || !v.begin_sync(label) {
        return;
    }
    let _busy = SyncBusy::new(&v);
    runtime::announce_changed(app, label);
    let started = Instant::now();
    // step 1: the pending changes
    let _ = runtime::commit_user_unchecked(app, &v, label);
    let Some(mut exec) = exec_of(app) else {
        v.end_sync(label, |_| {});
        return;
    };
    if mode == Mode::Close {
        exec = exec.with_timeout_cap(CLOSE_CAP);
    }
    let helper = helper_for(app, &root);
    let dev = device::name();
    // the sync owns the repository for as long as it runs
    let lock = v.write_lock(&root);
    let _write = lock.lock();
    let handle = app.clone();
    let target = label.to_string();
    let announce = move |paths: &[String]| {
        let _ = handle.emit_to(&target, runtime::APPLYING_EVENT, Applying { paths });
    };
    let outcome = engine::sync(
        &root,
        &Options {
            exec: &exec,
            helper: helper.as_ref(),
            secrets: Vec::new(),
            device: &dev,
            announce: Some(&announce),
        },
    );
    let ms = started.elapsed().as_millis();
    let failed = outcome.error.as_ref().map(failure);
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
