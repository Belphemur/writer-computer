//! The glue under Tauri's mock runtime: the manifest against the code, every command behind the
//! real ACL, the cadence reacting to the agent's points in a real (temporary) repository, the
//! guarantees when the feature is off, when the owner of a point is off and when the vault is not
//! set up, and `writer git:*` through the real argument parser. Every repository is a temp dir
//! with a repository-local identity read in isolation: never the user's git config or vault.

use super::*;
use crate::agent::api::{FileChange, FileChangeKind, TurnFinished, TurnStarted};
use crate::cli::registry;
use crate::config::ConfigValue;
use crate::features::ipc_tests::{request, test_context, with_main_window};
use crate::features::{install_features, Manifest};
use crate::git::repo::ISOLATED;
use crate::state::AppState;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime};
use tauri::Manager;

fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../feature.json")).unwrap()
}

/// The points are process-wide: a test that installs the feature holds this lock, and drops the
/// feature's extensions when it ends.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Forget(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);
impl Drop for Forget {
    fn drop(&mut self) {
        points::retract("git");
    }
}

fn serial() -> Forget {
    Forget(SERIAL.lock().unwrap_or_else(|e| e.into_inner()))
}

/// An app with the features installed from the given settings (`(key, on)` switches).
fn app_with(
    features: Vec<&'static dyn Feature<MockRuntime>>,
    off: &[&str],
) -> tauri::App<MockRuntime> {
    let dir = tempfile::tempdir().unwrap();
    let switches: Vec<(&str, bool)> = off.iter().map(|k| (*k, false)).collect();
    let settings = crate::features::tests::settings_with(dir.path(), &switches);
    let state = AppState::new();
    *state.get_or_create("main").settings.write() =
        Some(crate::features::tests::settings_with(dir.path(), &switches));
    let mut app = mock_builder()
        .setup(move |app| {
            app.manage(state);
            install_features(app.handle(), features, &settings);
            Ok(())
        })
        .build(test_context())
        .expect("the app builds");
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    with_main_window(&app);
    app
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A vault with a repository-local identity, read in isolation on this thread.
fn vault() -> tempfile::TempDir {
    ISOLATED.with(|i| i.set(true));
    let dir = tempfile::tempdir().unwrap();
    crate::git::Repo::init(dir.path()).unwrap();
    let cfg = dir.path().join(".git/config");
    let mut text = std::fs::read_to_string(&cfg).unwrap();
    text.push_str("[user]\n\tname = Ada\n\temail = ada@example.test\n");
    std::fs::write(cfg, text).unwrap();
    dir
}

fn subjects(root: &Path) -> Vec<String> {
    crate::git::Repo::open(root)
        .unwrap()
        .unwrap()
        .log(None, 20)
        .unwrap()
        .into_iter()
        .map(|e| {
            format!(
                "{}({}): {}",
                e.message.ty.map_or("?", crate::git::message::Type::as_str),
                e.message
                    .scope
                    .map_or("?", crate::git::message::Scope::as_str),
                e.message.subject
            )
        })
        .collect()
}

fn started(root: &Path) -> TurnStarted {
    TurnStarted {
        root: root.to_path_buf(),
        chat_id: "chat-1".into(),
    }
}

fn finished(root: &Path, files: &[&str]) -> TurnFinished {
    TurnFinished {
        root: root.to_path_buf(),
        chat_id: "chat-1".into(),
        title: Some("Tidy the plan".into()),
        backend: "claude".into(),
        models: vec!["claude-opus-5-5".into()],
        files: files
            .iter()
            .map(|p| FileChange {
                kind: FileChangeKind::Edit,
                path: p.to_string(),
                from: None,
            })
            .collect(),
    }
}

fn later(s: u64) -> Instant {
    Instant::now() + Duration::from_secs(s)
}

// ---- the manifest against the code ---------------------------------------------------------------

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
    assert!(cli::COMMANDS.iter().all(|c| c.feature == Some("git")));
    assert!(registry::find("git:status").is_some_and(|c| !c.writes));
    assert!(registry::find("git:log").is_some_and(|c| !c.writes));
    assert!(registry::find("git:commit").is_some_and(|c| c.writes));
    let skills: BTreeSet<String> = SKILLS.iter().map(|s| s.name.to_string()).collect();
    assert_eq!(strings(&raw["rust"]["skills"]), skills);
    // it extends the agent's two points, each with a note for when it is off; it owns none and
    // needs nothing (it works alone)
    assert_eq!(
        strings(&raw["extends"]),
        BTreeSet::from([TURN_STARTED.id.to_string(), TURN_FINISHED.id.to_string()])
    );
    let notes: BTreeSet<String> = raw["offNotes"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(notes, strings(&raw["extends"]));
    assert!(manifest().points.is_empty());
    assert!(raw.get("requires").is_none() || raw["requires"] == json!([]));
}

#[test]
fn the_settings_fragment_holds_the_spec_table() {
    let fragment: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    let keys: BTreeSet<&str> = fragment["settings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "git.commit-after",
            "git.sync-interval",
            "git.agent-commits",
            "git.commit-message",
            "git.lfs",
            "git.lfs-threshold-mb",
        ])
    );
    // the engine reads what the page writes
    let cfg = |v: &str| {
        runtime::Config::from_lookup(|k| {
            (k == "git.commit-after").then(|| ConfigValue::String(v.into()))
        })
    };
    assert_eq!(cfg("30s").quiet, Some(Duration::from_secs(30)));
    assert_eq!(cfg("1min").quiet, Some(Duration::from_secs(60)));
    assert_eq!(cfg("5min").quiet, Some(Duration::from_secs(300)));
    assert_eq!(cfg("manual").quiet, None);
    let defaults = runtime::Config::from_lookup(|_| None);
    assert_eq!(defaults.quiet, Some(Duration::from_secs(60)));
    assert!(defaults.agent_commits);
    assert_eq!(defaults.template, "{{notes}}");
}

#[test]
fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    for cmd in &manifest().rust.commands {
        for label in ["main", "w-1"] {
            if app.get_webview_window(label).is_none() {
                tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                    .build()
                    .unwrap();
            }
            let w = app.get_webview_window(label).unwrap();
            let r = get_ipc_response(&w, request(&format!("plugin:git|{cmd}"), json!({})));
            assert!(
                !r.as_ref()
                    .err()
                    .is_some_and(|e| e.to_string().contains("not allowed")),
                "{cmd} from {label}"
            );
        }
        if app.get_webview_window("stranger").is_none() {
            tauri::WebviewWindowBuilder::new(&app, "stranger", Default::default())
                .build()
                .unwrap();
        }
        let w = app.get_webview_window("stranger").unwrap();
        let err = get_ipc_response(&w, request(&format!("plugin:git|{cmd}"), json!({})))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not allowed"), "{cmd}: {err}");
    }
}

// ---- the cadence in a real repository --------------------------------------------------------------

#[test]
fn the_agent_commit_goes_first_and_no_user_commit_runs_during_a_turn() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "mine.md", "1");
    write(&root, "agent.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "Studio").unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);

    // the user's pending edit is committed just before the turn starts
    write(&root, "mine.md", "2");
    vaults.written("main", &root, &[root.join("mine.md")], Instant::now());
    points::emit(&TURN_STARTED_POINT, &started(&root));
    assert_eq!(subjects(&root)[0], "user(edit): mine");
    assert!(vaults.turn_running("main"));

    // during the turn: the agent edits its file, the user edits another; the quiet time passes
    write(&root, "agent.md", "2");
    write(&root, "other.md", "new");
    vaults.written(
        "main",
        &root,
        &[root.join("agent.md"), root.join("other.md")],
        Instant::now(),
    );
    runtime::tick(app.handle(), later(600));
    assert_eq!(subjects(&root).len(), 2, "no commit while the turn runs");

    // the turn ends: its commit first, then the quiet timer resumes for the rest
    points::emit(&TURN_FINISHED_POINT, &finished(&root, &["agent.md"]));
    assert!(!vaults.turn_running("main"));
    runtime::tick(app.handle(), later(601));
    let log = subjects(&root);
    assert_eq!(log[0], "agent(edit): Tidy the plan");
    assert_eq!(log.len(), 3);
    runtime::tick(app.handle(), later(602));
    let log = subjects(&root);
    assert_eq!(log[0], "user(add): other");
    assert_eq!(log[1], "agent(edit): Tidy the plan");
    // the agent commit carries the trailers
    let repo = crate::git::Repo::open(&root).unwrap().unwrap();
    let entry = &repo.log(None, 5).unwrap()[1];
    assert_eq!(entry.message.chat.as_deref(), Some("chat-1"));
    assert_eq!(entry.message.agent.as_deref(), Some("claude"));
    assert_eq!(entry.message.models, vec!["claude-opus-5-5"]);
    assert_eq!(
        entry.message.device.as_deref().map(str::is_empty),
        Some(false)
    );
    assert!(repo.changes().unwrap().is_empty());
}

use crate::agent::api::{TURN_FINISHED as TURN_FINISHED_POINT, TURN_STARTED as TURN_STARTED_POINT};

#[test]
fn agent_commits_off_leaves_the_agents_files_to_the_users_commit() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    app.state::<runtime::Vaults>().open("main", &root);
    // the window's settings turn agent commits off
    {
        let state = app.state::<AppState>().get_or_create("main");
        let mut guard = state.settings.write();
        guard
            .as_mut()
            .unwrap()
            .set_global("git.agent-commits", ConfigValue::Bool(false))
            .unwrap();
    }
    points::emit(&TURN_STARTED_POINT, &started(&root));
    write(&root, "a.md", "2");
    points::emit(&TURN_FINISHED_POINT, &finished(&root, &["a.md"]));
    runtime::tick(app.handle(), later(10));
    assert_eq!(subjects(&root).len(), 1, "no agent commit");
}

#[test]
fn a_vault_that_is_not_set_up_gets_no_commit_and_no_error_from_any_hook() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    points::emit(&TURN_STARTED_POINT, &started(&root));
    points::emit(&TURN_FINISHED_POINT, &finished(&root, &["a.md"]));
    runtime::tick(app.handle(), later(1000));
    runtime::flush(app.handle(), "main");
    assert!(!root.join(".git").exists(), "nothing was created");
    assert!(!root.join(".gitignore").exists());
    assert_eq!(vaults.error_of("main"), None);
}

#[test]
fn a_paused_vault_is_never_committed() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    crate::git::state::set_paused(&root, true).unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    write(&root, "a.md", "2");
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(1000));
    runtime::flush(app.handle(), "main");
    assert_eq!(subjects(&root).len(), 1);
}

#[test]
fn writes_to_device_local_state_never_reset_the_timer() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    write(&root, "a.md", "1");
    let t0 = Instant::now();
    vaults.written("main", &root, &[root.join("a.md")], t0);
    // the workspace file is rewritten constantly: it must not push the commit back
    vaults.written(
        "main",
        &root,
        &[root.join(".obsidian/workspace.json")],
        t0 + Duration::from_secs(50),
    );
    runtime::tick(app.handle(), t0 + Duration::from_secs(61));
    assert_eq!(subjects(&root)[0], "user(add): a");
}

#[test]
fn a_missing_identity_is_an_explicit_error_state_and_nothing_is_committed() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    ISOLATED.with(|i| i.set(true));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    // an existing repository with no identity, already set up by an earlier run
    crate::git::Repo::init(&root).unwrap();
    std::fs::write(root.join(".gitignore"), crate::git::ignore::apply("")).unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(100));
    let error = vaults.error_of("main").unwrap();
    assert!(error.starts_with("Set your git name and email"), "{error}");
    assert!(error.contains("git config --global user.name"));
    let repo = crate::git::Repo::open(&root).unwrap().unwrap();
    assert!(!repo.has_commits());
}

// ---- off ---------------------------------------------------------------------------------------------

#[test]
fn with_the_feature_off_nothing_is_set_up_and_no_point_has_a_subscriber() {
    let _forget = serial();
    points::retract("git");
    let app = app_with(vec![&Git], &["features.git.enabled"]);
    assert!(
        app.try_state::<runtime::Vaults>().is_none(),
        "no state, no hooks"
    );
    assert!(!points::extended_by(TURN_STARTED_POINT.id, "git"));
    assert!(!points::extended_by(TURN_FINISHED_POINT.id, "git"));
    // its CLI commands answer "turned off" and its skill is held back
    assert!(crate::features::held_skills(|m| m.id != "git").contains(&"writer-git"));
    // an emit with nobody listening returns at once
    points::emit(
        &TURN_FINISHED_POINT,
        &finished(Path::new("/nowhere"), &["a.md"]),
    );
}

#[test]
fn with_the_agent_off_its_points_are_not_delivered_but_git_still_works() {
    let _forget = serial();
    let app = app_with(vec![&Git], &["features.agent.enabled"]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    // the owner is off: the extension is ignored, the turn is never tracked
    points::emit(&TURN_STARTED_POINT, &started(&root));
    assert!(!vaults.turn_running("main"));
    // the user's own history still works alone
    write(&root, "a.md", "2");
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(61));
    assert_eq!(subjects(&root)[0], "user(edit): a");
}

#[test]
fn a_panicking_contribution_fails_git_only_and_the_other_contributors_still_run() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    points::extend(app.handle(), &TURN_FINISHED_POINT, "git", |_| {
        panic!("boom")
    });
    points::extend_raw(&TURN_FINISHED_POINT, "zz-probe", |a| {
        if a.root == Path::new("/nowhere") {
            CALLS.fetch_add(1, Ordering::SeqCst);
        }
    });
    points::emit(&TURN_FINISHED_POINT, &finished(Path::new("/nowhere"), &[]));
    points::retract("zz-probe");
    assert_eq!(CALLS.load(Ordering::SeqCst), 1, "the next contributor ran");
    assert!(crate::features::containment(app.handle()).is_some_and(|c| c.is_failed("git")));
}

#[test]
fn shutdown_releases_everything_the_feature_owns() {
    let _forget = serial();
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = app.state::<runtime::Vaults>();
    vaults.open("main", &root);
    assert!(points::extended_by(TURN_FINISHED_POINT.id, "git"));
    assert!(!vaults.busy());
    vaults.shutdown();
    assert!(vaults.stopped());
    assert!(!points::extended_by(TURN_STARTED_POINT.id, "git"));
    assert!(!points::extended_by(TURN_FINISHED_POINT.id, "git"));
    assert!(vaults.labels().is_empty());
    // nothing answers any more: no write is recorded, no turn tracked
    write(&root, "a.md", "2");
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(1000));
    assert_eq!(subjects(&root).len(), 1);
}

mod cli_tests {
    //! `writer git:*` through the real argument parser on a temp vault and data dir.
    use crate::cli::{execute, Env, SystemClipboard, EXIT_FAIL, EXIT_OK, EXIT_USAGE};
    use crate::git::repo::ISOLATED;
    use serde_json::Value;
    use tempfile::TempDir;

    struct World {
        vault: TempDir,
        data: TempDir,
    }

    impl World {
        fn new() -> Self {
            ISOLATED.with(|i| i.set(true));
            let w = World {
                vault: TempDir::new().unwrap(),
                data: TempDir::new().unwrap(),
            };
            std::fs::write(w.vault.path().join("Plan.md"), "plan").unwrap();
            w
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

        fn set_up(&self) {
            crate::git::Repo::init(self.vault.path()).unwrap();
            let cfg = self.vault.path().join(".git/config");
            let mut text = std::fs::read_to_string(&cfg).unwrap();
            text.push_str("[user]\n\tname = Ada\n\temail = ada@example.test\n");
            std::fs::write(cfg, text).unwrap();
            crate::git::setup(self.vault.path(), crate::git::SetupMode::Existing, "dev").unwrap();
        }
    }

    #[test]
    fn status_says_not_set_up_before_setup_and_lists_changes_after() {
        let w = World::new();
        let o = w.run(&["git:status"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(o.stdout.starts_with("not set up"), "{}", o.stdout);
        w.set_up();
        std::fs::write(w.vault.path().join("Plan.md"), "plan 2").unwrap();
        std::fs::write(w.vault.path().join("New.md"), "n").unwrap();
        let o = w.run(&["git:status"]);
        assert!(o.stdout.contains("remote: none"), "{}", o.stdout);
        assert!(
            o.stdout.contains("edit Plan.md") && o.stdout.contains("add New.md"),
            "{}",
            o.stdout
        );
        let j: Value = serde_json::from_str(&w.run(&["git:status", "format=json"]).stdout).unwrap();
        assert_eq!(j["setUp"], true);
        assert_eq!(j["remote"], "none");
        assert_eq!(j["changed"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn commit_saves_a_user_version_and_log_reads_it_back() {
        let w = World::new();
        w.set_up();
        std::fs::write(w.vault.path().join("Plan.md"), "plan 2").unwrap();
        let o = w.run(&["git:commit"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(o.stdout.starts_with("committed "), "{}", o.stdout);
        assert_eq!(w.run(&["git:commit"]).stdout, "nothing to commit\n");
        let o = w.run(&["git:log", "path=Plan.md"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(
            o.stdout.contains("user(edit) Plan [device "),
            "{}",
            o.stdout
        );
        let j: Value =
            serde_json::from_str(&w.run(&["git:log", "path=Plan.md", "format=json"]).stdout)
                .unwrap();
        let versions = j["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0]["type"], "user");
        assert_eq!(versions[0]["scope"], "edit");
        assert_eq!(versions[0]["agent"], Value::Null);
        assert_eq!(versions[1]["type"], "chore");
    }

    #[test]
    fn bad_input_and_an_unset_vault_are_refused() {
        let w = World::new();
        assert_eq!(w.run(&["git:commit"]).code, EXIT_FAIL, "not set up");
        assert_eq!(
            w.run(&["git:log", "path=Plan.md"]).code,
            EXIT_FAIL,
            "not set up"
        );
        w.set_up();
        assert_eq!(
            w.run(&["git:log", "path=Plan.md", "limit=x"]).code,
            EXIT_USAGE
        );
        assert_eq!(w.run(&["git:status", "format=csv"]).code, EXIT_USAGE);
    }

    #[test]
    fn with_the_feature_off_the_commands_say_so() {
        let w = World::new();
        std::fs::write(
            w.data.path().join("config"),
            "features.git.enabled = false\n",
        )
        .unwrap();
        for line in [["git:status"], ["git:commit"]] {
            let o = w.run(&line);
            assert_eq!(o.code, EXIT_FAIL);
            assert!(
                o.stderr.contains("git feature is turned off"),
                "{}",
                o.stderr
            );
        }
    }
}
