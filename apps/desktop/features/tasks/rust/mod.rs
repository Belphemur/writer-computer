//! The Rust half of the built-in feature `tasks` (spec `SPECs/tasks-spec.md`).
//!
//! Everything that is logic lives in core, Tauri-free, because the CLI and the index reach it
//! too: the grammar and the writes (`crate::tasks`), the `list_items` / `tasks` tables
//! (`index/`), the `rows: tasks` base rows (`index::bases_source`, `bases/`), the CLI handlers
//! (`cli::cmd_tasks`). This folder is the glue:
//!
//! - `commands.rs`: `plugin:tasks|<command>` (typed through `bindings.rs`). File commands serve
//!   Bases rows and the page; line commands transform the editor's own line text so unsaved
//!   editor content is never overwritten;
//! - `cli.rs`: the `task:add`, `task:done`, `task:edit` table.
//!
//! Switch off (`features.tasks.enabled`): the plugin is not added at launch, the web half goes
//! at once; the index keeps its task tables (they serve `writer tasks`, Bases and the agent).

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::{Feature, InvokeHandler};
use tauri::Runtime;

pub struct Tasks;

impl<R: Runtime> Feature<R> for Tasks {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::ipc_tests::{app_with, request};
    use crate::features::Manifest;
    use crate::state::AppState;
    use serde_json::json;
    use tauri::test::{get_ipc_response, MockRuntime};
    use tauri::{Manager, WebviewWindowBuilder};

    fn manifest() -> Manifest {
        serde_json::from_str(include_str!("../feature.json")).unwrap()
    }

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
        get_ipc_response(&w, request(&format!("plugin:tasks|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let features: Vec<&'static dyn Feature<MockRuntime>> = vec![&Tasks];
        let app = app_with(features);
        app.manage(AppState::new());
        assert_eq!(manifest().id, "tasks");
        assert!(!manifest().rust.commands.is_empty());
        for cmd in &manifest().rust.commands {
            for label in ["main", "w-1"] {
                let r = call(&app, label, cmd, json!({}));
                assert!(
                    !r.as_ref().err().is_some_and(|e| e.contains("not allowed")),
                    "{cmd} from {label}: {r:?}"
                );
            }
            let err = call(&app, "stranger", cmd, json!({})).unwrap_err();
            assert!(err.contains("not allowed"), "{cmd} from stranger: {err}");
        }
    }

    #[test]
    fn a_vault_command_without_a_vault_says_so() {
        let features: Vec<&'static dyn Feature<MockRuntime>> = vec![&Tasks];
        let app = app_with(features);
        app.manage(AppState::new());
        let err = call(
            &app,
            "main",
            "task_add",
            json!({"text": "a", "fields": [], "path": null, "today": "2024-03-15"}),
        )
        .unwrap_err();
        assert!(
            err.contains("No workspace") || err.contains("index"),
            "{err}"
        );
    }

    #[test]
    fn the_cli_commands_are_tagged_with_the_feature() {
        let cmds = Feature::<MockRuntime>::cli_commands(&Tasks);
        assert_eq!(cmds.len(), 3);
        assert!(cmds.iter().all(|c| c.feature == Some("tasks")));
    }
}
