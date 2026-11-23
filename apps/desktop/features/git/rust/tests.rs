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

/// The owner's side of a point: what the agent does through its own `Points` handle.
fn emit_point<A: 'static>(
    app: &tauri::App<tauri::test::MockRuntime>,
    point: &crate::features::points::Point<A>,
    args: &A,
) {
    app.state::<crate::features::points::Points>()
        .emit(point, args);
}

fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../feature.json")).unwrap()
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
        turn_id: Some("turn-1".into()),
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
    // LFS: off at 100 MB by default, read from the two settings
    assert!(!defaults.lfs_on);
    assert_eq!(
        defaults.lfs_threshold_mb,
        crate::git::lfs::DEFAULT_THRESHOLD_MB
    );
    // the Rust constant is the schema's default, one number
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    let def = schema["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["key"] == "git.lfs-threshold-mb")
        .unwrap();
    assert_eq!(
        def["default"].as_f64(),
        Some(crate::git::lfs::DEFAULT_THRESHOLD_MB)
    );
    let lfs = runtime::Config::from_lookup(|k| match k {
        "git.lfs" => Some(ConfigValue::Bool(true)),
        "git.lfs-threshold-mb" => Some(ConfigValue::Number(25.0)),
        _ => None,
    });
    assert!(lfs.lfs_on);
    assert_eq!(lfs.lfs_threshold_mb, 25.0);
    // and what applies needs git-lfs: the setting alone is not LFS
    assert!(!crate::git::Lfs::from_settings(lfs.lfs_on, lfs.lfs_threshold_mb, false).enabled);
    assert_eq!(
        crate::git::Lfs::from_settings(lfs.lfs_on, lfs.lfs_threshold_mb, true).threshold,
        25 * 1024 * 1024
    );
}

#[test]
fn every_command_is_allowed_from_main_and_workspace_windows_and_nowhere_else() {
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
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "mine.md", "1");
    write(&root, "agent.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "Studio").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);

    // the user's pending edit is committed just before the turn starts
    write(&root, "mine.md", "2");
    vaults.written("main", &root, &[root.join("mine.md")], Instant::now());
    emit_point(&app, &TURN_STARTED_POINT, &started(&root));
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
    emit_point(&app, &TURN_FINISHED_POINT, &finished(&root, &["agent.md"]));
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
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    runtime::vaults(app.handle()).unwrap().open("main", &root);
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
    emit_point(&app, &TURN_STARTED_POINT, &started(&root));
    write(&root, "a.md", "2");
    emit_point(&app, &TURN_FINISHED_POINT, &finished(&root, &["a.md"]));
    runtime::tick(app.handle(), later(10));
    assert_eq!(subjects(&root).len(), 1, "no agent commit");
}

#[test]
fn a_vault_that_is_not_set_up_gets_no_commit_and_no_error_from_any_hook() {
    let app = app_with(vec![&Git], &[]);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    // "Stop version history": the vault is not set up, and stays so
    crate::git::stop(&root).unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    emit_point(&app, &TURN_STARTED_POINT, &started(&root));
    emit_point(&app, &TURN_FINISHED_POINT, &finished(&root, &["a.md"]));
    runtime::tick(app.handle(), later(1000));
    runtime::flush(app.handle(), "main");
    assert!(!root.join(".git").exists(), "nothing was created");
    assert!(!root.join(".gitignore").exists());
    assert_eq!(vaults.error_of("main"), None);
}

#[test]
fn the_first_tick_after_open_sets_a_plain_vault_up_by_default_once() {
    let app = app_with(vec![&Git], &[]);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    runtime::tick(app.handle(), later(1));
    assert!(root.join(".git").exists(), "git init");
    assert!(crate::git::is_set_up(&root), "the managed block is written");
    // the user stops it: it is not set up again on the next tick, nor on the next open
    crate::git::stop(&root).unwrap();
    runtime::tick(app.handle(), later(2));
    assert!(!crate::git::is_set_up(&root));
    vaults.open("main", &root);
    runtime::tick(app.handle(), later(3));
    assert!(!crate::git::is_set_up(&root));
}

#[test]
fn a_vault_inside_another_repository_is_not_set_up_by_the_tick() {
    let app = app_with(vec![&Git], &[]);
    let outer = tempfile::tempdir().unwrap();
    let outer_root = outer.path().canonicalize().unwrap();
    std::fs::create_dir_all(outer_root.join(".git")).unwrap();
    let root = outer_root.join("docs");
    write(&root, "a.md", "1");
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    runtime::tick(app.handle(), later(1));
    assert!(!root.join(".git").exists());
    assert!(!root.join(".gitignore").exists());
    assert_eq!(vaults.error_of("main"), None);
}

#[test]
fn a_paused_vault_is_never_committed() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    crate::git::state::set_paused(&root, true).unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    write(&root, "a.md", "2");
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(1000));
    runtime::flush(app.handle(), "main");
    assert_eq!(subjects(&root).len(), 1);
}

#[test]
fn writes_to_device_local_state_never_reset_the_timer() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
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
    let app = app_with(vec![&Git], &[]);
    ISOLATED.with(|i| i.set(true));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    // an existing repository with no identity, already set up by an earlier run
    crate::git::Repo::init(&root).unwrap();
    std::fs::write(root.join(".gitignore"), crate::git::ignore::apply("")).unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
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
    let app = app_with(vec![&Git], &["features.git.enabled"]);
    assert!(
        runtime::vaults(app.handle()).is_none(),
        "no state, no hooks"
    );
    assert!(!app
        .state::<crate::features::points::Points>()
        .extended_by(TURN_STARTED_POINT.id, "git"));
    assert!(!app
        .state::<crate::features::points::Points>()
        .extended_by(TURN_FINISHED_POINT.id, "git"));
    // its CLI commands answer "turned off" and its skill is held back
    assert!(crate::features::held_skills(|m| m.id != "git").contains(&"writer-git"));
    // an emit with nobody listening returns at once
    emit_point(
        &app,
        &TURN_FINISHED_POINT,
        &finished(Path::new("/nowhere"), &["a.md"]),
    );
}

#[test]
fn with_the_agent_off_nothing_is_announced_and_git_still_works_alone() {
    let app = app_with(vec![&Git], &["features.agent.enabled"]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    // the owner is off, so it announces nothing: no turn is tracked (an owner that is turned
    // off mid-turn still announces the end of that turn, which git hears)
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
    let app = app_with(vec![&Git], &[]);
    points::extend(app.handle(), &TURN_FINISHED_POINT, "git", |_| {
        panic!("boom")
    });
    app.state::<crate::features::points::Points>().extend_raw(
        &TURN_FINISHED_POINT,
        "zz-probe",
        |a| {
            if a.root == Path::new("/nowhere") {
                CALLS.fetch_add(1, Ordering::SeqCst);
            }
        },
    );
    emit_point(
        &app,
        &TURN_FINISHED_POINT,
        &finished(Path::new("/nowhere"), &[]),
    );
    app.state::<crate::features::points::Points>()
        .retract("zz-probe");
    assert_eq!(CALLS.load(Ordering::SeqCst), 1, "the next contributor ran");
    assert!(crate::features::containment(app.handle()).is_some_and(|c| c.is_failed("git")));
}

#[test]
fn nothing_is_committed_during_a_merge_and_it_resumes_when_the_merge_ends() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    let before = subjects(&root).len();
    std::fs::write(root.join(".git/MERGE_HEAD"), "x").unwrap();
    write(&root, "a.md", "2");
    vaults.written("main", &root, &[root.join("a.md")], Instant::now());
    runtime::tick(app.handle(), later(61));
    assert_eq!(subjects(&root).len(), before, "paused");
    std::fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
    runtime::tick(app.handle(), later(200));
    assert_eq!(subjects(&root).len(), before + 1, "resumed by itself");
}

#[test]
fn shutdown_releases_everything_the_feature_owns() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "d").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    assert!(!vaults.busy());
    // the global points registry is shared with every other test, so only this vault's own
    // state is asserted here (the scope's release is the scope module's test)
    vaults.shutdown();
    assert!(vaults.stopped());
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

    /// Three versions of Plan.md; the revs of the second and the third, newest last.
    fn three_versions(w: &World) -> (String, String) {
        w.set_up();
        for text in ["one\ntwo\n", "one\nTWO\nthree\n"] {
            std::fs::write(w.vault.path().join("Plan.md"), text).unwrap();
            assert_eq!(w.run(&["git:commit"]).code, EXIT_OK);
        }
        let j: Value =
            serde_json::from_str(&w.run(&["git:log", "path=Plan.md", "format=json"]).stdout)
                .unwrap();
        let v = j["versions"].as_array().unwrap();
        (
            v[1]["rev"].as_str().unwrap().to_string(),
            v[0]["rev"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn diff_shows_a_versions_change_against_its_parent_the_file_now_or_another_version() {
        let w = World::new();
        let (first, second) = three_versions(&w);
        let o = w.run(&["git:diff", "path=Plan.md", &format!("rev={}", &second[..8])]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(o.stdout.starts_with("+2 -1\n"), "{}", o.stdout);
        assert!(
            o.stdout.contains("- two")
                && o.stdout.contains("+ TWO")
                && o.stdout.contains("+ three"),
            "{}",
            o.stdout
        );
        // no rev: the latest version
        assert_eq!(
            w.run(&["git:diff", "path=Plan.md"]).stdout,
            w.run(&["git:diff", "path=Plan.md", &format!("rev={second}")])
                .stdout
        );
        std::fs::write(w.vault.path().join("Plan.md"), "one\nTWO\nthree\nfour\n").unwrap();
        let o = w.run(&[
            "git:diff",
            "path=Plan.md",
            &format!("rev={first}"),
            "against=current",
        ]);
        assert!(o.stdout.starts_with("+3 -1\n"), "{}", o.stdout);
        let o = w.run(&[
            "git:diff",
            "path=Plan.md",
            &format!("rev={second}"),
            &format!("against={first}"),
        ]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        let j: Value =
            serde_json::from_str(&w.run(&["git:diff", "path=Plan.md", "format=json"]).stdout)
                .unwrap();
        assert_eq!(j["kind"], "text");
        assert_eq!(j["diff"]["added"], 2);
    }

    #[test]
    fn show_prints_a_version_and_restore_writes_it_back_as_a_new_version() {
        let w = World::new();
        let (first, _second) = three_versions(&w);
        let o = w.run(&["git:show", "path=Plan.md", &format!("rev={first}")]);
        assert_eq!(o.stdout, "one\ntwo\n", "{}", o.stderr);
        let o = w.run(&["git:restore", "path=Plan.md", &format!("rev={first}")]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(o.stdout, "restored Plan.md\n");
        assert_eq!(
            std::fs::read_to_string(w.vault.path().join("Plan.md")).unwrap(),
            "one\ntwo\n"
        );
        let log = w.run(&["git:log", "path=Plan.md"]).stdout;
        assert!(
            log.lines()
                .next()
                .unwrap()
                .contains("user(restore) Plan to "),
            "{log}"
        );
        assert_eq!(
            log.lines().count(),
            4,
            "history grew, nothing was rewritten"
        );
        // the same content again is not a new version
        let o = w.run(&["git:restore", "path=Plan.md", &format!("rev={first}")]);
        assert!(o.stdout.contains("already holds"), "{}", o.stdout);
    }

    #[test]
    fn the_history_commands_refuse_an_unset_vault_a_missing_rev_and_an_unknown_one() {
        let w = World::new();
        for line in [
            vec!["git:diff", "path=Plan.md"],
            vec!["git:show", "path=Plan.md", "rev=abcd"],
            vec!["git:restore", "path=Plan.md", "rev=abcd"],
        ] {
            assert_eq!(w.run(&line).code, EXIT_FAIL, "{line:?}");
        }
        w.set_up();
        assert_eq!(w.run(&["git:restore", "path=Plan.md"]).code, EXIT_USAGE);
        assert_eq!(
            w.run(&["git:show", "path=Plan.md", "rev=zzzz"]).code,
            EXIT_FAIL
        );
        assert_eq!(
            w.run(&["git:restore", "path=../x.md", "rev=abcd"]).code,
            EXIT_FAIL
        );
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
    fn resolve_takes_a_whole_side_and_status_lists_the_conflict_until_then() {
        use crate::git::sync::tests::{have_git, pair, World as Remote};
        if !have_git() {
            return;
        }
        let remote = Remote::new();
        let note = "one\ntwo\nthree\n";
        let (a, b) = pair(&remote, &[("Note.md", note)]);
        a.write("Note.md", "one\ntwo from A\nthree\n");
        a.commit();
        a.ok();
        b.write("Note.md", "one\ntwo from B\nthree\n");
        b.commit();
        assert_eq!(b.ok().conflicts.len(), 1);
        let data = TempDir::new().unwrap();
        let run = |line: &[&str]| {
            let env = Env {
                app_data_dir: Some(data.path().to_path_buf()),
                clipboard: Box::new(SystemClipboard),
                utc_offset_minutes: 0,
                launcher: Box::new(crate::writer_cli::SystemLauncher),
                launch_wait: std::time::Duration::ZERO,
                read_stdin: || Ok(String::new()),
            };
            let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
            execute(&argv, &b.root, &env)
        };
        let o = run(&["git:status"]);
        assert!(o.stdout.contains("conflict: Note.md"), "{}", o.stdout);
        let o = run(&["git:status", "format=json"]);
        let v: Value = serde_json::from_str(&o.stdout).unwrap();
        assert_eq!(v["conflicted"], serde_json::json!(["Note.md"]));
        // a side is required, and a bad one is refused before anything is written
        assert_eq!(run(&["git:resolve", "path=Note.md"]).code, EXIT_USAGE);
        assert_eq!(
            run(&["git:resolve", "path=Note.md", "take=ours"]).code,
            EXIT_USAGE
        );
        assert_eq!(b.read("Note.md"), "one\ntwo from B\nthree\n");
        let o = run(&["git:resolve", "path=Note.md", "take=theirs"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(b.read("Note.md"), "one\ntwo from A\nthree\n");
        assert!(!run(&["git:status"]).stdout.contains("conflict:"));
        // nothing left to resolve
        assert_eq!(
            run(&["git:resolve", "path=Note.md", "take=mine"]).code,
            EXIT_FAIL
        );
        assert_eq!(
            run(&["git:resolve", "path=../x.md", "take=mine"]).code,
            EXIT_FAIL
        );
    }

    #[test]
    fn with_the_feature_off_the_commands_say_so() {
        let w = World::new();
        std::fs::write(
            w.data.path().join("config"),
            "features.git.enabled = false\n",
        )
        .unwrap();
        for line in [
            ["git:status"],
            ["git:commit"],
            ["git:diff"],
            ["git:show"],
            ["git:restore"],
            ["git:resolve"],
        ] {
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

// ---- one writer at a time ----------------------------------------------------------------------------

#[test]
fn a_ticker_commit_and_a_turn_start_on_a_dirty_vault_make_one_commit_and_no_error() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::LocalOnly, "Studio").unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    for round in 0..5 {
        write(&root, "a.md", &format!("round {round}"));
        vaults.written("main", &root, &[root.join("a.md")], Instant::now());
        let before = subjects(&root).len();
        let (handle, r2) = (app.handle().clone(), root.clone());
        let ticker = std::thread::spawn(move || {
            ISOLATED.with(|i| i.set(true));
            runtime::tick(&handle, later(600 + round));
        });
        emit_point(&app, &TURN_STARTED_POINT, &started(&r2));
        ticker.join().unwrap();
        assert_eq!(
            subjects(&root).len(),
            before + 1,
            "round {round}: one commit"
        );
        assert_eq!(vaults.error_of("main"), None);
        emit_point(&app, &TURN_FINISHED_POINT, &finished(&root, &[]));
    }
}

// ---- sync in the app -----------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn a_running_sync_makes_the_feature_busy_and_stopping_the_scope_ends_it() {
    use std::os::unix::fs::PermissionsExt;
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let sh = |cwd: &Path, args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?}");
    };
    sh(remote.path(), &["init", "--bare", "-b", "main"]);
    sh(&root, &["checkout", "-b", "main"]);
    sh(
        &root,
        &[
            "remote",
            "add",
            "origin",
            &format!("file://{}", remote.path().display()),
        ],
    );
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::Existing, "d").unwrap();
    // the push waits, so the sync is observable
    let hook = root.join(".git/hooks/pre-push");
    std::fs::write(&hook, "#!/bin/sh\nsleep 5\nexit 0\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    let scope = crate::features::scope_of(app.handle(), "git").unwrap();
    assert_eq!(scope.busy_reason(), None);
    let handle = app.handle().clone();
    let worker = std::thread::spawn(move || {
        ISOLATED.with(|i| i.set(true));
        sync::run(&handle, "main", sync::Mode::Manual);
    });
    let start = Instant::now();
    while scope.busy_reason().is_none() && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(scope.busy_reason().as_deref(), Some("a sync in progress"));
    assert!(vaults.is_syncing("main"));
    // turning git off kills the git child: the sync ends long before the hook's sleep
    scope.shutdown(Duration::from_secs(3));
    worker.join().unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "the child was killed"
    );
    assert!(!vaults.is_syncing("main"));
}

#[cfg(unix)]
#[test]
fn closing_a_window_waits_for_its_sync_within_one_budget_and_never_runs_git_itself() {
    use std::os::unix::fs::PermissionsExt;
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let sh = |cwd: &Path, args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?}");
    };
    sh(remote.path(), &["init", "--bare", "-b", "main"]);
    sh(&root, &["checkout", "-b", "main"]);
    sh(
        &root,
        &[
            "remote",
            "add",
            "origin",
            &format!("file://{}", remote.path().display()),
        ],
    );
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::Existing, "d").unwrap();
    // a remote that hangs: every push sleeps far past the budget (the repository's own hooks,
    // whatever a global `core.hooksPath` says)
    let hooks = root.join(".git/hooks");
    sh(
        &root,
        &["config", "core.hooksPath", &hooks.to_string_lossy()],
    );
    let hook = hooks.join("pre-push");
    let marker = remote.path().join("push-started");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ntouch '{}'\nsleep 60\nexit 0\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    runtime::vaults(app.handle()).unwrap().open("main", &root);
    write(&root, "b.md", "pending");
    let start = Instant::now();
    Git.on_workspace_close(app.handle(), "main");
    let took = start.elapsed();
    assert!(
        took < sync::CLOSE_BUDGET + Duration::from_secs(3),
        "the close waited {took:?}"
    );
    // the sync really ran into the hanging push, and the pending edit was committed first
    assert!(marker.exists(), "the sync never reached the push");
    assert!(subjects(&root).len() >= 2, "{:?}", subjects(&root));
}

// ---- settling a conflict ---------------------------------------------------------------------------

#[test]
fn a_resolution_is_busy_while_it_writes_tells_the_editors_and_asks_the_sync_to_resume() {
    use tauri::Listener;
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::Existing, "d").unwrap();
    *app.state::<AppState>()
        .get_or_create("main")
        .workspace_root
        .write() = Some(root.clone());
    let vaults = runtime::vaults(app.handle()).unwrap();
    vaults.open("main", &root);
    let scope = crate::features::scope_of(app.handle(), "git").unwrap();
    assert_eq!(scope.busy_reason(), None);
    let heard = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let sink = heard.clone();
    app.listen_any(runtime::APPLYING_EVENT, move |e| {
        sink.lock().push(e.payload().to_string());
    });
    let busy = parking_lot::Mutex::new(None);
    let status = commands::resolving(app.handle(), "main", &root, |announce| {
        *busy.lock() = scope.busy_reason();
        announce(&["a.md".to_string()]);
        Ok(())
    })
    .unwrap();
    assert_eq!(busy.lock().as_deref(), Some("a commit in progress"));
    assert_eq!(scope.busy_reason(), None, "released afterwards");
    assert!(status.set_up);
    // before the write, then the release once it is done (one typed payload)
    assert_eq!(
        heard.lock().as_slice(),
        [
            r#"{"paths":["a.md"],"done":false}"#,
            r#"{"paths":["a.md"],"done":true}"#
        ]
    );
    // a failed resolution is refused with its own sentence, and nothing stays busy
    let err = commands::resolving(app.handle(), "main", &root, |_| {
        Err(crate::git::resolve::Error::NotConflicted)
    })
    .unwrap_err();
    assert!(err.to_string().contains("not in conflict"), "{err}");
    assert_eq!(scope.busy_reason(), None);
}

#[test]
fn the_merge_commands_refuse_a_vault_that_is_not_set_up_and_a_path_outside_it() {
    let app = app_with(vec![&Git], &[]);
    let dir = vault();
    let root = dir.path().canonicalize().unwrap();
    *app.state::<AppState>()
        .get_or_create("main")
        .workspace_root
        .write() = Some(root.clone());
    let err = commands::conflict_target(app.handle(), "main", "a.md").unwrap_err();
    assert!(err.to_string().contains("not set up"), "{err}");
    write(&root, "a.md", "1");
    crate::git::setup(&root, crate::git::SetupMode::Existing, "d").unwrap();
    let (_, rel) = commands::conflict_target(app.handle(), "main", "a.md").unwrap();
    assert_eq!(rel, "a.md");
    assert!(commands::conflict_target(app.handle(), "main", "../x.md").is_err());
}
