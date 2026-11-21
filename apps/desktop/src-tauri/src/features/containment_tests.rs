//! Failure containment and crash recovery under Tauri's mock runtime (ADR 2026-11-17 "contain
//! feature failures with unwinding panics and recover from native crashes on the next launch").
//! Test-only features panic in `setup`, in each hook, in a command and in a spawned thread; each
//! case leaves the app running, the feature `failed`, the other feature untouched, one error log
//! line without the panic payload, and `features:failed` emitted. The recovery tests drive
//! `boot` and `install` with markers left by another process.
#![allow(deprecated)]

use super::recovery::{Active, Files, Marker};
use super::tests::settings_with;
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::test::{get_ipc_response, mock_app, mock_builder, MockRuntime};
use tauri::Listener;

const PAYLOAD: &str = "SECRET note text from /Users/someone/vault/private.md";

/// Panics at the named boundary (`setup`, `open`, `close`, `exit`), is calm everywhere else.
struct Boom {
    manifest: &'static str,
    at: &'static str,
}

impl<R: Runtime> Feature<R> for Boom {
    fn manifest_source(&self) -> &'static str {
        self.manifest
    }
    fn start(&self, _app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        if self.at == "setup" {
            panic!("{PAYLOAD}");
        }
        Ok(())
    }
    fn on_workspace_open(&self, _app: &AppHandle<R>, _w: &WindowCtx<'_>) {
        if self.at == "open" {
            panic!("{PAYLOAD}");
        }
    }
    fn on_workspace_close(&self, _app: &AppHandle<R>, _label: &str) {
        if self.at == "close" {
            panic!("{PAYLOAD}");
        }
    }
    fn on_exit(&self, _app: &AppHandle<R>) {
        if self.at == "exit" {
            panic!("{PAYLOAD}");
        }
    }
}

/// Records its hooks into a log of its own (tests run in parallel).
struct Calm(&'static Mutex<Vec<String>>);
impl<R: Runtime> Feature<R> for Calm {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"calm","name":"Calm"}"#
    }
    fn on_workspace_open(&self, _app: &AppHandle<R>, w: &WindowCtx<'_>) {
        self.0.lock().push(format!("open({})", w.label));
    }
    fn on_workspace_close(&self, _app: &AppHandle<R>, label: &str) {
        self.0.lock().push(format!("close({label})"));
    }
    fn on_exit(&self, _app: &AppHandle<R>) {
        self.0.lock().push("exit".into());
    }
}

fn leak<F: Feature<MockRuntime> + 'static>(f: F) -> &'static dyn Feature<MockRuntime> {
    Box::leak(Box::new(f))
}

fn failed_events(app: &tauri::App<MockRuntime>) -> Arc<Mutex<Vec<String>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    app.listen(FAILED_EVENT, move |e| {
        sink.lock().push(e.payload().to_string())
    });
    seen
}

fn is_failed(app: &tauri::App<MockRuntime>, id: &str) -> bool {
    app.state::<Containment>().is_failed(id)
}

/// Runs `f` with the real log pipeline captured (`log` bridged into a file subscriber on this
/// thread); returns the written lines.
fn captured_log(f: impl FnOnce()) -> Vec<String> {
    let _ = tracing_log::LogTracer::init();
    let dir = tempfile::tempdir().unwrap();
    let built = crate::logging::build(
        dir.path(),
        "writer",
        tracing::level_filters::LevelFilter::INFO,
    )
    .unwrap();
    tracing::dispatcher::with_default(&built.dispatch, f);
    drop(built); // flushes the writer thread
    let mut lines = Vec::new();
    for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
        lines.extend(
            std::fs::read_to_string(entry.path())
                .unwrap()
                .lines()
                .map(str::to_owned),
        );
    }
    lines
}

fn assert_one_clean_line(lines: &[String], id: &str, boundary: &str) {
    let ours: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains(&format!("feature {id} failed in {boundary}")))
        .collect();
    assert_eq!(ours.len(), 1, "{lines:?}");
    for l in lines {
        assert!(
            !l.contains("SECRET") && !l.contains("/Users/someone") && !l.contains("private.md"),
            "the log carries the panic payload: {l}"
        );
    }
}

fn run_boundary(at: &'static str, boundary: &str) {
    let manifest: &'static str =
        Box::leak(format!(r#"{{"id":"boom-{at}","name":"Boom"}}"#).into_boxed_str());
    let id = format!("boom-{at}");
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let app = mock_app();
    let events = failed_events(&app);
    let calm_log: &'static Mutex<Vec<String>> = Box::leak(Box::new(Mutex::new(Vec::new())));

    let lines = captured_log(|| {
        install_features(
            app.handle(),
            vec![leak(Boom { manifest, at }), leak(Calm(calm_log))],
            &settings,
        );
        workspace_open(app.handle(), "w-1", Path::new("/vault"));
        workspace_close(app.handle(), "w-1");
        exit(app.handle());
    });

    assert!(is_failed(&app, &id), "{at}: the feature is failed");
    assert!(
        !is_failed(&app, "calm"),
        "{at}: the other feature is untouched"
    );
    assert_one_clean_line(&lines, &id, boundary);
    let seen = events.lock().clone();
    assert_eq!(seen.len(), 1, "{at}: one features:failed, got {seen:?}");
    assert!(
        seen[0].contains(&id) && seen[0].contains(boundary),
        "{seen:?}"
    );
    assert!(!seen[0].contains("SECRET"));
    // the other feature still got every hook that came after the panic
    let calm = calm_log.lock().clone();
    assert_eq!(calm, ["open(w-1)", "close(w-1)", "exit"], "{at}: {calm:?}");
    assert!(
        app.try_state::<Running<MockRuntime>>().is_some(),
        "{at}: the app runs"
    );
}

#[test]
fn a_panic_in_setup_fails_that_feature_only() {
    run_boundary("setup", "setup");
}

#[test]
fn a_panic_in_a_hook_fails_that_feature_only_and_the_others_still_get_the_hook() {
    run_boundary("open", "on_workspace_open");
    run_boundary("close", "on_workspace_close");
    run_boundary("exit", "on_exit");
}

#[test]
fn a_failed_feature_gets_no_further_hooks() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let app = mock_app();
    let events = failed_events(&app);
    static OPENS: AtomicUsize = AtomicUsize::new(0);
    struct Counts;
    impl<R: Runtime> Feature<R> for Counts {
        fn manifest_source(&self) -> &'static str {
            r#"{"id":"counts","name":"Counts"}"#
        }
        fn on_workspace_open(&self, _app: &AppHandle<R>, _w: &WindowCtx<'_>) {
            OPENS.fetch_add(1, Ordering::SeqCst);
            panic!("{PAYLOAD}");
        }
    }
    install_features(app.handle(), vec![leak(Counts)], &settings);
    workspace_open(app.handle(), "a", Path::new("/v"));
    workspace_open(app.handle(), "b", Path::new("/v"));
    assert_eq!(
        OPENS.load(Ordering::SeqCst),
        1,
        "not resumed after it panicked"
    );
    assert_eq!(events.lock().len(), 1);
}

#[test]
fn a_panicking_command_is_contained_then_answers_feature_unavailable() {
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let handler: InvokeHandler<MockRuntime> = Box::new(|_invoke| {
        CALLS.fetch_add(1, Ordering::SeqCst);
        panic!("{PAYLOAD}");
    });
    // an app-level handler (the ACL gates plugin commands, which is `ipc_tests`' subject): the
    // wrapper under test is the same one `plugin_of` puts around a feature's handler
    let mut app = mock_builder()
        .invoke_handler(contain("cmd-boom".into(), handler))
        .setup(move |app| {
            install_features(app.handle(), vec![], &settings);
            Ok(())
        })
        .build(super::ipc_tests::test_context())
        .unwrap();
    app.run_iteration(|_, _| {});
    super::ipc_tests::with_main_window(&app);
    let events = failed_events(&app);
    let w = app.get_webview_window("main").unwrap();
    let call = || {
        get_ipc_response(
            &w,
            super::ipc_tests::request("anything", serde_json::json!({})),
        )
    };

    let lines = captured_log(|| {
        let first = call().unwrap_err().to_string();
        assert!(first.contains("Feature unavailable: cmd-boom"), "{first}");
        let second = call().unwrap_err().to_string();
        assert!(second.contains("Feature unavailable: cmd-boom"), "{second}");
    });
    assert_eq!(
        CALLS.load(Ordering::SeqCst),
        1,
        "the second call never reaches the handler"
    );
    assert!(is_failed(&app, "cmd-boom"));
    assert_one_clean_line(&lines, "cmd-boom", "command");
    assert_eq!(events.lock().len(), 1);
}

#[test]
fn a_panic_in_a_scope_thread_fails_the_feature_stops_it_and_not_the_app() {
    struct Worker;
    impl<R: Runtime> Feature<R> for Worker {
        fn manifest_source(&self) -> &'static str {
            r#"{"id":"thread-boom","name":"Thread boom"}"#
        }
        fn start(&self, _app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
            scope
                .spawn("boom-worker", |_| panic!("{PAYLOAD}"))
                .map_err(|e| e.to_string())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let app = mock_app();
    let events = failed_events(&app);
    install_features(app.handle(), vec![leak(Worker)], &settings);
    let start = std::time::Instant::now();
    while !is_failed(&app, "thread-boom") && start.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(is_failed(&app, "thread-boom"));
    let seen = events.lock().clone();
    assert!(
        seen.len() == 1 && seen[0].contains("thread:boom-worker"),
        "{seen:?}"
    );
    // a failed feature is released: it is no longer started and holds nothing
    while is_started(app.handle(), "thread-boom")
        && start.elapsed() < std::time::Duration::from_secs(5)
    {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(!is_started(app.handle(), "thread-boom"));
}

#[test]
fn a_boundary_that_may_crash_natively_keeps_a_marker_only_while_it_runs() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let app = mock_app();
    let files = Files::new(dir.path());
    install_booted(
        app.handle(),
        vec![],
        &settings,
        Boot {
            files: Some(files.clone()),
            safe_mode: false,
            crashed: vec![],
        },
    );
    let inside = guard(app.handle(), "m", Boundary::Setup, || {
        files.read_all().inside
    })
    .unwrap();
    let marker = inside.expect("the marker is there while the code runs");
    assert_eq!(
        (marker.id.as_str(), marker.boundary.as_str()),
        ("m", "setup")
    );
    assert_eq!(marker.pid, std::process::id());
    assert!(files.read_all().inside.is_none(), "removed after");
    // a command is covered by catch_unwind alone: no file IO per call
    let during = guard(app.handle(), "m", Boundary::Command, || {
        files.read_all().inside
    })
    .unwrap();
    assert!(during.is_none());
    // nested: leaving the inner boundary restores the outer marker
    guard(app.handle(), "m", Boundary::Setup, || {
        guard(app.handle(), "m", Boundary::Exit, || {
            assert_eq!(files.read_all().inside.unwrap().boundary, "on_exit");
        })
        .unwrap();
        assert_eq!(files.read_all().inside.unwrap().boundary, "setup");
    })
    .unwrap();
    assert!(files.read_all().inside.is_none());
}

#[test]
fn declared_native_code_is_recorded_while_live_and_cleared_on_a_clean_exit() {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let app = mock_app();
    let files = Files::new(dir.path());
    install_booted(
        app.handle(),
        vec![],
        &settings,
        Boot {
            files: Some(files.clone()),
            safe_mode: false,
            crashed: vec![],
        },
    );
    // the marker names the narrow setting while the install runs
    let value = native(app.handle(), "fx", "features.fx.native", || {
        let m = files.read_all().inside.unwrap();
        assert_eq!(m.setting.as_deref(), Some("features.fx.native"));
        Ok(7)
    })
    .unwrap();
    assert_eq!(value, 7);
    let active = files.read_all().active;
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "fx");
    assert_eq!(active[0].setting.as_deref(), Some("features.fx.native"));

    // an install that fails or panics is not recorded as live
    assert!(native::<_, ()>(
        app.handle(),
        "fy",
        "features.fy.native",
        || Err("no".into())
    )
    .is_err());
    assert!(
        native::<_, ()>(app.handle(), "fz", "features.fz.native", || panic!(
            "{PAYLOAD}"
        ))
        .is_err()
    );
    assert_eq!(files.read_all().active.len(), 1);
    assert!(is_failed(&app, "fz"));

    exit(app.handle());
    assert!(
        files.read_all().active.is_empty(),
        "a clean exit leaves nothing live"
    );
}

/// A process that is not this one, for a stale marker.
fn other_pid() -> u32 {
    std::process::id().wrapping_add(1)
}

#[test]
fn a_crash_while_native_code_was_live_turns_its_setting_off_on_the_next_launch() {
    let dir = tempfile::tempdir().unwrap();
    let files = Files::new(dir.path());
    // what the previous process left: native code of the tables feature live under a narrow
    // setting, and a death inside the agent's setup
    files.write_active(&[Active {
        id: "tables".into(),
        pid: other_pid(),
        at: 1,
        setting: Some("features.tables.enabled".into()),
    }]);
    files.write_inside(&Marker {
        id: "agent".into(),
        boundary: "setup".into(),
        pid: other_pid(),
        at: 2,
        setting: None,
    });
    let mut settings = settings_with(dir.path(), &[]);
    let booted = boot(dir.path(), &mut settings);

    let off = |key: &str| {
        settings
            .get_global_or_default(key)
            .and_then(|v| v.as_bool())
    };
    assert_eq!(off("features.tables.enabled"), Some(false));
    assert_eq!(off("features.agent.enabled"), Some(false));
    assert!(!booted.safe_mode);
    let found = files.read_all();
    assert!(
        found.inside.is_none() && found.active.is_empty(),
        "stale markers are consumed"
    );
    assert_eq!(
        found.failed_startups, 1,
        "this launch counts until it is ready"
    );

    // the plan reaches the webview for the notice, and the disabled features are not planned
    let app = mock_app();
    install_booted(app.handle(), registry::<MockRuntime>(), &settings, booted);
    let status = status(app.handle());
    let mut ids: Vec<&str> = status
        .crash_disabled
        .iter()
        .map(|d| d.id.as_str())
        .collect();
    ids.sort();
    assert_eq!(ids, ["agent", "tables"]);
    assert!(!is_started(app.handle(), "agent"));
    assert!(!is_started(app.handle(), "tables"));
}

#[test]
fn two_failed_startups_start_safe_mode_and_ready_resets_the_counter() {
    let dir = tempfile::tempdir().unwrap();
    let files = Files::new(dir.path());
    files.write_failed_startups(2);
    let mut settings = settings_with(dir.path(), &[]);
    let booted = boot(dir.path(), &mut settings);
    assert!(booted.safe_mode);
    // safe mode never rewrites the user's settings
    assert_eq!(
        settings
            .get_global_or_default("features.agent.enabled")
            .and_then(|v| v.as_bool()),
        Some(true)
    );

    let app = mock_app();
    install_booted(app.handle(), registry::<MockRuntime>(), &settings, booted);
    assert!(status(app.handle()).safe_mode);
    assert!(
        started_ids(app.handle()).is_empty(),
        "no feature starts in safe mode"
    );
    assert_eq!(
        files.read_all().failed_startups,
        3,
        "the safe-mode launch counts too"
    );

    mark_ready(app.handle());
    assert_eq!(files.read_all().failed_startups, 0);
    // "Restart normally" resets it as well
    files.write_failed_startups(4);
    forget_failed_startups(app.handle());
    assert_eq!(files.read_all().failed_startups, 0);

    // the next launch is normal
    let mut settings = settings_with(dir.path(), &[]);
    assert!(!boot(dir.path(), &mut settings).safe_mode);
}
