//! Pilot 3 of the built-in features (SPECs/builtin-plugins-spec.md): the agent pane's Rust half.
//!
//! The pure agent code (`crate::agent`: stream mapper, runner, chat store, project library) is
//! Tauri-free and stays where the `writer` CLI and the integration tests reach it; this folder is
//! the glue that owns the Tauri-facing parts: the managed [`AgentSessions`] state, the hooks that
//! stop the CLI processes of a closed window and at exit, and the `plugin:agent|<command>`
//! handlers (`commands/`, listed once in `bindings.rs` for the invoke handler and the TypeScript
//! bindings). The event `agent:event` carries every chat event to its window.
//!
//! With `features.agent.enabled` off the runner never calls [`Feature::start`], so no state exists
//! and no hook runs; switched on later, `start` runs live and the commands work at once. The
//! feature contributes no bundled skills: the managed skills (`writer-cli`, `writer-search`,
//! `writer-bases`) are for any agent working in a vault, not for this pane.
//!
//! Ownership (ADR 2026-11-20): everything the agent runs lives in the feature's scope. The
//! [`AgentSessions`] state is `scope.manage`d (commands reach it through [`sessions`]); every
//! thread (the idle reaper, the config worker, each chat's stdin writer and event pump, the
//! watchdogs) and the `mcp list` child start on the scope's `Spawner`; the watcher observer is
//! `scope.observe`d; the chats' `claude` processes are held by the sessions' `ProcManager`,
//! which the scope counts and which `AgentSessions::stop` kills. Stopping the feature kills
//! every chat's process group and ends every thread; the busy reason is the number of chats in
//! the middle of a turn.
//! Spec: `SPECs/native-agent-spec.md`.

mod bindings;
mod cli;
mod commands;

use crate::agent::project_context::ProjectLibrary;
use crate::agent::session::{AgentSessions, Timing};
use crate::cli::registry::CommandSpec;
use crate::error::AppError;
use crate::features::points::Points;
use crate::features::scope::{FeatureScope, Kind};
use crate::features::{self, Feature, InvokeHandler};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

pub struct Agent;

/// The sessions of the started agent, `None` while the feature is off.
pub(crate) fn sessions_if_started<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<AgentSessions>> {
    features::state_of::<R, AgentSessions>(app, "agent")
}

/// The sessions, or `FeatureUnavailable` when the feature is off or stopping (a command that was
/// already past the gate when the feature stopped).
pub(crate) fn sessions<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<AgentSessions>, AppError> {
    sessions_if_started(app).ok_or_else(|| AppError::FeatureUnavailable("agent".into()))
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

    /// `project:archive` and `project:unarchive`.
    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn start(&self, app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        // Agent projects: the runner resolves cwd and the appended system prompt through this port.
        let points = app.state::<Points>().inner().clone();
        let state = AgentSessions::with_spawner(Timing::default(), scope.spawner(), points)?;
        state.ports().set_project(Arc::new(ProjectLibrary));
        let sessions = scope.manage(state);
        // What the scope counts, stops and reports, without keeping the state alive past its stop.
        let weak = Arc::downgrade(&sessions);
        scope.adopt(Kind::Process, {
            let w = weak.clone();
            move || w.upgrade().map_or(0, |s| s.process_count())
        });
        scope.on_stop({
            let w = weak.clone();
            move || {
                if let Some(s) = w.upgrade() {
                    s.stop();
                }
            }
        });
        scope.busy_probe({
            let w = weak.clone();
            move || {
                let n = w.upgrade()?.working_total();
                (n > 0).then(|| format!("{n} running chat{}", if n == 1 { "" } else { "s" }))
            }
        });
        // Config files the running CLIs read at start (skills, `.mcp.json`, settings, CLAUDE.md):
        // the app's one file watcher reports them, `agent::config_sync` decides what is stale.
        scope
            .observe(Box::new(move |label, root, paths, own| {
                if let Some(s) = weak.upgrade() {
                    s.paths_changed(label, root, paths, own);
                }
            }))
            .map_err(|e| e.to_string())
    }

    /// The window closed or left its vault: its chats' CLI processes go with it.
    fn on_workspace_close(&self, app: &AppHandle<R>, label: &str) {
        if let Some(s) = sessions_if_started(app) {
            s.kill_window(label);
        }
    }

    /// `RunEvent::Exit`: no CLI process outlives the app.
    fn on_exit(&self, app: &AppHandle<R>) {
        if let Some(s) = sessions_if_started(app) {
            s.kill_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ConfigValue, Settings};
    use crate::features::ipc_tests::{app_with, request};
    use crate::features::{
        busy, exit, install_features, is_started, plan, settings_written, start_feature,
        stop_feature, workspace_close, Manifest,
    };
    use crate::state::AppState;
    use serde_json::json;
    use tauri::test::{get_ipc_response, mock_app, MockRuntime};
    use tauri::{Manager, WebviewWindowBuilder};

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
        assert_eq!(m.rust.hooks, ["start", "onWorkspaceClose", "onExit"]);
        let raw: serde_json::Value = serde_json::from_str(include_str!("../feature.json")).unwrap();
        let cli: Vec<_> = cli::COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(raw["rust"]["cliCommands"], serde_json::json!(cli));
        assert!(cli::COMMANDS.iter().all(|c| c.feature == Some("agent")));
        assert!(m.has_rust());
    }

    #[test]
    fn enabled_it_manages_the_sessions_and_the_hooks_run_without_a_session() {
        let (_dir, s) = settings(None);
        let app = mock_app();
        install_features(app.handle(), agent(), &s);
        let sessions = sessions_if_started(app.handle()).expect("state is in the scope");
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
        assert!(sessions_if_started(app.handle()).is_none());
        assert!(!is_started(app.handle(), "agent"));
        // the hooks of a disabled feature are never reached, and the core paths that name the
        // state read it through the scope
        workspace_close(app.handle(), "main");
        exit(app.handle());
    }

    #[test]
    fn a_second_start_keeps_the_one_state() {
        let (_dir, s) = settings(None);
        let app = mock_app();
        install_features(app.handle(), agent(), &s);
        let first = sessions_if_started(app.handle()).unwrap();
        start_feature(app.handle(), &Agent).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &sessions_if_started(app.handle()).unwrap()
        ));
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
    fn switched_off_the_commands_answer_feature_unavailable() {
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
        assert!(err.contains("Feature unavailable: agent"), "{err}");
        assert!(sessions_if_started(app.handle()).is_none());
    }

    /// An app with the agent switched `on` in the settings of its main window, to toggle live.
    fn toggle_app(on: bool, dir: &std::path::Path) -> tauri::App<MockRuntime> {
        let s = crate::features::tests::settings_with(dir, &[("features.agent.enabled", on)]);
        let mut app = tauri::test::mock_builder()
            .manage(AppState::new())
            .setup(move |app| {
                install_features(app.handle(), agent(), &s);
                Ok(())
            })
            .build(crate::features::ipc_tests::test_context())
            .unwrap();
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        let state = app
            .state::<AppState>()
            .get_or_create(crate::MAIN_WINDOW_LABEL);
        *state.settings.write() = Some(crate::features::tests::settings_with(
            dir,
            &[("features.agent.enabled", on)],
        ));
        app
    }

    fn set_switch(app: &tauri::App<MockRuntime>, dir: &std::path::Path, on: bool) {
        let state = app
            .state::<AppState>()
            .get_or_create(crate::MAIN_WINDOW_LABEL);
        *state.settings.write() = Some(crate::features::tests::settings_with(
            dir,
            &[("features.agent.enabled", on)],
        ));
        settings_written(app.handle(), "features.agent.enabled");
    }

    #[test]
    fn switched_on_at_runtime_the_commands_work_without_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let app = toggle_app(false, dir.path());
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(err.contains("Feature unavailable: agent"), "{err}");

        set_switch(&app, dir.path(), true);
        assert!(is_started(app.handle(), "agent"));
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(
            err.contains("No workspace"),
            "the command ran (it needs a vault): {err}"
        );

        // and off again: the commands stop answering, nothing is left behind
        set_switch(&app, dir.path(), false);
        assert!(!is_started(app.handle(), "agent"));
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(err.contains("Feature unavailable: agent"), "{err}");
    }

    /// A fake CLI that only stays alive (the protocol is not needed to count chats and processes);
    /// it records its pid so the test can see the process die.
    fn sleepy_cli(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("claude");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \"$1\" in --version|auth) echo \"2.1.0 (Claude Code)\"; exit 0;; esac\necho $$ >> \"{}/pids.log\"\nsleep 300 &\nwait\n",
                dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn start_chat(
        sessions: &AgentSessions,
        root: &std::path::Path,
        cli: &std::path::Path,
        chat: &str,
    ) {
        use crate::agent::events::*;
        use crate::agent::ports::InjectAgentsMd;
        use crate::agent::session::StartParams;
        let sink: crate::agent::session::Sink = Arc::new(|_| {});
        let params = StartParams {
            label: "main".into(),
            root: root.to_path_buf(),
            request: StartSessionRequest {
                chat_id: chat.into(),
                project_path: None,
                resume_session_id: None,
                settings: AgentSettings {
                    binary_path: Some(cli.to_string_lossy().into_owned()),
                    model: None,
                    effort: None,
                    permission_mode: AgentPermissionMode::Manual,
                    allowed_tools: vec![],
                    disallowed_tools: vec![],
                    orchestrate: false,
                    show_thinking: false,
                    auto_reload: false,
                    memory: AgentMemory::Default,
                    tier_models: Default::default(),
                },
                append_system_prompt: None,
            },
            inject_agents_md: InjectAgentsMd::Auto,
            cli_dir: None,
            sink,
        };
        sessions.start(params).unwrap();
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn switched_off_at_runtime_with_two_chats_kills_both_processes_and_every_thread() {
        let dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let cli = sleepy_cli(dir.path());
        let app = toggle_app(true, dir.path());
        let sessions = sessions_if_started(app.handle()).unwrap();
        for chat in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            start_chat(&sessions, &root, &cli, chat);
        }
        let log = dir.path().join("pids.log");
        let start = std::time::Instant::now();
        while std::fs::read_to_string(&log).map_or(0, |t| t.lines().count()) < 2 {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "no processes"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let pids: Vec<i32> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|l| l.parse().unwrap())
            .collect();
        assert!(pids.iter().all(|p| alive(*p)), "{pids:?}");
        assert_eq!(sessions.live_count("main"), 2);
        // a message starts a turn (the fake never answers): both chats are in the middle of one
        for chat in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            sessions.send("main", chat, "hello".into(), &[]).unwrap();
        }
        let reason = busy(app.handle());
        assert_eq!(reason.len(), 1);
        assert_eq!(reason[0].id, "agent");
        assert_eq!(reason[0].reason, "2 running chats");

        set_switch(&app, dir.path(), false);
        assert!(!is_started(app.handle(), "agent"));
        let start = std::time::Instant::now();
        while pids.iter().any(|p| alive(*p)) {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "a process survived"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(sessions.live_count("main"), 0);
        assert_eq!(sessions.process_count(), 0);
        assert!(busy(app.handle()).is_empty());
        // a late call after the stop cannot start a chat
        let err = call(&app, "main", "agent_list_chats").unwrap_err();
        assert!(err.contains("Feature unavailable: agent"), "{err}");

        // turned back on, it works again
        set_switch(&app, dir.path(), true);
        assert!(is_started(app.handle(), "agent"));
        stop_feature(app.handle(), "agent", true);
    }
}
