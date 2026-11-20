//! The glue under Tauri's mock runtime with the real ACL (every command is allowed from `main`
//! and workspace windows and nowhere else, the engine answers through IPC) and the `writer lint`
//! commands through the real argument parser on a synthetic vault and data dir. Never the
//! platform app data dir: that is the user's live data.

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

fn lint() -> Vec<&'static dyn Feature<MockRuntime>> {
    vec![&Lint]
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
    get_ipc_response(&w, request(&format!("plugin:lint|{cmd}"), args))
        .map(|b| b.deserialize().unwrap())
        .map_err(|e| e.to_string())
}

fn app() -> tauri::App<MockRuntime> {
    let app = app_with(lint());
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
        .all(|c| c.feature == Some("lint") && c.group == "Lint"));
    assert_eq!(manifest().id, "lint");
    assert!(registry::find("lint").is_some_and(|c| !c.writes));
    assert!(registry::find("lint:fix").is_some_and(|c| c.writes));
    let skills: BTreeSet<String> = SKILLS.iter().map(|s| s.name.to_string()).collect();
    assert_eq!(strings(&raw["rust"]["skills"]), skills);
}

#[test]
fn the_settings_fragment_holds_exactly_what_the_engine_reads() {
    let fragment: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    let entries = fragment["settings"].as_array().unwrap();
    let keys: BTreeSet<&str> = entries.iter().map(|s| s["key"].as_str().unwrap()).collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            crate::lint::RULES_ON_KEY,
            crate::lint::RULES_OFF_KEY,
            crate::lint::FIX_ON_SAVE_KEY
        ])
    );
    for e in entries {
        // the lists are differences from the registry: empty until the user chooses
        if e["type"] == "list" {
            assert_eq!(e["default"], json!([]), "{e}");
        }
        if e["key"] == crate::lint::FIX_ON_SAVE_KEY {
            assert_eq!(e["default"], true);
        }
    }
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
fn a_check_answers_through_ipc_in_utf16_offsets() {
    let app = app();
    let answer = call(
        &app,
        "main",
        "lint_check",
        json!({ "request": { "text": "🎉 text   \n" } }),
    )
    .unwrap();
    let f = answer["findings"].as_array().unwrap();
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0]["rule"], "MD009");
    assert_eq!(
        (f[0]["start"].clone(), f[0]["end"].clone()),
        (7.into(), 10.into())
    );
    assert_eq!(f[0]["safe"], true);
    assert_eq!(f[0]["fix"], json!([{ "from": 7, "to": 10, "insert": "" }]));
}

#[test]
fn a_fix_answers_with_the_text_the_rules_and_the_edits() {
    let app = app();
    let fix = |scope: &str| {
        call(
            &app,
            "main",
            "lint_fix",
            json!({ "request": { "text": "a   \n\n\n\n# T.", "scope": scope } }),
        )
        .unwrap()
    };
    let safe = fix("safe");
    assert_eq!(safe["text"], "a\n\n# T.\n");
    assert_eq!(safe["applied"], json!(["MD009", "MD012", "MD047"]));
    assert!(!safe["edits"].as_array().unwrap().is_empty());
    // the setting turns one rule off: the window's settings are read
    let none = call(
        &app,
        "main",
        "lint_fix",
        json!({ "request": { "text": "ok\n", "scope": "all" } }),
    )
    .unwrap();
    assert_eq!(none["text"], "ok\n");
    assert_eq!(none["applied"], json!([]));
    assert_eq!(none["edits"], json!([]));
}

#[test]
fn a_failed_feature_refuses_its_commands_with_feature_unavailable() {
    let app = app();
    crate::features::fail_for_test(app.handle(), "lint");
    let err = call(
        &app,
        "main",
        "lint_check",
        json!({ "request": { "text": "x" } }),
    )
    .unwrap_err();
    assert!(err.contains("Feature unavailable: lint"), "{err}");
}

mod cli_tests {
    //! `writer lint` and `writer lint:fix` through the real argument parser.
    use crate::cli::{execute, Env, SystemClipboard, EXIT_FAIL, EXIT_OK, EXIT_USAGE};
    use serde_json::Value;
    use tempfile::TempDir;

    const MESSY: &str =
        "##Heading\ntext   \n\n\n\nSee [[A|b]]\n![[x.png]]\n> [!note]\n> body\n\npara ^abc\n%%c%%\n";
    const FIXED: &str =
        "## Heading\n\ntext\n\nSee [[A|b]]\n![[x.png]]\n> [!note]\n> body\n\npara ^abc\n%%c%%\n";

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
                read_stdin: || Ok(String::new()),
            };
            let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
            execute(&argv, self.vault.path(), &env)
        }

        fn note(&self) -> String {
            std::fs::read_to_string(self.vault.path().join("Note.md")).unwrap()
        }
    }

    #[test]
    fn lint_lists_the_findings_and_writes_nothing() {
        let v = Vaults::new(MESSY);
        let o = v.run(&["lint", "path=Note.md"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(o.stdout.contains("Note.md:1:3 MD018"), "{}", o.stdout);
        assert!(o.stdout.contains("Note.md:2:5 MD009"), "{}", o.stdout);
        assert!(o.stdout.contains("[fixable]"), "{}", o.stdout);
        assert!(o.stderr.is_empty(), "{}", o.stderr);
        assert_eq!(v.note(), MESSY, "lint is read-only");
    }

    #[test]
    fn lint_json_is_the_same_findings_for_an_agent() {
        let v = Vaults::new(MESSY);
        let o = v.run(&["lint", "path=Note.md", "format=json"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        let json: Value = serde_json::from_str(&o.stdout).unwrap();
        assert_eq!(json["path"], "Note.md");
        assert_eq!(json["clean"], false);
        let f = json["findings"].as_array().unwrap();
        let trailing = f.iter().find(|x| x["rule"] == "MD009").unwrap();
        assert_eq!(trailing["line"], 2);
        assert_eq!(trailing["column"], 5);
        assert_eq!(trailing["fixable"], true);
        assert_eq!(trailing["safe"], true);
        assert_eq!(trailing["name"], "Trailing spaces");
    }

    #[test]
    fn lint_fix_rewrites_the_note_and_leaves_obsidian_syntax_alone() {
        let v = Vaults::new(MESSY);
        let o = v.run(&["lint:fix", "path=Note.md"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(v.note(), FIXED);
        assert!(
            o.stdout
                .starts_with("Note.md: fixed MD009, MD012, MD018, MD022"),
            "{}",
            o.stdout
        );
        for kept in ["[[A|b]]", "![[x.png]]", "> [!note]", "^abc", "%%c%%"] {
            assert!(v.note().contains(kept), "{kept}");
        }
        // a second run has nothing to do and says so
        let again = v.run(&["lint:fix", "path=Note.md"]);
        assert_eq!(again.stdout, "Note.md: nothing to fix\n");
        assert_eq!(v.note(), FIXED);
        // the name works too, like every note command
        assert_eq!(v.run(&["lint:fix", "file=Note"]).code, EXIT_OK);
    }

    #[test]
    fn scope_all_runs_the_unsafe_rules_and_rules_overrides_the_settings() {
        let v = Vaults::new("# Title.\n\ntext   \n");
        // safe: the unsafe MD026 stays; `rules=` picks it explicitly
        assert_eq!(
            v.run(&["lint:fix", "path=Note.md", "rules=MD026"]).code,
            EXIT_OK
        );
        assert_eq!(v.note(), "# Title.\n\ntext   \n", "scope safe skips MD026");
        let o = v.run(&["lint:fix", "path=Note.md", "rules=md026", "scope=all"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(v.note(), "# Title\n\ntext   \n");
        assert!(o.stdout.contains("fixed MD026"), "{}", o.stdout);
    }

    #[test]
    fn the_global_settings_file_decides_the_rules() {
        let v = Vaults::new("one   \n\n\n\ntwo\n");
        std::fs::write(v.data.path().join("config"), "lint.rules-off = MD009\n").unwrap();
        let o = v.run(&["lint:fix", "path=Note.md"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(v.note(), "one   \n\ntwo\n", "MD009 is off, MD012 still on");
    }

    #[test]
    fn what_is_left_is_reported_and_a_clean_note_says_so() {
        let v = Vaults::new("# T\n\nA <b>tag</b>.\n");
        std::fs::write(v.data.path().join("config"), "lint.rules-on = MD033\n").unwrap();
        let o = v.run(&["lint:fix", "path=Note.md"]);
        assert!(o.stdout.contains("nothing to fix"), "{}", o.stdout);
        assert!(o.stdout.contains("1 finding left"), "{}", o.stdout);
        let v = Vaults::new("# Title\n\nAll good.\n");
        assert_eq!(v.run(&["lint", "path=Note.md"]).stdout, "Note.md: clean\n");
    }

    #[test]
    fn bad_input_is_refused() {
        let v = Vaults::new(MESSY);
        std::fs::write(v.vault.path().join("img.txt"), "x").unwrap();
        assert_eq!(
            v.run(&["lint", "path=Note.md", "rules=MD999"]).code,
            EXIT_USAGE
        );
        assert_eq!(
            v.run(&["lint:fix", "path=Note.md", "scope=everything"])
                .code,
            EXIT_USAGE
        );
        assert_eq!(v.run(&["lint", "path=Missing.md"]).code, EXIT_FAIL);
        assert_eq!(
            v.run(&["lint", "path=img.txt"]).code,
            EXIT_FAIL,
            "not Markdown"
        );
        assert_eq!(
            v.run(&["lint", "path=Note.md", "format=csv"]).code,
            EXIT_USAGE
        );
        assert_eq!(v.run(&["lint"]).code, EXIT_USAGE);
        assert_eq!(v.note(), MESSY, "a refusal writes nothing");
    }

    #[test]
    fn with_the_feature_off_the_commands_say_so_instead_of_linting() {
        let v = Vaults::new(MESSY);
        std::fs::write(
            v.data.path().join("config"),
            "features.lint.enabled = false\n",
        )
        .unwrap();
        for line in [["lint", "path=Note.md"], ["lint:fix", "path=Note.md"]] {
            let o = v.run(&line);
            assert_eq!(o.code, EXIT_FAIL);
            assert!(
                o.stderr.contains("lint feature is turned off"),
                "{}",
                o.stderr
            );
        }
        assert_eq!(v.note(), MESSY);
    }
}
