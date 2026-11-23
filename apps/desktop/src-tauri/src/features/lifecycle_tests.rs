//! The lifecycle guardrails of ADR 2026-11-20 "start and stop features live through an owning
//! scope, with leak guardrails": a generic cycle test over the registry, the handshake events
//! and the stop-time leak check. A new feature is covered the day it is added to `registry()`.
#![allow(deprecated)]

use super::ipc_tests::{test_context, with_main_window};
use super::lifecycle::{self, Settle};
use super::scope::{describe, Kind};
use super::tests::settings_with;
use super::*;
use crate::config::ConfigValue;
use crate::state::AppState;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tauri::test::{mock_builder, MockRuntime};
use tauri::Listener;

fn app_with(features: Vec<&'static dyn Feature<MockRuntime>>) -> tauri::App<MockRuntime> {
    app_keeping(features).0
}

/// [`app_with`] and the settings directory, which a test that writes a switch must keep alive.
fn app_keeping(
    features: Vec<&'static dyn Feature<MockRuntime>>,
) -> (tauri::App<MockRuntime>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let state = AppState::new();
    *state.get_or_create("main").settings.write() = Some(settings_with(dir.path(), &[]));
    let mut app = mock_builder()
        .setup(move |app| {
            app.manage(state);
            install_features(app.handle(), features, &settings);
            Ok(())
        })
        .build(test_context())
        .expect("the app builds");
    app.run_iteration(|_, _| {});
    with_main_window(&app);
    (app, dir)
}

/// Writes feature `id`'s switch the way the Settings page does, then runs the lifecycle's reaction.
fn write_switch(app: &AppHandle<MockRuntime>, id: &str, on: bool) {
    let key = format!("features.{id}.enabled");
    app.state::<AppState>()
        .get("main")
        .unwrap()
        .settings
        .write()
        .as_mut()
        .unwrap()
        .set_global(&key, ConfigValue::Bool(on))
        .unwrap();
    settings_written(app, &key);
}

fn wait_for(what: &str, cond: impl Fn() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out: {what}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn every_registered_feature_starts_and_stops_twice_and_leaves_nothing_alive() {
    // the icons and code-files flags are process-wide: stopping them must not race their own tests
    let _icons = crate::icons::TEST_SWITCH.lock();
    let mut all = registry::<MockRuntime>();
    all.extend(fixture::registry::<MockRuntime>());
    for f in all {
        let id = id_of(f);
        let app = app_with(vec![f]);
        for round in 1..=2 {
            assert!(is_started(app.handle(), &id), "{id} round {round}: started");
            let scope = scope_of(app.handle(), &id).unwrap();
            let weaks = scope.state_weaks();
            // a window with a workspace gets the hooks, like any started feature
            workspace_open(app.handle(), "main", Path::new("/vault"));
            workspace_close(app.handle(), "main");

            stop_feature(app.handle(), &id, true);
            assert!(
                !is_started(app.handle(), &id),
                "{id} round {round}: stopped"
            );
            wait_for(&format!("{id} round {round}: nothing alive"), || {
                scope.live_counts().is_empty()
            });
            let left = scope.live_counts();
            assert!(left.is_empty(), "{id} round {round}: {}", describe(&left));
            assert!(
                weaks.iter().all(|w| w.upgrade().is_none()),
                "{id} round {round}: a state handle is still alive"
            );
            assert!(scope.is_stopped());
            assert!(
                scope.spawn("late", |_| {}).is_err(),
                "{id}: refuses after the stop"
            );
            if round == 1 {
                start_feature(app.handle(), f).unwrap();
            }
        }
    }
}

#[test]
fn started_and_stopped_are_announced_and_the_status_lists_started_ids() {
    let app = app_with(fixture::registry::<MockRuntime>());
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    for event in [lifecycle::STARTED_EVENT, lifecycle::STOPPED_EVENT] {
        let s = Arc::clone(&seen);
        app.listen(event, move |e| {
            s.lock().push(format!("{event} {}", e.payload()))
        });
    }
    assert_eq!(status(app.handle()).started, ["fixture-hello"]);
    stop_feature(app.handle(), "fixture-hello", true);
    assert!(status(app.handle()).started.is_empty());
    start_feature(app.handle(), fixture::registry::<MockRuntime>()[0]).unwrap();
    assert_eq!(status(app.handle()).started, ["fixture-hello"]);
    let seen = seen.lock().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen[0].starts_with("features:stopped") && seen[1].starts_with("features:started"));
    assert!(seen[0].contains("fixture-hello"));
}

#[test]
fn a_feature_started_after_launch_gets_open_workspace_hooks_and_a_stopped_one_none() {
    static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    struct Hooked;
    impl<R: Runtime> Feature<R> for Hooked {
        fn manifest_source(&self) -> &'static str {
            r#"{"id":"hooked","name":"Hooked"}"#
        }
        fn on_workspace_open(&self, _app: &AppHandle<R>, w: &WindowCtx<'_>) {
            LOG.lock().push(format!("open({})", w.label));
        }
        fn on_workspace_close(&self, _app: &AppHandle<R>, label: &str) {
            LOG.lock().push(format!("close({label})"));
        }
        fn stop(&self, _app: &AppHandle<R>) {
            LOG.lock().push("stop".into());
        }
    }
    static HOOKED: Hooked = Hooked;
    let dir = tempfile::tempdir().unwrap();
    let off = settings_with(dir.path(), &[("features.hooked.enabled", false)]);
    let app = mock_builder()
        .manage(AppState::new())
        .build(test_context())
        .unwrap();
    install_features(app.handle(), vec![&HOOKED], &off);
    assert!(!is_started(app.handle(), "hooked"));
    let state = app.state::<AppState>().get_or_create("main");
    state.transition_to_workspace(std::path::PathBuf::from("/vault-for-hooks"));
    start_feature(app.handle(), &HOOKED).unwrap();
    assert_eq!(*LOG.lock(), ["open(main)"]);
    stop_feature(app.handle(), "hooked", true);
    assert_eq!(*LOG.lock(), ["open(main)", "close(main)", "stop"]);
    // nothing reaches a stopped feature
    workspace_open(app.handle(), "main", Path::new("/vault-for-hooks"));
    workspace_close(app.handle(), "main");
    exit(app.handle());
    assert_eq!(LOG.lock().len(), 3);
}

#[test]
fn a_leak_after_a_stop_is_checked_later_and_released_builds_force_kill_and_strike_it() {
    static ESCAPEE: AtomicUsize = AtomicUsize::new(0);
    struct Leaky;
    impl<R: Runtime> Feature<R> for Leaky {
        fn manifest_source(&self) -> &'static str {
            r#"{"id":"leaky","name":"Leaky"}"#
        }
        fn start(&self, _app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
            // a manager that reports something alive however often it is stopped
            scope.adopt(Kind::Process, || ESCAPEE.load(Ordering::SeqCst));
            Ok(())
        }
    }
    static LEAKY: Leaky = Leaky;
    let app = app_with(vec![&LEAKY]);
    lifecycle::set_settle(
        app.handle(),
        Settle {
            delay: Duration::from_millis(20),
            enforce: true,
        },
    );
    ESCAPEE.store(1, Ordering::SeqCst);
    for strike in 1..=lifecycle::STRIKE_LIMIT {
        stop_feature(app.handle(), "leaky", true);
        wait_for("the stop check strikes", || {
            app.state::<Containment>()
                .strikes
                .lock()
                .get("leaky")
                .copied()
                == Some(strike)
        });
        if strike < lifecycle::STRIKE_LIMIT {
            assert!(!app.state::<Containment>().is_failed("leaky"));
            start_feature(app.handle(), &LEAKY).unwrap();
        }
    }
    assert!(
        app.state::<Containment>().is_failed("leaky"),
        "three strikes switch the feature off for the session"
    );
    ESCAPEE.store(0, Ordering::SeqCst);
}

// ---------- one liveness, one reconcile (review fixes 1, 3, 4, 9) ----------

use super::points::{self, Point, Points, Provider};

fn wait_stopped(app: &tauri::App<MockRuntime>, id: &str) {
    wait_for(&format!("{id} released"), || !is_started(app.handle(), id));
}

/// `is_live` is `is_started` and not failed and not safe mode, for every registered feature
/// through start, stop, failure and "Turn back on": nothing else decides.
#[test]
fn is_live_agrees_with_started_through_start_stop_and_failure_for_every_feature() {
    let _icons = crate::icons::TEST_SWITCH.lock();
    let mut all = registry::<MockRuntime>();
    all.extend(fixture::registry::<MockRuntime>());
    for f in all {
        let id = id_of(f);
        let (app, _dir) = app_keeping(vec![f]);
        let live = |app: &tauri::App<MockRuntime>| is_live(app.handle(), &id);
        assert!(is_started(app.handle(), &id) && live(&app), "{id}: started");
        stop_feature(app.handle(), &id, true);
        assert!(
            !is_started(app.handle(), &id) && !live(&app),
            "{id}: stopped"
        );
        start_feature(app.handle(), f).unwrap();
        assert!(live(&app), "{id}: started again");
        fail_for_test(app.handle(), &id);
        assert!(
            !live(&app),
            "{id}: failed is not live, even before its scope is released"
        );
        wait_stopped(&app, &id);
        assert!(!live(&app), "{id}: failed and released");
        write_switch(app.handle(), &id, true);
        assert!(
            is_started(app.handle(), &id) && live(&app),
            "{id}: turned back on"
        );
    }
}

static SAID: Point<&'static str> = Point::new("pt-owner.said", "pt-owner");
static HEARD: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Owner;
impl<R: Runtime> Feature<R> for Owner {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"pt-owner","name":"Owner"}"#
    }
}
struct Listener1;
impl<R: Runtime> Feature<R> for Listener1 {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"pt-listener","name":"Listener"}"#
    }
    fn start(&self, app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        points::extend(app, &SAID, "pt-listener", |s| {
            HEARD.lock().push((*s).to_string())
        });
        Ok(())
    }
}

/// An owner that is being turned off (or has failed) still announces the end of what it was
/// doing, and the contributor hears it: only the contributor's own liveness gates a handler.
#[test]
fn a_contributor_hears_its_owner_after_the_owner_is_switched_off_but_not_once_it_failed() {
    let (app, _dir) = app_keeping(vec![&Owner, &Listener1]);
    let points = app.state::<Points>();
    points.emit(&SAID, &"turn-started");
    write_switch(app.handle(), "pt-owner", false);
    assert!(!is_started(app.handle(), "pt-owner"));
    points.emit(&SAID, &"turn-finished");
    assert_eq!(*HEARD.lock(), ["turn-started", "turn-finished"]);
    // the contributor's own failure silences it at once
    fail_for_test(app.handle(), "pt-listener");
    points.emit(&SAID, &"late");
    assert_eq!(HEARD.lock().len(), 2);
    // and a stopped contributor is retracted
    wait_stopped(&app, "pt-listener");
    assert!(!points.extended_by(SAID.id, "pt-listener"));
}

static ANSWER: Provider<(), &'static str> = Provider::new("pt-owner.answer", "pt-owner");

struct Answerer1;
impl<R: Runtime> Feature<R> for Answerer1 {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"pt-answerer","name":"Answerer"}"#
    }
    fn start(&self, app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        points::provide(app, &ANSWER, "pt-answerer", |_| Some("answered"));
        Ok(())
    }
}

struct Panicker;
impl<R: Runtime> Feature<R> for Panicker {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"aa-panicker","name":"Panicker"}"#
    }
    fn start(&self, app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        points::provide(app, &ANSWER, "aa-panicker", |_| panic!("no answer today"));
        Ok(())
    }
}

/// A provider's answer comes only from a live contributor: one that panicked fails and counts as
/// no answer (the next is asked), a failed or stopped one is skipped and retracted.
#[test]
fn a_provider_skips_a_panicking_or_failed_contributor_and_retracts_a_stopped_one() {
    let (app, _dir) = app_keeping(vec![&Owner, &Panicker, &Answerer1]);
    let points = app.state::<Points>();
    // `aa-panicker` is asked first (id order): it fails, the next contributor answers
    assert_eq!(points.ask(&ANSWER, &()), Some("answered"));
    assert!(!is_live(app.handle(), "aa-panicker"));
    wait_stopped(&app, "aa-panicker");
    assert!(!points.extended_by(ANSWER.id, "aa-panicker"));
    // a failed contributor is silent at once, then retracted
    fail_for_test(app.handle(), "pt-answerer");
    assert_eq!(points.ask(&ANSWER, &()), None);
    wait_stopped(&app, "pt-answerer");
    assert_eq!(points.contributors(ANSWER.id), 0);
    // the owner is not consulted: it may be off and still ask
    write_switch(app.handle(), "pt-owner", false);
    assert_eq!(points.ask(&ANSWER, &()), None);
}

struct Slow;
impl<R: Runtime> Feature<R> for Slow {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"slow","name":"Slow"}"#
    }
    fn start(&self, _app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        std::thread::sleep(Duration::from_millis(15));
        Ok(())
    }
}

/// Two writes of one switch around a slow `start`: the state read under the toggle lock always
/// ends as the last switch says (the switch was once read outside it, so a stop could land
/// before the start it was meant to undo).
#[test]
fn two_writers_of_a_switch_around_a_slow_start_end_in_the_state_it_says() {
    let (app, _dir) = app_keeping(vec![&Slow]);
    for round in 0..20 {
        write_switch(app.handle(), "slow", false);
        assert!(!is_started(app.handle(), "slow"));
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for on in [true, false] {
                let (handle, barrier) = (app.handle().clone(), &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    write_switch(&handle, "slow", on);
                });
            }
        });
        let switch = app
            .state::<AppState>()
            .get("main")
            .unwrap()
            .settings
            .read()
            .as_ref()
            .unwrap()
            .get_global_or_default("features.slow.enabled")
            .and_then(|v| v.as_bool())
            .unwrap();
        assert_eq!(is_started(app.handle(), "slow"), switch, "round {round}");
    }
}

static FLAKY_STARTS: AtomicUsize = AtomicUsize::new(0);
struct Flaky;
impl<R: Runtime> Feature<R> for Flaky {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"flaky","name":"Flaky"}"#
    }
    /// The first start has a thread that panics while `start` is still running.
    fn start(&self, _app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        if FLAKY_STARTS.fetch_add(1, Ordering::SeqCst) == 0 {
            scope
                .spawn("boom", |_| panic!("a thread fails during start"))
                .map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}

/// A scope thread that fails the feature before `start` returned: the feature is not left
/// started and announced while failed, and "Turn back on" starts it.
#[test]
fn a_failure_while_start_runs_leaves_the_feature_stopped_and_turn_back_on_starts_it() {
    let (app, _dir) = app_keeping(vec![&Flaky]);
    let c = app.state::<Containment>();
    assert!(!is_started(app.handle(), "flaky"), "not started");
    assert!(c.is_failed("flaky"));
    assert!(!is_live(app.handle(), "flaky"));
    assert_eq!(scope_of(app.handle(), "flaky").map(|_| ()), None);
    write_switch(app.handle(), "flaky", true);
    assert!(is_started(app.handle(), "flaky") && is_live(app.handle(), "flaky"));
    assert!(!c.is_failed("flaky"));
    assert_eq!(FLAKY_STARTS.load(Ordering::SeqCst), 2);
}
