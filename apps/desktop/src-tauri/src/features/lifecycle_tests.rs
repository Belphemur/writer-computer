//! The lifecycle guardrails of ADR 2026-11-20 "start and stop features live through an owning
//! scope, with leak guardrails": a generic cycle test over the registry, the handshake events
//! and the stop-time leak check. A new feature is covered the day it is added to `registry()`.
#![allow(deprecated)]

use super::ipc_tests::{test_context, with_main_window};
use super::lifecycle::{self, Settle};
use super::scope::{describe, Kind};
use super::tests::settings_with;
use super::*;
use crate::state::AppState;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tauri::test::{mock_builder, MockRuntime};
use tauri::Listener;

fn app_with(features: Vec<&'static dyn Feature<MockRuntime>>) -> tauri::App<MockRuntime> {
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
    app
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
