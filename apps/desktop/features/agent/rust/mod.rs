//! Pilot 3 of the built-in features (SPECs/builtin-plugins-spec.md): the agent pane's Rust half.
//!
//! The pure agent code (`crate::agent`: stream mapper, runner, chat store, project library) is
//! Tauri-free and stays where the `writer` CLI and the integration tests reach it; this folder is
//! the glue that owns the Tauri-facing parts: the managed [`AgentSessions`] state, the hooks that
//! stop the CLI processes of a closed window and at exit, and the `plugin:agent|<command>`
//! handlers (`commands/`, listed once in `bindings.rs` for the invoke handler and the TypeScript
//! bindings). The event `agent:event` carries every chat event to its window.
//!
//! With `features.agent.enabled` off the runner never calls [`Feature::setup`], so no state exists
//! and no hook runs. The idle reaper thread of `AgentSessions` still starts with the state, as it
//! always did (one sleeping thread). The feature contributes no bundled skills: the managed skills
//! (`writer-cli`, `writer-search`, `writer-bases`) are for any agent working in a vault, not for
//! this pane.
//!
//! Containment: the idle reaper thread starts through `features::spawn` (a panic in it fails the
//! agent, not the app); the per-chat event pumps still start inside the Tauri-free
//! `agent::session` and are covered by the process-level recovery only.
//! Spec: `SPECs/native-agent-spec.md`.

mod bindings;
mod commands;

use crate::agent::project_context::ProjectLibrary;
use crate::agent::session::{AgentSessions, Timing};
use crate::features::{Feature, InvokeHandler};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

pub struct Agent;

/// The sessions of this app, if the feature started.
fn sessions<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, AgentSessions>> {
    app.try_state::<AgentSessions>()
}

impl<R: Runtime> Feature<R> for Agent {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    /// The `plugin:agent|agent_*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn setup(&self, app: &AppHandle<R>) -> Result<(), String> {
        // Agent projects: the runner resolves cwd and the appended system prompt through this port.
        let state = AgentSessions::with_spawner(Timing::default(), &|name, f| {
            crate::features::spawn(app, "agent", name, f)
                .map(drop)
                .map_err(|e| e.to_string())
        })?;
        state.ports().set_project(Arc::new(ProjectLibrary));
        if !app.manage(state) {
            return Err("AgentSessions is already managed".into());
        }
        // Config files the running CLIs read at start (skills, `.mcp.json`, settings, CLAUDE.md):
        // the app's one file watcher reports them, `agent::config_sync` decides what is stale.
        let handle = app.clone();
        crate::watcher::observe_paths(Box::new(move |label, root, paths| {
            if let Some(s) = sessions(&handle) {
                s.config_paths_changed(label, root, paths);
            }
        }));
        Ok(())
    }

    /// The window closed or left its vault: its chats' CLI processes go with it.
    fn on_workspace_close(&self, app: &AppHandle<R>, label: &str) {
        if let Some(s) = sessions(app) {
            s.kill_window(label);
        }
    }

    /// `RunEvent::Exit`: no CLI process outlives the app.
    fn on_exit(&self, app: &AppHandle<R>) {
        if let Some(s) = sessions(app) {
            s.kill_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ConfigValue, Settings};
    use crate::features::ipc_tests::{app_with, request};
    use crate::features::{exit, install_features, plan, workspace_close, Manifest};
    use crate::state::AppState;
    use serde_json::json;
    use tauri::test::{get_ipc_response, mock_app, MockRuntime};
    use tauri::WebviewWindowBuilder;

    fn settings(on: Option<bool>) -> (tempfile::TempDir, Settings) {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::new(dir.path().to_path_buf()).unwrap();
        if let Some(on) = on {
            s.set_global("features.agent.enabled", ConfigValue::Bool(on))
                .unwrap();
        }
        (dir, s)
    }

    fn agent() -> Vec<&'static dyn Feature<MockRuntime>> {
        vec![&Agent]
    }

    #[test]
    fn the_manifest_names_the_hooks_the_feature_implements() {
        let m: Manifest = serde_json::from_str(include_str!("../feature.json")).unwrap();
        assert_eq!(m.id, "agent");
        assert_eq!(m.rust.hooks, ["setup", "onWorkspaceClose", "onExit"]);
        assert!(m.has_rust());
    }

    #[test]
    fn enabled_it_manages_the_sessions_and_the_hooks_run_without_a_session() {
        let (_dir, s) = settings(None);
        let app = mock_app();
        install_features(app.handle(), agent(), &s);
        let sessions = app.try_state::<AgentSessions>().expect("state is managed");
        assert_eq!(sessions.live_count("main"), 0);
        workspace_close(app.handle(), "main");
        exit(app.handle());
        assert_eq!(sessions.live_count("main"), 0);
    }

    #[test]
    fn switched_off_there_is_no_state_and_no_hook() {
        let (_dir, s) = settings(Some(false));
        assert!(plan(agent(), &s).is_empty());
        let app = mock_app();
        install_features(app.handle(), agent(), &s);
        assert!(app.try_state::<AgentSessions>().is_none());
        // the hooks of a disabled feature are never reached, and the core paths that name the
        // state use `try_state`
        workspace_close(app.handle(), "main");
        exit(app.handle());
    }

    #[test]
    fn a_second_setup_is_an_error_not_a_second_state() {
        let app = mock_app();
        Feature::<MockRuntime>::setup(&Agent, app.handle()).unwrap();
        assert!(Feature::<MockRuntime>::setup(&Agent, app.handle()).is_err());
    }

    /// A call from `label` to `plugin:agent|<cmd>` under the REAL ACL (build-time permissions and
    /// `capabilities/features/agent.json`): `Err(text)` is the refusal or the command's own error.
    fn call(
        app: &tauri::App<MockRuntime>,
        label: &str,
        cmd: &str,
    ) -> Result<serde_json::Value, String> {
        call_with(app, label, cmd, json!({}))
    }

    fn call_with(
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
        get_ipc_response(&w, request(&format!("plugin:agent|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let app = app_with(agent());
        app.manage(AppState::new());
        let manifest: Manifest = serde_json::from_str(include_str!("../feature.json")).unwrap();
        for cmd in &manifest.rust.commands {
            for label in ["main", "w-1"] {
                // Allowed: whatever the command answers, it is not the ACL refusing it. (Without
                // a workspace the commands that need one answer "No workspace"; the rest may
                // answer with their own input errors.)
                let r = call(&app, label, cmd);
                assert!(
                    !r.as_ref().err().is_some_and(|e| e.contains("not allowed")),
                    "{cmd} from {label}: {r:?}"
                );
            }
            let err = call(&app, "stranger", cmd).unwrap_err();
            assert!(err.contains("not allowed"), "{cmd} from stranger: {err}");
        }
    }

    /// The Changes card must load in a vault that never went through the Obsidian community-plugin
    /// trust gate (no trust file at all): the agent feature being on is its approval.
    #[test]
    fn turn_changes_and_undo_work_in_a_vault_that_is_not_plugin_trusted() {
        let app = app_with(agent());
        app.manage(AppState::new());
        let vault = tempfile::tempdir().unwrap();
        app.state::<AppState>()
            .get_or_create("main")
            .replace_workspace_root(vault.path().to_path_buf());
        let chat = "3f1c4ee0-a111-4d52-8c36-6a2f41a29b7c";
        // `null` is the documented answer for a snapshot that is gone; before the fix this was the
        // restricted-mode refusal
        let r = call_with(
            &app,
            "main",
            "agent_turn_changes",
            json!({ "chatId": chat, "turnId": "t1" }),
        );
        assert_eq!(r, Ok(serde_json::Value::Null));
        let r = call_with(
            &app,
            "main",
            "agent_revert_changes",
            json!({ "chatId": chat, "turnId": "t1", "paths": [] }),
        );
        assert_eq!(r, Ok(serde_json::Value::Null));
    }

    /// The memory commands on a fixture vault: list, delete and forget-all act on the memory
    /// folders only and a path is refused as a name. The import is tested in `agent/memory_tests.rs`
    /// against a fake home; no test here calls it, so the real home is never read.
    #[test]
    fn the_memory_commands_work_on_a_fixture_vault_and_stay_in_the_memory_folders() {
        let app = app_with(agent());
        app.manage(AppState::new());
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let mem = root.join(".writer/memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(mem.join("MEMORY.md"), "i").unwrap();
        std::fs::write(mem.join("user-cat.md"), "Miso").unwrap();
        std::fs::write(root.join("note.md"), "keep").unwrap();
        app.state::<AppState>()
            .get_or_create("main")
            .replace_workspace_root(root.clone());

        let listed = call_with(
            &app,
            "main",
            "agent_memory_list",
            json!({ "projectPath": null }),
        )
        .unwrap();
        let names: Vec<_> = listed["vault"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["MEMORY.md", "user-cat.md"]);
        assert_eq!(listed["project"], serde_json::Value::Null);

        let del = |name: &str| {
            call_with(
                &app,
                "main",
                "agent_memory_delete",
                json!({ "scope": "vault", "projectPath": null, "name": name }),
            )
        };
        assert!(del("../note.md").is_err());
        assert!(root.join("note.md").exists());
        del("user-cat.md").unwrap();
        assert!(!mem.join("user-cat.md").exists());

        // a project path outside the vault is refused
        assert!(call_with(
            &app,
            "main",
            "agent_memory_forget_all",
            json!({ "scope": "project", "projectPath": "../x" }),
        )
        .is_err());
        let n = call_with(
            &app,
            "main",
            "agent_memory_forget_all",
            json!({ "scope": "vault", "projectPath": null }),
        )
        .unwrap();
        assert_eq!(n, 1);
        assert!(mem.is_dir() && std::fs::read_dir(&mem).unwrap().count() == 0);
        assert_eq!(
            std::fs::read_to_string(root.join("note.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn a_command_needing_a_vault_says_so_instead_of_panicking() {
        let app = app_with(agent());
        app.manage(AppState::new());
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(err.contains("No workspace"), "{err}");
    }

    #[test]
    fn switched_off_the_commands_do_not_exist() {
        let (_dir, s) = settings(Some(false));
        let mut app = tauri::test::mock_builder()
            .setup(move |app| {
                install_features(app.handle(), agent(), &s);
                Ok(())
            })
            .build(crate::features::ipc_tests::test_context())
            .unwrap();
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(!err.is_empty(), "the call is refused: {err}");
        assert!(app.try_state::<AgentSessions>().is_none());
    }
}
