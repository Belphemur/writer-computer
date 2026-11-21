//! Starting and stopping features live (ADR 2026-11-20 "start and stop features live through an
//! owning scope, with leak guardrails"; spec `SPECs/builtin-plugins-spec.md` section 4).
//!
//! One start path and one stop path serve launch, the toggle in Settings > Features, "Turn back
//! on" after a failure, safe mode (nothing starts) and a failure (the feature is stopped):
//!
//! - [`start_feature`] gives the feature a fresh [`FeatureScope`], runs [`Feature::start`] under
//!   [`guard`], then hands it `on_workspace_open` for every window that has a workspace, and
//!   announces `features:started`;
//! - [`stop_feature`] runs `on_workspace_close` for every such window and [`Feature::stop`] (a
//!   failed feature skips both), drops the scope, announces `features:stopped` and, a few
//!   seconds later, checks that nothing the scope owned is still alive.
//!
//! Every feature's plugin is added at launch (`install`), started or not; a command answers
//! `FeatureUnavailable` unless the feature is started, so the web half that appears only once
//! `features:started` arrived never calls into a Rust half that is not there.
//!
//! Start and stop are serialised by one lock; neither runs under the settings locks (the toggle
//! path calls [`settings_written`] after the write is done).

use super::scope::{self, Counts, FeatureScope, JOIN_WAIT};
use super::{containment, fail, guard, id_of, is_enabled, Boundary, Feature, Manifest, WindowCtx};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Sent to every window once a feature's Rust half is up; payload [`LifecyclePayload`].
pub const STARTED_EVENT: &str = "features:started";
/// Sent to every window once a feature's Rust half is down; payload [`LifecyclePayload`].
pub const STOPPED_EVENT: &str = "features:stopped";

/// Leaks (a thread, a process that outlived a stop) counted against a feature before it is
/// switched off for the session, like failures.
pub const STRIKE_LIMIT: u32 = 3;

#[derive(Debug, Clone, Serialize)]
pub struct LifecyclePayload {
    pub id: String,
}

/// A started feature that is doing work the user would lose by turning it off.
#[derive(Debug, Clone, Serialize)]
pub struct Busy {
    pub id: String,
    pub reason: String,
}

/// How a stop checks for leftovers.
#[derive(Debug, Clone, Copy)]
pub struct Settle {
    /// How long after a stop the scope is looked at again.
    pub delay: Duration,
    /// Release behaviour: force-kill the leftovers and count a strike. Debug builds only warn.
    pub enforce: bool,
}

impl Default for Settle {
    fn default() -> Self {
        Self {
            delay: Duration::from_secs(3),
            enforce: !cfg!(debug_assertions),
        }
    }
}

struct Live<R: Runtime> {
    feature: &'static dyn Feature<R>,
    id: String,
    scope: FeatureScope,
}

/// Every registered feature and the ones that are started now, in start order. Managed state.
pub struct Running<R: Runtime> {
    all: Vec<&'static dyn Feature<R>>,
    started: Mutex<Vec<Live<R>>>,
    /// Serialises start and stop.
    toggle: Mutex<()>,
    settle: Mutex<Settle>,
}

impl<R: Runtime> Running<R> {
    pub(super) fn new(all: Vec<&'static dyn Feature<R>>) -> Self {
        Self {
            all,
            started: Mutex::new(Vec::new()),
            toggle: Mutex::new(()),
            settle: Mutex::new(Settle::default()),
        }
    }

    fn is_started(&self, id: &str) -> bool {
        self.started.lock().iter().any(|l| l.id == id)
    }

    /// The started features, in start order.
    pub(super) fn features(&self) -> Vec<&'static dyn Feature<R>> {
        self.started.lock().iter().map(|l| l.feature).collect()
    }

    fn scope(&self, id: &str) -> Option<FeatureScope> {
        self.started
            .lock()
            .iter()
            .find(|l| l.id == id)
            .map(|l| l.scope.clone())
    }
}

fn running<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, Running<R>>> {
    app.try_state::<Running<R>>()
}

/// Is the feature started (its Rust half is up)?
pub fn is_started<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    running(app).is_some_and(|r| r.is_started(id))
}

/// The ids of the started features.
pub fn started_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    running(app)
        .map(|r| r.started.lock().iter().map(|l| l.id.clone()).collect())
        .unwrap_or_default()
}

/// What the started features are busy with (those that are idle are absent).
pub fn busy<R: Runtime>(app: &AppHandle<R>) -> Vec<Busy> {
    let Some(r) = running(app) else {
        return Vec::new();
    };
    let scopes: Vec<(String, FeatureScope)> = r
        .started
        .lock()
        .iter()
        .map(|l| (l.id.clone(), l.scope.clone()))
        .collect();
    // outside the lock: a probe takes the feature's own locks
    scopes
        .into_iter()
        .filter_map(|(id, s)| s.busy_reason().map(|reason| Busy { id, reason }))
        .collect()
}

/// The started feature's scope.
pub fn scope_of<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<FeatureScope> {
    running(app)?.scope(id)
}

/// The state of type `T` that feature `id` keeps in its scope (`FeatureScope::manage`): `None`
/// while the feature is not started. Commands and core code reach a feature's state only here.
pub fn state_of<R: Runtime, T: Send + Sync + 'static>(
    app: &AppHandle<R>,
    id: &str,
) -> Option<Arc<T>> {
    scope_of(app, id)?.state::<T>()
}

/// Tests: how a stop checks for leftovers.
#[cfg(test)]
pub(crate) fn set_settle<R: Runtime>(app: &AppHandle<R>, settle: Settle) {
    if let Some(r) = running(app) {
        *r.settle.lock() = settle;
    }
}

/// The live windows that have a workspace: `(label, root)`.
fn open_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, PathBuf)> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    let mut labels = state.labels();
    labels.sort();
    labels
        .into_iter()
        .filter_map(|label| {
            let (root, _) = state.get(&label)?.workspace_snapshot()?;
            Some((label, root))
        })
        .collect()
}

fn announce<R: Runtime>(app: &AppHandle<R>, event: &str, id: &str) {
    let payload = LifecyclePayload { id: id.to_string() };
    if let Err(e) = app.emit(event, payload) {
        log::warn!("feature {id}: could not announce {event}: {e}");
    }
}

fn hook_open<R: Runtime>(
    app: &AppHandle<R>,
    f: &dyn Feature<R>,
    id: &str,
    label: &str,
    root: &Path,
) {
    let window = WindowCtx {
        label,
        root: Some(root),
    };
    let _ = guard(app, id, Boundary::WorkspaceOpen, || {
        f.on_workspace_open(app, &window)
    });
}

/// Starts feature `f`: a fresh scope, `start` under [`guard`], `on_workspace_open` for every
/// open window, `features:started`. Already started is `Ok`. A failure (an `Err` or a panic)
/// stops what the partial start created and marks the feature failed for the session.
pub fn start_feature<R: Runtime>(
    app: &AppHandle<R>,
    f: &'static dyn Feature<R>,
) -> Result<(), String> {
    let Some(r) = running(app) else {
        return Err("features are not installed".into());
    };
    let _toggle = r.toggle.lock();
    start_locked(app, &r, f)
}

fn start_locked<R: Runtime>(
    app: &AppHandle<R>,
    r: &Running<R>,
    f: &'static dyn Feature<R>,
) -> Result<(), String> {
    let id = id_of(f);
    if r.is_started(&id) {
        return Ok(());
    }
    let wrap_app = app.clone();
    let wrap_id = id.clone();
    let scope = FeatureScope::new(
        &id,
        Some(Arc::new(move |name, run| {
            let _ = guard(&wrap_app, &wrap_id, Boundary::Thread(name), run);
        })),
    );
    let outcome = guard(app, &id, Boundary::Setup, || f.start(app, &scope)).and_then(|r| r);
    if let Err(e) = outcome {
        // what the partial start created goes with it
        scope.shutdown(JOIN_WAIT);
        // a panic was announced by the guard; a plain error is announced here
        if !e.starts_with("panic in ") {
            fail(app, &id, "setup", false);
        }
        return Err(e);
    }
    r.started.lock().push(Live {
        feature: f,
        id: id.clone(),
        scope,
    });
    for (label, root) in open_windows(app) {
        hook_open(app, f, &id, &label, &root);
    }
    announce(app, STARTED_EVENT, &id);
    Ok(())
}

/// Stops feature `id`. `graceful` runs `on_workspace_close` for every open window and
/// [`Feature::stop`] first (a failed feature skips them: it is not trusted to run code).
pub fn stop_feature<R: Runtime>(app: &AppHandle<R>, id: &str, graceful: bool) {
    let Some(r) = running(app) else { return };
    let _toggle = r.toggle.lock();
    stop_locked(app, &r, id, graceful);
}

fn stop_locked<R: Runtime>(app: &AppHandle<R>, r: &Running<R>, id: &str, graceful: bool) {
    let live = {
        let mut started = r.started.lock();
        match started.iter().position(|l| l.id == id) {
            Some(i) => started.remove(i),
            None => return,
        }
    };
    if graceful {
        for (label, _) in open_windows(app) {
            let _ = guard(app, id, Boundary::WorkspaceClose, || {
                live.feature.on_workspace_close(app, &label)
            });
        }
        let _ = guard(app, id, Boundary::Stop, || live.feature.stop(app));
    }
    live.scope.shutdown(JOIN_WAIT);
    announce(app, STOPPED_EVENT, id);
    let settle = *r.settle.lock();
    let (handle, id) = (app.clone(), id.to_string());
    scope::verify_stopped(live.scope, settle.delay, move |scope, counts| {
        leaked(&handle, &id, scope, &counts, settle.enforce)
    });
}

/// A scope still owns something after its feature stopped. Debug builds warn; release builds
/// force-kill what can be killed, log it and count a strike (three switch the feature off for
/// the session, as failures do).
fn leaked<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    scope: &FeatureScope,
    counts: &Counts,
    enforce: bool,
) {
    let what = scope::describe(counts);
    if !enforce {
        log::warn!("feature {id}: {what} still alive after it stopped");
        return;
    }
    scope.force_kill();
    log::error!("feature {id}: {what} still alive after it stopped (force-killed what could be)");
    if let Some(c) = containment(app) {
        if c.strike(id) >= STRIKE_LIMIT {
            fail(app, id, "leak", true);
        }
    }
}

/// A feature failed in Rust: its scope is released (no hooks, no `stop`) off the failing thread,
/// since the failure may be raised from inside a hook or a scope thread.
pub(super) fn stop_after_failure<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if !is_started(app, id) {
        return;
    }
    let (app, id) = (app.clone(), id.to_string());
    let spawned = std::thread::Builder::new()
        .name("feature-failed-stop".into())
        .spawn({
            let id = id.clone();
            move || stop_feature(&app, &id, false)
        });
    if let Err(e) = spawned {
        log::warn!("feature {id}: could not release its scope after the failure: {e}");
    }
}

fn manifest_of<R: Runtime>(f: &dyn Feature<R>) -> Option<Manifest> {
    f.manifest().ok()
}

/// Starts each feature in `features` (the caller already chose them by their switch). Returns
/// the id and reason of those that failed, for the log and the tests.
pub(super) fn start_planned<R: Runtime>(
    app: &AppHandle<R>,
    features: Vec<&'static dyn Feature<R>>,
) -> Vec<(String, String)> {
    let mut failed = Vec::new();
    for f in features {
        if let Err(e) = start_feature(app, f) {
            failed.push((id_of(f), e));
        }
    }
    failed
}

/// A global setting was written: when it is a feature's switch, start or stop that feature to
/// match (turning it on also forgets a failure and the strikes: "Turn back on"). Call it after
/// the write, with no settings lock held; it can take seconds when a feature stops.
pub fn settings_written<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let Some(id) = key
        .strip_prefix("features.")
        .and_then(|rest| rest.strip_suffix(".enabled"))
    else {
        return;
    };
    let Some(r) = running(app) else { return };
    let Some(f) = r
        .all
        .iter()
        .copied()
        .find(|f| manifest_of(*f).is_some_and(|m| m.id == id))
    else {
        return;
    };
    let Some(manifest) = manifest_of(f) else {
        return;
    };
    if containment(app).is_some_and(|c| c.is_safe_mode()) {
        return;
    }
    if switched_on(app, &manifest) {
        if !r.is_started(id) {
            if let Some(c) = containment(app) {
                c.forget(id);
            }
            if let Err(e) = start_feature(app, f) {
                log::error!("feature {id} could not start: {e}");
            }
        }
    } else {
        stop_feature(app, id, true);
    }
}

/// The switch, read live from the global settings.
fn switched_on<R: Runtime>(app: &AppHandle<R>, manifest: &Manifest) -> bool {
    let Some(state) = app
        .try_state::<AppState>()
        .and_then(|s| s.get(crate::MAIN_WINDOW_LABEL))
    else {
        return manifest.enabled_by_default;
    };
    let settings = state.settings.read();
    settings
        .as_ref()
        .map_or(manifest.enabled_by_default, |s| is_enabled(s, manifest))
}

fn run_hooks<R: Runtime>(
    app: &AppHandle<R>,
    boundary: Boundary,
    reverse: bool,
    hook: impl Fn(&dyn Feature<R>),
) {
    let Some(r) = running(app) else {
        return;
    };
    let mut list = r.features();
    if reverse {
        list.reverse();
    }
    for f in list {
        let id = id_of(f);
        if containment(app).is_some_and(|c| c.is_failed(&id)) {
            continue;
        }
        // a panic is logged and announced by the guard; the other features still get the hook
        let _ = guard(app, &id, boundary, || hook(f));
    }
}

/// A window now has a workspace root.
pub fn workspace_open<R: Runtime>(app: &AppHandle<R>, label: &str, root: &Path) {
    let window = WindowCtx {
        label,
        root: Some(root),
    };
    run_hooks(app, Boundary::WorkspaceOpen, false, |f| {
        f.on_workspace_open(app, &window)
    });
}

/// A window was destroyed or left its workspace (`commands::plugins::stop_window_work` calls this).
pub fn workspace_close<R: Runtime>(app: &AppHandle<R>, label: &str) {
    run_hooks(app, Boundary::WorkspaceClose, true, |f| {
        f.on_workspace_close(app, label)
    });
}

/// The app is exiting: `on_exit` hooks in reverse, then every scope is released without waiting
/// (no process of a feature outlives the app).
pub fn exit<R: Runtime>(app: &AppHandle<R>) {
    run_hooks(app, Boundary::Exit, true, |f| f.on_exit(app));
    if let Some(r) = running(app) {
        let scopes: Vec<FeatureScope> = r.started.lock().iter().map(|l| l.scope.clone()).collect();
        for s in scopes.iter().rev() {
            s.shutdown(Duration::ZERO);
        }
    }
    if let Some(c) = containment(app) {
        c.clean_exit();
    }
}
