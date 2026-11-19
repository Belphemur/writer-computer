//! The Rust half of the built-in feature `dataview` (spec `SPECs/dataview-spec.md`, ADR
//! `2026-11-18-run-dataview-queries-natively-on-the-bases-engine`).
//!
//! The language stays where the CLI and the app can both reach it: `crate::dql` (parser and
//! lowering, no `tauri` types) over the Bases engine `crate::bases` (its executor, its `dialect`
//! module for DQL semantics) and the core index (`index::inline_fields`, the `inline_fields`
//! table). This folder is the glue and the contributions:
//!
//! - `commands.rs`: `plugin:dataview|dql_lower` (a query to the live `.base` text the block
//!   renders through the Bases views, plus whether and why it can become a plain base) and
//!   `dql_convert` (write that plain base next to the note);
//! - `cli.rs`: the `writer dql` command.
//!
//! No JavaScript is ever run: a `dataviewjs` block is a placeholder the web half draws.
//!
//! Switched off (`features.dataview.enabled`): at launch the plugin is not added (its commands
//! are "plugin not found" until the next launch); the web half goes at once; `writer dql`
//! answers that the feature is off.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::{Feature, InvokeHandler};
use tauri::Runtime;

pub struct Dataview;

impl<R: Runtime> Feature<R> for Dataview {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    /// The `plugin:dataview|*` commands; the list is `bindings::builder`.
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
    use std::collections::BTreeSet;
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
        get_ipc_response(&w, request(&format!("plugin:dataview|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn the_manifest_names_exactly_what_the_feature_contributes() {
        let raw: serde_json::Value = serde_json::from_str(include_str!("../feature.json")).unwrap();
        let cli: BTreeSet<String> = cli::COMMANDS.iter().map(|c| c.name.to_string()).collect();
        let named: BTreeSet<String> = raw["rust"]["cliCommands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(named, cli);
        assert!(cli::COMMANDS
            .iter()
            .all(|c| c.feature == Some("dataview") && c.group == "Dataview"));
        assert_eq!(manifest().id, "dataview");
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let app = app_with(vec![&Dataview as &dyn Feature<MockRuntime>]);
        app.manage(AppState::new());
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
    fn the_pure_command_answers_without_a_vault() {
        let app = app_with(vec![&Dataview as &dyn Feature<MockRuntime>]);
        app.manage(AppState::new());
        let r = call(
            &app,
            "main",
            "dql_lower",
            json!({ "text": "TABLE a FROM \"x\"" }),
        )
        .unwrap();
        assert_eq!(r["kind"], "table");
        assert!(r["liveText"].as_str().unwrap().contains("dialect: dql"));
        assert_eq!(r["convertible"], true);
        let bad = call(&app, "main", "dql_lower", json!({ "text": "TABLE" })).unwrap();
        // a bare TABLE is a valid empty query; a keyword soup is not
        assert!(bad["error"].is_null());
        let bad = call(&app, "main", "dql_lower", json!({ "text": "TABLE a FROM" })).unwrap();
        assert_eq!(bad["error"]["line"], 1);
        let err = call(
            &app,
            "main",
            "dql_convert",
            json!({ "text": "TABLE a", "notePath": "a.md" }),
        )
        .unwrap_err();
        assert!(
            err.contains("No workspace") || err.contains("index"),
            "{err}"
        );
    }
}
