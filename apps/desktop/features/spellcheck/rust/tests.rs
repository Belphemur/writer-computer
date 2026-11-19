//! The glue under Tauri's mock runtime with the real ACL: every command is allowed from `main`
//! and workspace windows and nowhere else, the engine answers through IPC, the personal
//! dictionary has one write path, and nothing here reaches the network (an unknown dictionary id
//! is refused before any request; the catalog install is tested in `spellcheck::dictionaries`
//! against a local file server).

use super::*;
use crate::cli::registry;
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

fn spellcheck() -> Vec<&'static dyn Feature<MockRuntime>> {
    vec![&Spellcheck]
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
    get_ipc_response(&w, request(&format!("plugin:spellcheck|{cmd}"), args))
        .map(|b| b.deserialize().unwrap())
        .map_err(|e| e.to_string())
}

fn app() -> tauri::App<MockRuntime> {
    let app = app_with(spellcheck());
    app.manage(AppState::new());
    app
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
    assert!(cli::COMMANDS
        .iter()
        .all(|c| c.feature == Some("spellcheck") && c.group == "Spelling"));
    assert_eq!(manifest().id, "spellcheck");
    assert!(
        registry::find("check").is_some(),
        "writer check is in the registry"
    );
    // the kill switch and the settings fragment are the feature's own (the contract test checks
    // the shared schema); the fragment's keys are the ones the engine reads
    let fragment: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    let keys: BTreeSet<String> = fragment["settings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap().to_string())
        .collect();
    for key in [
        crate::spellcheck::options::CHECK_SPELLING,
        crate::spellcheck::options::CHECK_GRAMMAR,
        crate::spellcheck::options::CHECK_STYLE,
        crate::spellcheck::options::ENGLISH_DIALECT,
        crate::spellcheck::options::DEFAULT_LANGUAGE,
        crate::spellcheck::options::FOLDER_LANGUAGES,
        crate::spellcheck::options::IGNORED_RULES,
    ] {
        assert!(keys.contains(key), "{key} is in the fragment");
    }
    assert_eq!(
        keys.len(),
        7,
        "no setting the engine or the web half does not read"
    );
}

#[test]
fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
    let app = app();
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
fn a_check_answers_through_ipc_and_an_older_version_is_stale() {
    let app = app();
    let ask = |version: u32| {
        call(
            &app,
            "main",
            "spellcheck_check",
            json!({ "request": { "path": "a.md", "text": "I recieved it.", "version": version, "language": null } }),
        )
        .unwrap()
    };
    let first = ask(5);
    assert_eq!(first["stale"], false);
    assert_eq!(first["version"], 5);
    let findings = first["findings"].as_array().unwrap();
    assert!(
        findings
            .iter()
            .any(|f| f["ruleId"] == "SpellCheck" && f["start"] == 2 && f["end"] == 10),
        "{findings:?}"
    );
    assert_eq!(first["blocks"][0]["lang"], "en-US");
    let stale = ask(4);
    assert_eq!(stale["stale"], true);
    assert!(stale["findings"].as_array().unwrap().is_empty());
}

#[test]
fn the_personal_dictionary_needs_a_vault_and_writes_only_inside_it() {
    let app = app();
    let err = call(
        &app,
        "main",
        "spellcheck_add_word",
        json!({ "word": "Zettelkasten" }),
    )
    .unwrap_err();
    assert!(err.contains("No workspace"), "{err}");

    let vault = tempfile::tempdir().unwrap();
    let state = app.state::<AppState>().get_or_create("main");
    *state.workspace_root.write() = Some(vault.path().to_path_buf());

    let words = call(
        &app,
        "main",
        "spellcheck_add_word",
        json!({ "word": "Zettelkasten" }),
    )
    .unwrap();
    assert_eq!(words, json!(["Zettelkasten"]));
    assert_eq!(
        std::fs::read_to_string(vault.path().join(".writer/dictionary.txt")).unwrap(),
        "Zettelkasten\n"
    );
    assert!(!vault.path().join(".obsidian").exists());
    let bad = call(
        &app,
        "main",
        "spellcheck_add_word",
        json!({ "word": "two words" }),
    )
    .unwrap_err();
    assert!(bad.contains("no spaces"), "{bad}");

    // the word is no longer reported
    let checked = call(
        &app,
        "main",
        "spellcheck_check",
        json!({ "request": { "path": "a.md", "text": "Zettelkasten notes.", "version": 1, "language": null } }),
    )
    .unwrap();
    assert!(
        checked["findings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["ruleId"] != "SpellCheck"),
        "{checked}"
    );

    let words = call(
        &app,
        "main",
        "spellcheck_remove_word",
        json!({ "word": "zettelkasten" }),
    )
    .unwrap();
    assert_eq!(words, json!([]));
    assert_eq!(
        call(&app, "main", "spellcheck_personal_words", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn ignoring_a_word_hides_it_in_that_note_only_and_writes_outside_the_vault() {
    let app = app();
    let args = |path: &str, word: &str| json!({ "path": path, "word": word });
    let err = call(
        &app,
        "main",
        "spellcheck_ignore_word",
        args("a.md", "recieved"),
    )
    .unwrap_err();
    assert!(err.contains("No workspace"), "{err}");

    let vault = tempfile::tempdir().unwrap();
    let state = app.state::<AppState>().get_or_create("main");
    *state.workspace_root.write() = Some(vault.path().to_path_buf());
    // never the platform app data dir: that is the user's live data
    let data = tempfile::tempdir().unwrap();
    *app.state::<Engine>().data_dir.write() = data.path().to_path_buf();

    let flagged = |path: &str, version: u32| -> bool {
        let checked = call(
            &app,
            "main",
            "spellcheck_check",
            json!({ "request": { "path": path, "text": "I recieved it.", "version": version, "language": null } }),
        )
        .unwrap();
        checked["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["ruleId"] == "SpellCheck")
    };
    assert!(flagged("a.md", 1));
    let words = call(
        &app,
        "main",
        "spellcheck_ignore_word",
        args("a.md", "Recieved"),
    )
    .unwrap();
    assert_eq!(words, json!(["recieved"]));
    assert!(!flagged("a.md", 2), "ignored in a.md");
    assert!(flagged("b.md", 1), "still flagged in b.md");
    assert_eq!(
        std::fs::read_dir(vault.path()).unwrap().count(),
        0,
        "nothing in the vault"
    );

    let bad = call(
        &app,
        "main",
        "spellcheck_ignore_word",
        args("a.md", "two words"),
    )
    .unwrap_err();
    assert!(bad.contains("no spaces"), "{bad}");
    let words = call(
        &app,
        "main",
        "spellcheck_unignore_word",
        args("a.md", "RECIEVED"),
    )
    .unwrap();
    assert_eq!(words, json!([]));
    assert!(flagged("a.md", 3), "flagged again once un-ignored");
    assert!(
        data.path().join("spellcheck").exists(),
        "the store is under the data dir"
    );
}

#[test]
fn the_catalog_lists_every_dictionary_and_an_unknown_id_is_refused_without_a_request() {
    let app = app();
    let list = call(&app, "main", "spellcheck_dictionaries", json!({})).unwrap();
    let list = list.as_array().unwrap();
    assert!(list.len() > 80);
    assert!(list.iter().all(|d| d["installed"] == false));
    assert!(list
        .iter()
        .any(|d| d["id"] == "fr" && d["name"] == "French" && d["license"] == "MPL-2.0"));

    let err = call(
        &app,
        "main",
        "spellcheck_install_dictionary",
        json!({ "id": "klingon-fake" }),
    )
    .unwrap_err();
    assert!(err.contains("klingon-fake"), "{err}");
    let err = call(
        &app,
        "main",
        "spellcheck_remove_dictionary",
        json!({ "id": "../x" }),
    )
    .unwrap_err();
    assert!(err.contains("../x"), "an id never names a path: {err}");
    call(
        &app,
        "main",
        "spellcheck_remove_dictionary",
        json!({ "id": "fr" }),
    )
    .unwrap();
}

#[test]
fn a_failed_feature_refuses_its_commands_with_feature_unavailable() {
    let app = app();
    crate::features::fail_for_test(app.handle(), "spellcheck");
    let err = call(&app, "main", "spellcheck_dictionaries", json!({})).unwrap_err();
    assert!(err.contains("Feature unavailable: spellcheck"), "{err}");
}

mod cli_tests {
    //! `writer check` through the real argument parser, on a synthetic vault and data dir.
    use crate::cli::{execute, Env, SystemClipboard, EXIT_FAIL, EXIT_OK, EXIT_USAGE};
    use crate::spellcheck::dictionaries::test_support::{AFF, DIC};
    use serde_json::Value;
    use tempfile::TempDir;

    struct Vaults {
        vault: TempDir,
        data: TempDir,
    }

    impl Vaults {
        fn new(note: &str) -> Self {
            let v = Vaults {
                vault: TempDir::new().unwrap(),
                data: TempDir::new().unwrap(),
            };
            std::fs::write(v.vault.path().join("Note.md"), note).unwrap();
            v
        }

        fn run(&self, line: &[&str]) -> crate::cli::Outcome {
            let env = Env {
                app_data_dir: Some(self.data.path().to_path_buf()),
                clipboard: Box::new(SystemClipboard),
                utc_offset_minutes: 0,
                launcher: Box::new(crate::writer_cli::SystemLauncher),
                launch_wait: std::time::Duration::ZERO,
            };
            let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
            execute(&argv, self.vault.path(), &env)
        }
    }

    #[test]
    fn check_prints_the_findings_with_line_and_column_and_nothing_else() {
        let v = Vaults::new("# Title\n\nCafé 😀 and I recieved it.\n```\nwrngcode\n```\n");
        let o = v.run(&["check", "path=Note.md"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(
            o.stdout
                .contains("Note.md:3:14 spelling SpellCheck \"recieved\""),
            "{}",
            o.stdout
        );
        assert!(
            o.stdout.contains("received"),
            "the suggestion is printed: {}",
            o.stdout
        );
        assert!(!o.stdout.contains("wrngcode"), "code is not checked");
        assert!(o.stderr.is_empty(), "{}", o.stderr);
    }

    #[test]
    fn check_json_is_the_same_findings_for_an_agent() {
        let v = Vaults::new("I recieved it. This is an test.\n");
        let o = v.run(&["check", "path=Note.md", "format=json"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        let json: Value = serde_json::from_str(&o.stdout).unwrap();
        assert_eq!(json["path"], "Note.md");
        let f = json["findings"].as_array().unwrap();
        let spelling = f
            .iter()
            .find(|x| x["rule"] == "SpellCheck")
            .expect("a spelling finding");
        assert_eq!(
            (
                spelling["line"].clone(),
                spelling["column"].clone(),
                spelling["text"].clone()
            ),
            (1.into(), 3.into(), "recieved".into())
        );
        assert_eq!(
            (spelling["start"].clone(), spelling["end"].clone()),
            (2.into(), 10.into())
        );
        assert_eq!(spelling["kind"], "spelling");
        assert_eq!(spelling["provider"], "harper");
        assert!(f.iter().any(|x| x["kind"] == "grammar"), "{f:?}");
        assert!(json["missingLanguages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_clean_note_says_so_and_a_missing_dictionary_is_named() {
        let v = Vaults::new("All good here.\n");
        assert_eq!(
            v.run(&["check", "path=Note.md"]).stdout,
            "Note.md: no findings\n"
        );
        let o = v.run(&["check", "path=Note.md", "lang=de"]);
        assert_eq!(o.code, EXIT_OK);
        assert!(o.stdout.contains("no dictionary for de"), "{}", o.stdout);
    }

    #[test]
    fn lang_checks_with_an_installed_dictionary_and_the_notes_property_is_honoured() {
        let v = Vaults::new("---\nlang: de\n---\nder Haus und Hauzse\n");
        let de = v.data.path().join("spellcheck/dictionaries/de");
        std::fs::create_dir_all(&de).unwrap();
        std::fs::write(de.join("index.aff"), AFF).unwrap();
        std::fs::write(de.join("index.dic"), DIC).unwrap();
        std::fs::write(de.join("meta.json"), r#"{"id":"de","name":"German","license":"MIT","commit":"","aff_sha256":"","dic_sha256":""}"#).unwrap();
        let o = v.run(&["check", "path=Note.md", "format=json"]);
        let json: Value = serde_json::from_str(&o.stdout).unwrap();
        let words: Vec<String> = json["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(words, ["und", "Hauzse"]);
        let o = v.run(&["check", "path=Note.md", "lang=en", "format=json"]);
        let json: Value = serde_json::from_str(&o.stdout).unwrap();
        assert!(
            json["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["provider"] == "harper"),
            "lang= overrides the property"
        );
    }

    #[test]
    fn the_personal_dictionary_and_the_settings_file_apply_and_bad_input_is_refused() {
        let v = Vaults::new("I recieved it.\n");
        std::fs::create_dir_all(v.vault.path().join(".writer")).unwrap();
        std::fs::write(v.vault.path().join(".writer/dictionary.txt"), "recieved\n").unwrap();
        assert_eq!(
            v.run(&["check", "path=Note.md"]).stdout,
            "Note.md: no findings\n"
        );

        let v = Vaults::new("I recieved it.\n");
        std::fs::write(
            v.data.path().join("config"),
            "spellcheck.check-spelling = false\n",
        )
        .unwrap();
        assert_eq!(
            v.run(&["check", "path=Note.md"]).stdout,
            "Note.md: no findings\n",
            "the global settings file is read"
        );

        assert_eq!(
            v.run(&["check", "path=Note.md", "lang=zzzzzzzz"]).code,
            EXIT_USAGE
        );
        assert_eq!(v.run(&["check", "path=Missing.md"]).code, EXIT_FAIL);
        assert_eq!(
            v.run(&["check", "path=Note.md", "format=csv"]).code,
            EXIT_USAGE
        );
        assert_eq!(v.run(&["check"]).code, EXIT_USAGE);
    }

    #[test]
    fn with_the_feature_off_the_command_says_so_instead_of_checking() {
        let v = Vaults::new("I recieved it.\n");
        std::fs::write(
            v.data.path().join("config"),
            "features.spellcheck.enabled = false\n",
        )
        .unwrap();
        let o = v.run(&["check", "path=Note.md"]);
        assert_eq!(o.code, EXIT_FAIL);
        assert!(
            o.stderr.contains("spellcheck feature is turned off"),
            "{}",
            o.stderr
        );
    }
}
