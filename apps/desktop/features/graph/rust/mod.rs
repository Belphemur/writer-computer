//! The Rust half of the built-in feature `graph` (spec `SPECs/note-graph-spec.md` 8.5, the view
//! `SPECs/graph-view-spec.md`).
//!
//! The graph itself lives in core because the `writer graph:*` commands and the agent reach it
//! too: the `edges` table and its maintenance (`index::edges`), the in-memory snapshot
//! (`index::snapshot`), the traversals and the view's slice (`index::graph`), the CLI handlers
//! (`cli::cmd_graph`). This folder is the glue for the view:
//!
//! - `commands.rs`: `plugin:graph|<command>` (typed through `bindings.rs`): `graph_slice`,
//!   `graph_stats`, and `graph_config_read` / `graph_config_write` for `.writer/graph.json`;
//! - `config_file.rs`: that file, confined to the vault, atomic, size-capped, opaque JSON.
//!
//! Switch off (`features.graph.enabled`): the plugin is not added at launch (its commands are
//! "plugin not found" until the next launch), the web half goes at once; the index keeps the
//! `edges` table either way (it serves `backlinks`, `unresolved` and Bases too).

mod bindings;
mod commands;
mod config_file;

use crate::features::{Feature, InvokeHandler};
use tauri::Runtime;

pub struct Graph;

impl<R: Runtime> Feature<R> for Graph {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    /// The four `plugin:graph|*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
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
        get_ipc_response(&w, request(&format!("plugin:graph|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let features: Vec<&'static dyn Feature<MockRuntime>> = vec![&Graph];
        let app = app_with(features);
        app.manage(AppState::new());
        assert_eq!(manifest().id, "graph");
        assert!(!manifest().rust.commands.is_empty());
        for cmd in &manifest().rust.commands {
            for label in ["main", "w-1"] {
                let r = call(&app, label, cmd, json!({"content": "{}"}));
                assert!(
                    !r.as_ref().err().is_some_and(|e| e.contains("not allowed")),
                    "{cmd} from {label}: {r:?}"
                );
            }
            let err = call(&app, "stranger", cmd, json!({"content": "{}"})).unwrap_err();
            assert!(err.contains("not allowed"), "{cmd} from stranger: {err}");
        }
    }

    #[test]
    fn a_command_without_a_vault_says_so_instead_of_answering_empty() {
        let features: Vec<&'static dyn Feature<MockRuntime>> = vec![&Graph];
        let app = app_with(features);
        app.manage(AppState::new());
        for cmd in ["graph_stats", "graph_config_read"] {
            let err = call(&app, "main", cmd, json!({})).unwrap_err();
            assert!(
                err.contains("No workspace") || err.contains("index"),
                "{cmd}: {err}"
            );
        }
    }
}
