//! The runner and the ACL under Tauri's mock runtime, with the REAL build-time context
//! (`crate::context()`: the actual capabilities and inlined-plugin permissions). `run_iteration`
//! is the only way to run `setup` there; it is deprecated for its busy loop, fine in a test.
#![allow(deprecated)]

use super::tests::settings_with;
use super::{fixture, install_features, Feature, Running};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};

const LOCAL: &str = if cfg!(any(windows, target_os = "android")) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

pub(super) fn request(cmd: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: LOCAL.parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

/// The real context (capabilities and permissions) without the configured window: that one asks
/// for a vibrancy effect, which calls AppKit on the mock runtime's fake `NSWindow` and segfaults.
/// The `main` window is created by hand, so the ACL still sees the label it grants.
pub(super) fn test_context() -> tauri::Context<MockRuntime> {
    let mut context = crate::context::<MockRuntime>();
    context.config_mut().app.windows.clear();
    context
}

pub(super) fn with_main_window(app: &tauri::App<MockRuntime>) {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .unwrap();
}

/// A feature whose `setup` always fails, next to a healthy one.
struct Broken;
impl<R: Runtime> Feature<R> for Broken {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"broken","name":"Broken"}"#
    }
    fn setup(&self, _app: &AppHandle<R>) -> Result<(), String> {
        Err("forced setup error".into())
    }
}

static HEALTHY_SETUPS: Mutex<usize> = Mutex::new(0);
struct Healthy;
impl<R: Runtime> Feature<R> for Healthy {
    fn manifest_source(&self) -> &'static str {
        r#"{"id":"healthy","name":"Healthy"}"#
    }
    fn setup(&self, _app: &AppHandle<R>) -> Result<(), String> {
        *HEALTHY_SETUPS.lock().unwrap() += 1;
        Ok(())
    }
}

/// An app built like `run()`: the real context, features installed from `setup`.
pub(super) fn app_with(
    features: Vec<&'static dyn Feature<MockRuntime>>,
) -> tauri::App<MockRuntime> {
    let dir = tempfile::tempdir().unwrap();
    let settings = settings_with(dir.path(), &[]);
    let mut app = mock_builder()
        .setup(move |app| {
            install_features(app.handle(), features, &settings);
            Ok(())
        })
        .build(test_context())
        .expect("the app builds");
    app.run_iteration(|_, _| {});
    with_main_window(&app);
    app
}

#[test]
fn a_failing_feature_setup_does_not_stop_the_app_or_the_other_features() {
    let app = app_with(vec![&Broken, &Healthy]);
    assert!(
        app.get_webview_window("main").is_some(),
        "the app started and its window exists"
    );
    assert!(app.try_state::<Running<MockRuntime>>().is_some());
    assert_eq!(*HEALTHY_SETUPS.lock().unwrap(), 1);
}

#[test]
fn a_feature_plugin_without_build_time_permissions_is_rejected_by_the_acl() {
    // `fixture-hello` has no inlined plugin in `build.rs` (its data is under tests/), so the real
    // context has no permission for it: the call is refused before it reaches the handler. This is
    // the guard that a feature needs its manifest, `build.rs` ACL and capability file to be callable.
    let app = app_with(fixture::registry::<MockRuntime>());
    let w = app.get_webview_window("main").unwrap();
    let err = get_ipc_response(
        &w,
        request("plugin:fixture-hello|hello_greet", json!({ "name": "a" })),
    )
    .unwrap_err();
    assert!(err.to_string().contains("not allowed"), "{err}");
}

#[test]
fn plain_app_commands_are_not_gated_by_the_feature_acl() {
    #[tauri::command]
    fn app_cmd() -> &'static str {
        "ok"
    }
    let mut app = mock_builder()
        .invoke_handler(tauri::generate_handler![app_cmd])
        .build(test_context())
        .unwrap();
    app.run_iteration(|_, _| {});
    with_main_window(&app);
    let w = app.get_webview_window("main").unwrap();
    let r: Value = get_ipc_response(&w, request("app_cmd", json!({})))
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(r, "ok");
}
