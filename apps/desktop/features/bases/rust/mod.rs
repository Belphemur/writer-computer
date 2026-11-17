//! The Rust half of the built-in feature `bases` (SPECs/builtin-plugins-spec.md step 5, spec
//! `SPECs/obsidian-bases-spec.md`).
//!
//! The pure parts stay where they were because the `writer` CLI and the agent reach them too:
//! the engine `crate::bases` (parser, expressions, query executor, no `tauri` types), the vault
//! index and `index::bases_source` (rows for a query), `cli::cmd_bases` (the command handlers)
//! and `vault_ops` / `index::patch` (the one write path for a property). This folder is the glue
//! and the contributions:
//!
//! - `commands.rs`: the `plugin:bases|<command>` handlers (typed through `bindings.rs`), the
//!   query commands and the note-property edits the cell editor makes;
//! - `cli.rs`: the four `writer base*` commands, contributed to the CLI registry;
//! - the `writer-bases` agent skill (sources in `../skills/writer-bases/`), contributed to the
//!   managed skills.
//!
//! Switch off (`features.bases.enabled`): at launch the plugin is not added (its commands are
//! "plugin not found" until the next launch, the Rust part needs a restart like the agent's);
//! the web half goes at once. The contributions are read whatever the switch says (the CLI and
//! the sync are separate readers of the table, `features::Feature`), and each honours the switch
//! itself: a `writer base*` command answers that the feature is off
//! (`cli::feature_off`), and the skill sync leaves `writer-bases` as it is, installing nothing
//! new and updating nothing (`managed_skills::sync_except`, `features::held_skills`): a skill
//! the vault already holds stays, because it is the vault's file and a switch is no reason to
//! delete it.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::{Feature, InvokeHandler};
use crate::managed_skills::{BundledFile, BundledSkill};
use tauri::Runtime;

pub struct Bases;

static SKILLS: &[BundledSkill] = &[BundledSkill {
    name: "writer-bases",
    files: &[
        BundledFile {
            rel: "SKILL.md",
            content: include_str!("../skills/writer-bases/SKILL.md"),
        },
        BundledFile {
            rel: "references/expressions.md",
            content: include_str!("../skills/writer-bases/references/expressions.md"),
        },
        BundledFile {
            rel: "references/recipes.md",
            content: include_str!("../skills/writer-bases/references/recipes.md"),
        },
    ],
}];

impl<R: Runtime> Feature<R> for Bases {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    /// The ten `plugin:bases|*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn skills(&self) -> &'static [BundledSkill] {
        SKILLS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ConfigValue, Settings};
    use crate::features::ipc_tests::{app_with, request, test_context};
    use crate::features::{fail_for_test, install_features, Manifest};
    use crate::state::AppState;
    use serde_json::json;
    use std::collections::BTreeSet;
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime};
    use tauri::{Manager, WebviewWindowBuilder};

    fn manifest() -> Manifest {
        serde_json::from_str(include_str!("../feature.json")).unwrap()
    }

    fn bases() -> Vec<&'static dyn Feature<MockRuntime>> {
        vec![&Bases]
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
        get_ipc_response(&w, request(&format!("plugin:bases|{cmd}"), args))
            .map(|b| b.deserialize().unwrap())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn the_manifest_names_exactly_what_the_feature_contributes() {
        let raw: serde_json::Value = serde_json::from_str(include_str!("../feature.json")).unwrap();
        let strings = |v: &serde_json::Value| -> BTreeSet<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        };
        let cli: BTreeSet<String> = cli::COMMANDS.iter().map(|c| c.name.to_string()).collect();
        assert_eq!(strings(&raw["rust"]["cliCommands"]), cli);
        let skills: BTreeSet<String> = SKILLS.iter().map(|s| s.name.to_string()).collect();
        assert_eq!(strings(&raw["rust"]["skills"]), skills);
        assert!(cli::COMMANDS.iter().all(|c| c.feature == Some("bases")));
        assert!(cli::COMMANDS.iter().all(|c| c.group == "Bases"));
        assert_eq!(manifest().id, "bases");
    }

    #[test]
    fn the_skill_folder_and_the_bundled_files_are_the_same_set() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../features/bases/skills");
        fn collect(dir: &std::path::Path, base: &std::path::Path, out: &mut BTreeSet<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    collect(&p, base, out);
                } else {
                    out.insert(
                        p.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut on_disk = BTreeSet::new();
        collect(&dir, &dir, &mut on_disk);
        let bundled: BTreeSet<String> = SKILLS
            .iter()
            .flat_map(|s| s.files.iter().map(move |f| format!("{}/{}", s.name, f.rel)))
            .collect();
        assert_eq!(on_disk, bundled);
        assert!(SKILLS.iter().all(|s| s.files[0].rel == "SKILL.md"));
    }

    #[test]
    fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
        let app = app_with(bases());
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
    fn the_pure_commands_answer_and_a_vault_command_without_a_vault_says_so() {
        let app = app_with(bases());
        app.manage(AppState::new());
        let parsed = call(
            &app,
            "main",
            "base_parse_text",
            json!({ "text": "views:\n  - type: cards\n    name: C\n" }),
        )
        .unwrap();
        assert_eq!(parsed["document"]["views"][0]["type"], "cards");
        let functions = call(&app, "main", "base_functions", json!({})).unwrap();
        assert!(functions.as_array().is_some_and(|f| !f.is_empty()));
        let err = call(&app, "main", "base_list", json!({})).unwrap_err();
        assert!(
            err.contains("No workspace") || err.contains("index"),
            "{err}"
        );
    }

    #[test]
    fn a_failed_feature_refuses_its_commands_with_feature_unavailable() {
        let app = app_with(bases());
        app.manage(AppState::new());
        assert!(call(&app, "main", "base_functions", json!({})).is_ok());
        fail_for_test(app.handle(), "bases");
        for cmd in ["base_functions", "base_list", "note_properties"] {
            let err = call(&app, "main", cmd, json!({ "path": "a.md" })).unwrap_err();
            assert!(err.contains("Feature unavailable: bases"), "{cmd}: {err}");
        }
    }

    #[test]
    fn switched_off_at_launch_the_plugin_is_not_added() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::new(dir.path().to_path_buf()).unwrap();
        s.set_global("features.bases.enabled", ConfigValue::Bool(false))
            .unwrap();
        #[allow(deprecated)]
        let app = {
            let mut app = mock_builder()
                .setup(move |app| {
                    install_features(app.handle(), bases(), &s);
                    Ok(())
                })
                .build(test_context())
                .unwrap();
            app.run_iteration(|_, _| {});
            app
        };
        let err = call(&app, "main", "base_functions", json!({})).unwrap_err();
        assert!(!err.is_empty(), "the call is refused: {err}");
        // the contributions are still listed: each reader honours the switch itself
        assert_eq!(Feature::<MockRuntime>::cli_commands(&Bases).len(), 4);
        assert_eq!(Feature::<MockRuntime>::skills(&Bases).len(), 1);
    }
}
