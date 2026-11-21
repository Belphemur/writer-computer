//! The Rust half of the built-in feature `icons` (spec `SPECs/icons-spec.md`, decision
//! `docs/decisions/2026-11-18-show-file-and-folder-icons-natively-over-iconize-data-read-only.md`).
//!
//! The store, the Iconize reader, the one resolver and the re-key on move and delete live in core,
//! `crate::icons` (Tauri-free): `relocate`, the folder rename and delete call into it, and the
//! `writer icon:*` commands share it, so with the feature off they still need an answer, which is
//! "do nothing" (`icons::set_enabled`). This folder is the glue:
//!
//! - `commands.rs`: `plugin:icons|<command>` (typed through `bindings.rs`): `icons_resolved`,
//!   `icons_set`, `icons_remove`;
//! - `cli.rs`: the `icon:set`, `icon:get` and `icon:remove` commands (handlers `cli::cmd_icons`);
//! - the core flag follows the feature's life: `start` sets it, `off` (the feature is not running:
//!   switched off, failed, stopped) clears it, so a failed feature never leaves it on; the CLI
//!   has no lifecycle and calls [`apply_for_cli`];
//! - `start` also reports `icons:changed` to the window of a vault when `.writer/icons.json` or
//!   Iconize's data changes, from the app's one file watcher (`FeatureScope::observe`, removed
//!   when the feature stops).
//!
//! Switched off (`features.icons.enabled`): its commands answer `FeatureUnavailable`, the web
//! half goes at once, nothing is read or written, and the watcher observer is removed.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::scope::FeatureScope;
use crate::features::{self, Feature, InvokeHandler, Manifest};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Runtime};

const MANIFEST: &str = include_str!("../feature.json");
/// The event a window gets when its vault's icons changed on disk.
pub const CHANGED_EVENT: &str = "icons:changed";

pub struct Icons;

impl<R: Runtime> Feature<R> for Icons {
    fn manifest_source(&self) -> &'static str {
        MANIFEST
    }

    /// The three `plugin:icons|*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn start(&self, app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        crate::icons::set_enabled(true);
        let handle = app.clone();
        scope
            .observe(Box::new(move |label, root, paths, _own| {
                if paths.iter().any(|p| is_icons_file(root, p)) {
                    let _ = handle.emit_to(label, CHANGED_EVENT, ());
                }
            }))
            .map_err(|e| e.to_string())
    }

    fn off(&self) {
        crate::icons::set_enabled(false);
    }
}

pub fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("icons feature.json parses")
}

/// Is `path` one of the two files the icons come from (Writer's, Iconize's) in the vault `root`?
fn is_icons_file(root: &Path, path: &Path) -> bool {
    let ours: PathBuf = root.join(".writer").join(crate::icons::FILE);
    path == ours || path == root.join(crate::icons::ICONIZE_FILE)
}

/// The `writer` CLI has no settings layer: it honours the kill switch read from the global
/// `config` file.
pub fn apply_for_cli(data_dir: &Path) {
    crate::icons::set_enabled(features::cli_enabled(data_dir, &manifest().id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::ipc_tests::{app_with, request};
    use crate::state::AppState;
    use serde_json::json;
    use tauri::test::{get_ipc_response, MockRuntime};
    use tauri::{Manager, WebviewWindowBuilder};

    fn call(
        app: &tauri::App<MockRuntime>,
        label: &str,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if app.get_webview_window(label).is_none() {
            WebviewWindowBuilder::new(app, label, Default::default())
                .build()
                .unwrap();
        }
        let w = app.get_webview_window(label).unwrap();
        get_ipc_response(&w, request(&format!("plugin:icons|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    fn app() -> tauri::App<MockRuntime> {
        let features: Vec<&'static dyn Feature<MockRuntime>> = vec![&Icons];
        let app = app_with(features);
        app.manage(AppState::new());
        app
    }

    #[test]
    fn the_manifest_names_the_hook_the_commands_and_the_cli_commands() {
        let m = manifest();
        assert_eq!(m.id, "icons");
        assert_eq!(m.rust.hooks, ["start"]);
        assert_eq!(m.rust.events, [CHANGED_EVENT]);
        let raw: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        let cli: Vec<_> = cli::COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(raw["rust"]["cliCommands"], json!(cli));
        assert!(cli::COMMANDS.iter().all(|c| c.feature == Some("icons")));
        assert!(m.has_rust());
    }

    #[test]
    fn only_the_two_icon_files_of_a_vault_are_reported() {
        let root = Path::new("/vault");
        assert!(is_icons_file(root, Path::new("/vault/.writer/icons.json")));
        assert!(is_icons_file(
            root,
            Path::new("/vault/.obsidian/plugins/obsidian-icon-folder/data.json")
        ));
        assert!(!is_icons_file(root, Path::new("/vault/.writer/config")));
        assert!(!is_icons_file(root, Path::new("/vault/Notes/icons.json")));
        assert!(!is_icons_file(root, Path::new("/other/.writer/icons.json")));
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let _on = crate::icons::TEST_SWITCH.lock();
        let app = app();
        for cmd in &manifest().rust.commands {
            for label in ["main", "w-1"] {
                let r = call(&app, label, cmd, json!({"paths": [], "icon": "emoji:✅"}));
                assert!(
                    !r.as_ref().err().is_some_and(|e| e.contains("not allowed")),
                    "{cmd} from {label}: {r:?}"
                );
            }
            let err = call(
                &app,
                "stranger",
                cmd,
                json!({"paths": [], "icon": "emoji:✅"}),
            )
            .unwrap_err();
            assert!(err.contains("not allowed"), "{cmd} from stranger: {err}");
        }
    }

    #[test]
    fn a_command_without_a_vault_says_so() {
        let _on = crate::icons::TEST_SWITCH.lock();
        let app = app();
        let err = call(&app, "main", "icons_resolved", json!({})).unwrap_err();
        assert!(err.contains("No workspace"), "{err}");
    }

    #[test]
    fn set_resolve_and_remove_run_over_the_window_vault_and_confine_paths() {
        let _on = crate::icons::TEST_SWITCH.lock();
        let app = app();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/Idea.md"), "# Idea\n").unwrap();
        let data = root.join(".obsidian/plugins/obsidian-icon-folder");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("data.json"),
            r#"{"settings":{},"Notes":"📁","Packed.md":"IbBell"}"#,
        )
        .unwrap();
        *app.state::<AppState>()
            .get_or_create("main")
            .workspace_root
            .write() = Some(root.clone());

        call(
            &app,
            "main",
            "icons_set",
            json!({"paths": [root.join("Notes/Idea.md").to_string_lossy()], "icon": "icon:Rocket01Icon", "color": "#112233"}),
        )
        .unwrap();
        let r = call(&app, "main", "icons_resolved", json!({})).unwrap();
        assert_eq!(
            r["iconizeUnsupported"], 1,
            "the IbBell pack icon is counted, not shown"
        );
        let rows = r["icons"].as_array().unwrap();
        let find = |p: &str| rows.iter().find(|x| x["path"] == p).cloned();
        assert_eq!(find("Notes/Idea.md").unwrap()["icon"], "icon:Rocket01Icon");
        assert_eq!(find("Notes/Idea.md").unwrap()["color"], "#112233");
        assert_eq!(find("Notes/Idea.md").unwrap()["source"], "writer");
        assert_eq!(find("Notes").unwrap()["source"], "iconize");

        // a path outside the vault, a missing file and `.obsidian` are refused; nothing changes
        for bad in ["../x.md", "/etc/hosts", "Nope.md", ".obsidian/app.json"] {
            let e = call(
                &app,
                "main",
                "icons_set",
                json!({"paths": [bad], "icon": "emoji:✅"}),
            );
            assert!(e.is_err(), "{bad}");
        }
        let e = call(
            &app,
            "main",
            "icons_set",
            json!({"paths": ["Notes"], "icon": "smile"}),
        );
        assert!(e.is_err());

        call(
            &app,
            "main",
            "icons_remove",
            json!({"paths": ["Notes", "Notes/Idea.md"]}),
        )
        .unwrap();
        let r = call(&app, "main", "icons_resolved", json!({})).unwrap();
        assert!(r["icons"].as_array().unwrap().is_empty(), "{r}");
        assert!(std::fs::read_to_string(data.join("data.json"))
            .unwrap()
            .contains("\"Notes\":\"📁\""));
    }

    #[test]
    fn the_core_flag_follows_the_feature_and_the_cli_reads_the_config_file() {
        let _lock = crate::icons::TEST_SWITCH.lock();
        let app = app();
        let wait = |want: bool| {
            let start = std::time::Instant::now();
            while crate::icons::enabled() != want {
                assert!(
                    start.elapsed() < std::time::Duration::from_secs(10),
                    "{want}"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        assert!(crate::icons::enabled(), "started: on");
        features::fail_for_test(app.handle(), "icons");
        wait(false);
        assert!(!features::is_live(app.handle(), "icons"));
        // "Turn back on": the switch is written again
        features::settings_written(app.handle(), "features.icons.enabled");
        assert!(crate::icons::enabled() && features::is_live(app.handle(), "icons"));
        features::stop_feature(app.handle(), "icons", true);
        assert!(!crate::icons::enabled(), "stopped: off");

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config"),
            "features.icons.enabled = false\n",
        )
        .unwrap();
        apply_for_cli(dir.path());
        assert!(!crate::icons::enabled(), "the CLI reads the config file");
        std::fs::write(dir.path().join("config"), "features.icons.enabled = true\n").unwrap();
        apply_for_cli(dir.path());
        assert!(crate::icons::enabled());
    }
}
