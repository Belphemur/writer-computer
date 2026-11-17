//! The Rust half of the built-in feature `obsidian-host` (SPECs/builtin-plugins-spec.md step 5).
//!
//! Deliberately not a `Feature` in `registry()`: the plugin host's commands keep their plain
//! names (`plugins_state`, `plugin_http_request`, ...) because the API shim calls them by name
//! and a `plugin:obsidian-host|*` route would rename every caller; they stay registered by the
//! app and the feature gates them (`manifest.rust.gatedCommands`, one list). Its state
//! (`ProcManager`, `StreamRegistry`, `PluginEnv`) stays managed by the app and its window-close
//! and exit cleanup stays in core (`commands::plugins::stop_window_work`, the exit arm in
//! `lib.rs`): a user can switch the feature on mid-session, and a process the host started
//! must then still die with its window and with the app, which a hook that only runs for a
//! feature that was on at launch cannot promise. The switch is read live, so it applies at once.
//!
//! Off, safe mode or failed: every gated command answers `FeatureUnavailable` and the
//! `writer-plugin://` scheme refuses (`commands::plugins::handle_scheme`), so no plugin file is
//! served and no plugin runs. Nothing here writes to a vault: the plugin data and trust files are
//! written by the same code as before, and only for a plugin that is running.

use crate::features::{self, Manifest};
use tauri::ipc::Invoke;
use tauri::{AppHandle, Runtime};

const MANIFEST: &str = include_str!("../feature.json");

pub fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("obsidian-host feature.json parses")
}

/// May the plugin host run now (the switch is on, no failure, not in safe mode)?
pub fn is_live<R: Runtime>(app: &AppHandle<R>) -> bool {
    features::is_live(app, &manifest())
}

/// The app's invoke handler with the host's commands gated by the feature.
pub fn gated<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    features::gate(manifest(), handler)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::install_features;
    use crate::features::ipc_tests::{request, test_context, with_main_window};
    use crate::features::tests::settings_with;
    use crate::state::AppState;
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime};
    use tauri::Manager;

    fn tauri_commands(file: &str) -> BTreeSet<String> {
        let src =
            std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file))
                .unwrap();
        let mut out = BTreeSet::new();
        let mut lines = src.lines();
        while let Some(l) = lines.next() {
            if l.trim() != "#[tauri::command]" {
                continue;
            }
            for next in lines.by_ref() {
                if let Some(rest) = next.trim().strip_prefix("pub async fn ") {
                    out.insert(rest.split('(').next().unwrap().to_string());
                    break;
                }
                if let Some(rest) = next.trim().strip_prefix("pub fn ") {
                    out.insert(rest.split('(').next().unwrap().to_string());
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn the_gated_list_is_every_plugin_command_but_the_secret_ones() {
        // The one list is the manifest; it must follow `commands/plugins.rs` and `lib.rs`.
        let gated: BTreeSet<String> = manifest().rust.gated_commands.into_iter().collect();
        let defined = tauri_commands("src/commands/plugins.rs");
        let expected: BTreeSet<String> = defined
            .iter()
            .filter(|c| !c.starts_with("secrets_"))
            .cloned()
            .collect();
        assert_eq!(gated, expected, "feature.json rust.gatedCommands drifted");
        let lib = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .unwrap();
        for c in &gated {
            assert!(
                lib.contains(&format!("commands::plugins::{c},")),
                "{c} is not registered in lib.rs"
            );
        }
        // The secret commands back Settings > Secrets (core) and stay ungated.
        assert!(!gated.iter().any(|c| c.starts_with("secrets_")));
    }

    static CALLS: AtomicUsize = AtomicUsize::new(0);

    fn app(enabled: Option<bool>, dir: &std::path::Path) -> tauri::App<MockRuntime> {
        let settings = settings_with(
            dir,
            &enabled
                .map(|e| vec![("features.obsidian-host.enabled", e)])
                .unwrap_or_default(),
        );
        let mut app = mock_builder()
            .manage(AppState::new())
            .invoke_handler(gated::<MockRuntime>(|invoke| {
                CALLS.fetch_add(1, Ordering::SeqCst);
                invoke.resolver.resolve(());
                true
            }))
            .setup(move |app| {
                install_features(app.handle(), vec![], &settings);
                Ok(())
            })
            .build(test_context())
            .unwrap();
        app.run_iteration(|_, _| {});
        with_main_window(&app);
        app
    }

    fn set_switch(app: &tauri::App<MockRuntime>, dir: &std::path::Path, on: bool) {
        let state = app
            .state::<AppState>()
            .get_or_create(crate::MAIN_WINDOW_LABEL);
        *state.settings.write() = Some(settings_with(
            dir,
            &[("features.obsidian-host.enabled", on)],
        ));
    }

    #[test]
    fn off_refuses_the_host_commands_and_the_scheme_but_not_other_commands() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(None, dir.path());
        set_switch(&app, dir.path(), false);
        let w = app.get_webview_window("main").unwrap();
        let before = CALLS.load(Ordering::SeqCst);
        let err = get_ipc_response(&w, request("plugins_state", serde_json::json!({})))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Feature unavailable: obsidian-host"), "{err}");
        let err = get_ipc_response(&w, request("plugin_read_asset", serde_json::json!({})))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Feature unavailable"), "{err}");
        assert_eq!(CALLS.load(Ordering::SeqCst), before, "no handler ran");
        assert!(!is_live(app.handle()), "the scheme handler reads this");
        // an app command, and the ungated secret list, still reach the handler
        get_ipc_response(&w, request("secrets_list_ids", serde_json::json!({}))).unwrap();
        get_ipc_response(&w, request("read_file", serde_json::json!({}))).unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), before + 2);

        // switched on: applies at once (the setting is read live)
        set_switch(&app, dir.path(), true);
        assert!(is_live(app.handle()));
        get_ipc_response(&w, request("plugins_state", serde_json::json!({}))).unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), before + 3);
    }

    #[test]
    fn a_failed_host_is_not_live_whatever_its_switch_says() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(Some(true), dir.path());
        assert!(is_live(app.handle()));
        crate::features::fail_for_test(app.handle(), "obsidian-host");
        assert!(!is_live(app.handle()));
        let w = app.get_webview_window("main").unwrap();
        let err = get_ipc_response(&w, request("plugins_state", serde_json::json!({})))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Feature unavailable"), "{err}");
    }
}
