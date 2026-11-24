//! The OpenCode feature's life in the app: the manifest against the code, the `agent.backends`
//! point (answered while the feature is on, retracted when it stops), and the servers it owns
//! (one per window and vault, no process left after a window closes, the vault changes or the
//! feature stops). The servers run against the fake OpenCode of `fake_server_tests.rs`, in a
//! temporary data folder: no test starts the real program or writes the user's folders.

use super::fake_server_tests::{wait_for, FakeLauncher};
use super::servers::{vault_id, Env, Servers, BINARY_SETTING};
use super::*;
use crate::agent::api::BACKENDS;
use crate::config::{ConfigValue, Settings};
use crate::features::points::Points;
use crate::features::scope::Spawner;
use crate::features::{
    exit, install_features, is_started, stop_feature, workspace_close, Manifest,
};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::test::{mock_app, MockRuntime};
use tauri::Manager;

fn settings(on: Option<bool>) -> (tempfile::TempDir, Settings) {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Settings::new(dir.path().to_path_buf()).unwrap();
    if let Some(on) = on {
        s.set_global("features.opencode.enabled", ConfigValue::Bool(on))
            .unwrap();
    }
    (dir, s)
}

fn opencode() -> Vec<&'static dyn Feature<MockRuntime>> {
    vec![&Opencode]
}

fn ask(app: &tauri::App<MockRuntime>, id: &str) -> Option<Arc<crate::agent::backend::Backend>> {
    app.state::<Points>().ask(&BACKENDS, &id.to_string())
}

#[test]
fn the_manifest_names_what_the_feature_does() {
    let m: Manifest = serde_json::from_str(include_str!("../feature.json")).unwrap();
    assert_eq!(m.id, "opencode");
    assert_eq!(m.rust.hooks, ["start", "onWorkspaceClose", "onExit"]);
    assert_eq!(m.extends, ["agent.backends"]);
    assert!(m.has_rust());
    // its settings sit next to the agent's own, under `agent.opencode.`
    assert_eq!(m.settings_namespace.as_deref(), Some("agent.opencode"));
}

#[test]
fn on_it_answers_the_backends_point_for_its_own_id_and_no_other() {
    let (_dir, s) = settings(None);
    let app = mock_app();
    install_features(app.handle(), opencode(), &s);
    assert!(is_started(app.handle(), "opencode"));
    let backend = ask(&app, "opencode").expect("the point has an answer");
    assert_eq!(backend.id, "opencode");
    assert!(backend.ops().session_id_ok("ses_abc123"));
    assert!(!backend
        .ops()
        .session_id_ok("3f1c4ee0-a111-4d52-8c36-6a2f41a29b7c"));
    // the MCP menu: off unless listed, in force at once
    let switches = backend
        .ops()
        .mcp_switches()
        .expect("OpenCode has MCP switches");
    assert!(!switches.default_on);
    assert_eq!(switches.applies, crate::agent::mcp_menu::Applies::Live);
    crate::agent::mcp_menu::assert_switch_contract(
        "opencode",
        &switches,
        include_str!("../settings.schema.json"),
    );
    // the core's own backend is never asked for, and nobody answers for a name it does not know
    assert!(ask(&app, "claude").is_none());
    assert!(ask(&app, "codex").is_none());
}

#[test]
fn it_is_busy_only_while_a_turn_runs() {
    let (_dir, s) = settings(None);
    let app = mock_app();
    install_features(app.handle(), opencode(), &s);
    assert!(crate::features::busy(app.handle())
        .iter()
        .all(|b| b.id != "opencode"));
    assert_eq!(servers_if_started(app.handle()).unwrap().running_turns(), 0);
}

#[test]
fn off_there_is_no_state_no_answer_and_the_hooks_do_nothing() {
    let (_dir, s) = settings(Some(false));
    let app = mock_app();
    install_features(app.handle(), opencode(), &s);
    assert!(!is_started(app.handle(), "opencode"));
    assert!(servers_if_started(app.handle()).is_none());
    assert!(ask(&app, "opencode").is_none());
    assert_eq!(app.state::<Points>().contributors(BACKENDS.id), 0);
    workspace_close(app.handle(), "main");
    exit(app.handle());
}

#[test]
fn stopping_it_retracts_the_point_and_refuses_every_later_server() {
    let (_dir, s) = settings(None);
    let app = mock_app();
    install_features(app.handle(), opencode(), &s);
    let servers = servers_if_started(app.handle()).expect("state is in the scope");
    assert_eq!(app.state::<Points>().contributors(BACKENDS.id), 1);
    stop_feature(app.handle(), "opencode", true);
    assert!(servers_if_started(app.handle()).is_none());
    assert!(ask(&app, "opencode").is_none());
    assert_eq!(app.state::<Points>().contributors(BACKENDS.id), 0);
    // a chat that still holds the old state cannot start a server on it
    let err = servers.server("main", Path::new("/vault")).err().unwrap();
    assert!(err.contains("switched off"), "{err}");
}

#[test]
fn starting_twice_gives_one_answer_and_a_fresh_state() {
    let (_dir, s) = settings(None);
    let app = mock_app();
    install_features(app.handle(), opencode(), &s);
    stop_feature(app.handle(), "opencode", true);
    crate::features::start_feature(app.handle(), &Opencode).unwrap();
    assert_eq!(app.state::<Points>().contributors(BACKENDS.id), 1);
    assert!(ask(&app, "opencode").is_some());
    assert_eq!(servers_if_started(app.handle()).unwrap().count(), 0);
}

// ---------------------------------------------------------------------------------------------
// the servers, against the fake OpenCode

struct Rig {
    app: tauri::App<MockRuntime>,
    servers: Servers<MockRuntime>,
    launcher: Arc<FakeLauncher>,
    data: tempfile::TempDir,
}

fn rig() -> Rig {
    let app = mock_app();
    app.manage(AppState::new());
    let data = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("2.4.0");
    let env: Env = Arc::new(|dir| {
        crate::agent::env::child_env(
            [("HOME".to_string(), "/home/fake".to_string())].into_iter(),
            "/login/bin:/usr/bin",
            dir,
        )
    });
    let servers = Servers::with(
        app.handle().clone(),
        Spawner::detached(),
        launcher.clone(),
        Some(data.path().to_path_buf()),
        env,
    );
    Rig {
        app,
        servers,
        launcher,
        data,
    }
}

fn vault() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    (d, root)
}

fn stopped(p: &Arc<super::fake_server_tests::FakeProcess>) -> bool {
    use super::server::Process;
    p.exited().is_some()
}

#[test]
fn a_window_gets_one_server_per_vault_and_a_vault_switch_replaces_it() {
    let r = rig();
    let (_a, one) = vault();
    let (_b, two) = vault();
    let first = r.servers.server("main", &one).unwrap();
    assert!(Arc::ptr_eq(
        &first,
        &r.servers.server("main", &one).unwrap()
    ));
    assert_eq!(r.servers.count(), 1);
    first.ensure_started().unwrap();
    // another window has its own
    let other = r.servers.server("w-1", &one).unwrap();
    assert!(!Arc::ptr_eq(&first, &other));
    assert_eq!(r.servers.count(), 2);
    // the window opens another vault: the old server (and its process) is gone, a new one made
    let moved = r.servers.server("main", &two).unwrap();
    assert!(!Arc::ptr_eq(&first, &moved));
    let old = r.launcher.current();
    wait_for("the old process", 5, || stopped(&old));
    assert!(first.ensure_started().is_err(), "the old server is stopped");
    assert_eq!(r.servers.count(), 2);
}

#[test]
fn closing_a_window_stops_its_process_and_only_its_own() {
    let r = rig();
    let (_a, root) = vault();
    let main = r.servers.server("main", &root).unwrap();
    let other = r.servers.server("w-1", &root).unwrap();
    main.ensure_started().unwrap();
    let main_process = r.launcher.current();
    other.ensure_started().unwrap();
    let other_process = r.launcher.current();
    r.servers.shutdown_window("main");
    wait_for("the window's process", 5, || stopped(&main_process));
    assert!(!stopped(&other_process));
    assert!(!r.servers.has("main") && r.servers.has("w-1"));
    // the same window can start again afterwards, on a new server
    let again = r.servers.server("main", &root).unwrap();
    assert!(!Arc::ptr_eq(&main, &again));
    assert!(again.ensure_started().is_ok());
}

#[test]
fn shutting_all_down_leaves_no_process_and_refuses_new_servers() {
    let r = rig();
    let (_a, root) = vault();
    let mut processes = Vec::new();
    for label in ["main", "w-1", "w-2"] {
        let s = r.servers.server(label, &root).unwrap();
        s.ensure_started().unwrap();
        processes.push(r.launcher.current());
    }
    assert_eq!(r.servers.count(), 3);
    r.servers.shutdown_all();
    assert!(processes.iter().all(stopped));
    assert_eq!(r.servers.count(), 0);
    assert!(r.servers.server("main", &root).is_err());
}

#[test]
fn a_server_for_settings_gets_writers_config_before_it_starts_and_the_launcher_first_on_path() {
    let r = rig();
    let (_a, root) = vault();
    let server = r.servers.ensure_up("main", &root).unwrap();
    assert!(server.connection().is_some());
    // Writer's file, in the data folder (never the vault), written before the server started
    let file = r
        .data
        .path()
        .join("opencode")
        .join(format!("{}.json", vault_id(&root)));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("\"default_agent\": \"writer\""), "{text}");
    assert!(!root.join("opencode.json").exists());
    // the launcher's folder leads PATH, the config file is the server's own
    let spec = r.launcher.specs.lock()[0].clone();
    let env = |k: &str| {
        spec.env
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
    };
    // (the launcher's folder is made once per run, so it is some test's temporary `bin`)
    let path = env("PATH").unwrap();
    let first = path.split(':').next().unwrap();
    assert!(first.ends_with("/bin") && first != "/login/bin", "{path}");
    assert!(path.contains("/login/bin:/usr/bin"), "{path}");
    assert_eq!(env("OPENCODE_CONFIG").unwrap(), file.to_string_lossy());
    assert_eq!(env("OPENCODE_DISABLE_PROJECT_CONFIG").as_deref(), Some("1"));
    assert!(env("SHELL").unwrap().ends_with("writer-shell"));
    // asking again for the running server writes nothing and starts nothing
    r.servers.ensure_up("main", &root).unwrap();
    assert_eq!(r.launcher.launches(), 1);
}

#[test]
fn the_users_own_program_path_is_the_one_that_runs() {
    let r = rig();
    let program = r.data.path().join("my-opencode");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let state = r.app.state::<AppState>().get_or_create("main");
    let (dir, mut s) = settings(None);
    s.set_global(
        BINARY_SETTING,
        ConfigValue::String(program.to_string_lossy().into_owned()),
    )
    .unwrap();
    *state.settings.write() = Some(s);
    let (_a, root) = vault();
    assert_eq!(r.servers.find("main").as_deref(), Some(program.as_path()));
    r.servers
        .server("main", &root)
        .unwrap()
        .ensure_started()
        .unwrap();
    assert_eq!(r.launcher.specs.lock()[0].program, program);
    drop(dir);
}

#[test]
fn the_config_file_is_named_after_the_vault_without_naming_it() {
    let a = vault_id(Path::new("/Users/someone/Notes"));
    assert_eq!(a, vault_id(Path::new("/Users/someone/Notes")));
    assert_ne!(a, vault_id(Path::new("/Users/someone/Other")));
    assert_eq!(a.len(), 16);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn a_session_id_is_checked_before_it_reaches_a_url() {
    use super::driver::session_id_ok;
    assert!(session_id_ok("ses_f0a1B2"));
    for bad in [
        "",
        "ses_",
        "ses_a/b",
        "ses_a b",
        "ses_..",
        "msg_abc",
        "../x",
        "ses_a?x=1",
    ] {
        assert!(!session_id_ok(bad), "{bad:?}");
    }
}

#[test]
fn the_title_call_tries_the_cheap_model_then_the_chats_own_and_nothing_else() {
    use super::driver::title_candidates;
    let some = |m: &str| Some(m.to_string());
    assert_eq!(
        title_candidates(Some("p/cheap"), Some("p/chat#high")),
        [some("p/cheap"), some("p/chat")]
    );
    // the same model once; a variant never changes the model
    assert_eq!(
        title_candidates(Some("p/m"), Some("p/m#low")),
        [some("p/m")]
    );
    // a name that is not provider/model is no model: with neither there is no title
    assert_eq!(
        title_candidates(Some("haiku"), None),
        Vec::<Option<String>>::new()
    );
    assert_eq!(title_candidates(None, Some("p/chat")), [some("p/chat")]);
}

// ---------------------------------------------------------------------------------------------
// what the agent asks of the backend: delete and title

fn backend_on(r: Rig) -> (Arc<crate::agent::backend::Backend>, Arc<FakeLauncher>, Rig2) {
    let (backend, launcher, _servers, keep) = backend_and_servers(r);
    (backend, launcher, keep)
}

/// [`backend_on`] with the servers the backend answers from (to see what it owes).
fn backend_and_servers(
    r: Rig,
) -> (
    Arc<crate::agent::backend::Backend>,
    Arc<FakeLauncher>,
    Arc<Servers<MockRuntime>>,
    Rig2,
) {
    let launcher = Arc::clone(&r.launcher);
    let servers = Arc::new(r.servers);
    (
        super::driver::backend(Arc::clone(&servers)),
        launcher,
        servers,
        Rig2 {
            _app: r.app,
            _data: r.data,
        },
    )
}

/// What of the rig must outlive the backend.
struct Rig2 {
    _app: tauri::App<MockRuntime>,
    _data: tempfile::TempDir,
}

fn requests(l: &FakeLauncher) -> Vec<(String, String, serde_json::Value)> {
    l.current()
        .server
        .shared
        .requests
        .lock()
        .iter()
        .map(|q| (q.method.clone(), q.path.clone(), q.body.clone()))
        .collect()
}

#[test]
fn deleting_a_chat_deletes_its_session_when_a_server_is_up_and_a_bad_id_asks_nothing() {
    use crate::agent::backend::ForgetCtx;
    let (_v, root) = vault();
    let r = rig();
    r.servers.ensure_up("main", &root).unwrap();
    let (backend, launcher, servers, _keep) = backend_and_servers(r);
    let ctx = |id| ForgetCtx {
        label: "main",
        root: &root,
        session_id: id,
    };
    // an id that is not a session id never reaches a URL, and nothing is kept for it
    for bad in [
        "",
        "../x",
        "ses_a/b",
        "3f1c4ee0-a111-4d52-8c36-6a2f41a29b7c",
    ] {
        backend.ops().forget(&ctx(bad));
    }
    assert!(servers.owed(&root).is_empty());
    assert!(!requests(&launcher).iter().any(|(m, _, _)| m == "DELETE"));
    backend.ops().forget(&ctx("ses_gone1"));
    let delete = requests(&launcher)
        .into_iter()
        .find(|(m, p, _)| m == "DELETE" && p == "/api/session/ses_gone1");
    assert!(delete.is_some(), "{:?}", requests(&launcher));
    assert!(servers.owed(&root).is_empty(), "deleted, nothing owed");
}

#[test]
fn deleting_a_chat_with_no_server_starts_none_and_deletes_the_session_at_the_next_start() {
    use crate::agent::backend::ForgetCtx;
    let (_v, root) = vault();
    let (backend, launcher, servers, _keep) = backend_and_servers(rig());
    backend.ops().forget(&ForgetCtx {
        label: "main",
        root: &root,
        session_id: "ses_gone1",
    });
    assert_eq!(launcher.launches(), 0, "nothing is started to delete");
    assert_eq!(servers.owed(&root), ["ses_gone1"]);
    // the file is ids only, in the app data folder (never the vault)
    let kept = std::fs::read_dir(_keep._data.path().join("opencode"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    // another vault does not get it
    let (_w, other) = vault();
    assert!(servers.owed(&other).is_empty());
    // the next start of a server for this vault pays it
    servers.ensure_up("main", &root).unwrap();
    wait_for("the delete", 5, || {
        requests(&launcher)
            .iter()
            .any(|(m, p, _)| m == "DELETE" && p == "/api/session/ses_gone1")
    });
    wait_for("nothing owed", 5, || servers.owed(&root).is_empty());
}

#[test]
fn a_session_that_could_not_be_deleted_is_owed_again() {
    use crate::agent::backend::ForgetCtx;
    let (_v, root) = vault();
    let r = rig();
    r.servers.ensure_up("main", &root).unwrap();
    let fake = r.launcher.current().server.clone();
    *fake.shared.handler.lock() = Some(Box::new(|req| {
        (req.method == "DELETE").then(|| (500, serde_json::json!({"_tag": "UnknownError"})))
    }));
    let (backend, _launcher, servers, _keep) = backend_and_servers(r);
    backend.ops().forget(&ForgetCtx {
        label: "main",
        root: &root,
        session_id: "ses_stuck",
    });
    assert_eq!(servers.owed(&root), ["ses_stuck"]);
}

#[test]
fn closing_a_window_returns_at_once_and_the_process_is_stopped_later() {
    let r = rig();
    // a process that is slow to end (it ignores SIGTERM for a while)
    *r.launcher.stop_delay.lock() = Duration::from_millis(600);
    let (_a, root) = vault();
    let server = r.servers.server("main", &root).unwrap();
    server.ensure_started().unwrap();
    let process = r.launcher.current();
    let began = Instant::now();
    r.servers.shutdown_window("main");
    assert!(
        began.elapsed() < Duration::from_millis(100),
        "the window closed in {:?}",
        began.elapsed()
    );
    assert!(!r.servers.has("main"));
    assert!(!stopped(&process), "still ending");
    wait_for("the process", 5, || stopped(&process));
    // a vault switch is as quick
    let (_b, two) = vault();
    let again = r.servers.server("main", &root).unwrap();
    again.ensure_started().unwrap();
    let began = Instant::now();
    r.servers.server("main", &two).unwrap();
    assert!(began.elapsed() < Duration::from_millis(100));
}

/// A19: OpenCode lists its MCP servers through its own server, never through a program's `mcp list`
/// command: the probe port is never touched, and the neutral state words come out.
#[test]
fn opencode_lists_its_mcp_servers_through_its_server_and_never_runs_a_cli_list() {
    use crate::agent::backend::HelperCtx;
    use crate::agent::config_sync::{McpProbe, ProbeTarget};
    use crate::agent::events::{McpServerStatus, McpState};
    struct NeverRun;
    impl McpProbe for NeverRun {
        fn probe(
            &self,
            _: &ProbeTarget,
            _: Duration,
            _: &Spawner,
        ) -> Result<Vec<McpServerStatus>, String> {
            panic!("OpenCode must not run a CLI list");
        }
    }
    let (_v, root) = vault();
    let r = rig();
    // the server's own answer, as recorded
    let all: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(super::events_tests::fixtures_dir().join("rest.json")).unwrap(),
    )
    .unwrap();
    *r.launcher.mcp_reply.lock() = Some(all["mcp"]["body"].clone());
    let (backend, _launcher, _keep) = backend_on(r);
    let spawner = Spawner::detached();
    let got = backend
        .ops()
        .mcp_list(
            &HelperCtx {
                spawner: &spawner,
                program: Path::new("opencode"),
                cwd: &root,
                label: "main",
                root: &root,
            },
            &NeverRun,
        )
        .expect("the server answers");
    assert!(got
        .iter()
        .any(|s| s.name == "writer" && s.status == McpState::Connected));
    assert!(got.iter().any(|s| s.status == McpState::NeedsAuth));
}

#[test]
fn the_title_call_uses_a_throwaway_session_on_the_cheap_model_and_removes_it() {
    use crate::agent::backend::HelperCtx;
    use crate::agent::title::{suggest, TitleMessage, TitleRole};
    let (_v, root) = vault();
    let (backend, launcher, _keep) = backend_on(rig());
    let spawner = Spawner::detached();
    let asker = backend
        .ops()
        .titler(&HelperCtx {
            spawner: &spawner,
            program: Path::new("opencode"),
            cwd: &root,
            label: "main",
            root: &root,
        })
        .expect("a server is up for the call");
    let messages = [
        TitleMessage {
            role: TitleRole::User,
            text: "Plan my week".into(),
        },
        TitleMessage {
            role: TitleRole::Assistant,
            text: "Here is a plan".into(),
        },
    ];
    let title = suggest(&*asker, Some("fake/cheap"), Some("fake/chat"), &messages);
    // the recorded reply of `generate` is a three word title
    assert_eq!(title.as_deref(), Some("OpenCode Spike Session"));
    let seen = requests(&launcher);
    let create = seen
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/api/session")
        .expect("a session was made");
    // on the cheap model, with every tool denied
    assert_eq!(create.2["model"]["providerID"], "fake");
    assert_eq!(create.2["model"]["id"], "cheap");
    assert_eq!(create.2["permissions"][0]["effect"], "deny");
    let generate = seen
        .iter()
        .position(|(_, p, _)| p.ends_with("/generate"))
        .unwrap();
    assert!(seen[generate].2["prompt"]
        .as_str()
        .unwrap()
        .contains("Plan my week"));
    // and it is gone again, whatever the answer was
    let delete = seen
        .iter()
        .position(|(m, p, _)| m == "DELETE" && p.starts_with("/api/session/ses_"))
        .expect("the throwaway session was deleted");
    assert!(delete > generate);
    // only one call: the first model answered, the chat's own was not tried
    assert_eq!(
        seen.iter()
            .filter(|(_, p, _)| p.ends_with("/generate"))
            .count(),
        1
    );
}

/// The title call on a server whose `generate` and `DELETE` answer as the test scripts.
fn title_with(
    handler: impl Fn(&super::fake_server_tests::Req) -> Option<(u16, serde_json::Value)>
        + Send
        + Sync
        + 'static,
) -> (Option<String>, Arc<FakeLauncher>, Vec<String>, Rig2) {
    use crate::agent::backend::HelperCtx;
    use crate::agent::title::{suggest, TitleMessage, TitleRole};
    let (_v, root) = vault();
    let r = rig();
    r.servers.ensure_up("main", &root).unwrap();
    *r.launcher.current().server.shared.handler.lock() = Some(Box::new(handler));
    let (backend, launcher, servers, keep) = backend_and_servers(r);
    let spawner = Spawner::detached();
    let asker = backend
        .ops()
        .titler(&HelperCtx {
            spawner: &spawner,
            program: Path::new("opencode"),
            cwd: &root,
            label: "main",
            root: &root,
        })
        .unwrap();
    let messages = [TitleMessage {
        role: TitleRole::User,
        text: "Plan my week".into(),
    }];
    let title = suggest(&*asker, Some("fake/cheap"), None, &messages);
    let owed = servers.owed(&root);
    (title, launcher, owed, keep)
}

#[test]
fn a_failed_generate_still_deletes_the_title_session() {
    let (title, launcher, owed, _keep) = title_with(|req| {
        req.path
            .ends_with("/generate")
            .then(|| (500, serde_json::json!({"_tag": "UnknownError"})))
    });
    assert_eq!(title, None);
    assert!(requests(&launcher)
        .iter()
        .any(|(m, p, _)| m == "DELETE" && p.starts_with("/api/session/ses_")));
    assert!(owed.is_empty(), "deleted: nothing owed");
}

#[test]
fn a_title_session_that_cannot_be_deleted_is_kept_to_be_deleted_at_the_next_start() {
    let (title, _launcher, owed, _keep) = title_with(|req| {
        (req.method == "DELETE").then(|| (500, serde_json::json!({"_tag": "UnknownError"})))
    });
    assert!(title.is_some(), "the title itself came");
    assert_eq!(owed.len(), 1, "{owed:?}");
    assert!(owed[0].starts_with("ses_"));
}

#[test]
fn a_title_session_does_not_count_as_a_running_turn_nor_hold_a_reload() {
    let r = rig();
    let (_v, root) = vault();
    let server = r.servers.ensure_up("main", &root).unwrap();
    let fake = r.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let started = |id: &str| {
        serde_json::json!({
            "id": "evt_fake", "created": 1, "type": "session.execution.started",
            "data": {"sessionID": id}
        })
        .to_string()
    };
    server.untrack("ses_title1");
    fake.emit(&started("ses_title1"));
    fake.emit(&started("ses_chat1"));
    wait_for("both events", 5, || server.dropped() == 2);
    assert_eq!(server.running_turns(), 1, "only the chat's turn runs");
}

#[test]
fn without_a_usable_model_there_is_no_title_call_at_all() {
    use crate::agent::title::{suggest, TitleMessage, TitleRole};
    let (_v, root) = vault();
    let r = rig();
    let server = r.servers.ensure_up("main", &root).unwrap();
    let launcher = Arc::clone(&r.launcher);
    let asker = super::driver::titler_for(server, root.clone(), std::sync::Arc::new(|_| {}));
    let messages = [TitleMessage {
        role: TitleRole::User,
        text: "hello there".into(),
    }];
    assert_eq!(suggest(&*asker, Some("haiku"), None, &messages), None);
    assert!(!requests(&launcher)
        .iter()
        .any(|(_, p, _)| p == "/api/session" || p.ends_with("/generate")));
}

// ---------------------------------------------------------------------------------------------
// the saved rules of the vault's project

/// A server that knows `projects` and answers every project's saved rules, whatever the query (a
/// test of Writer's own filter must not lean on the server's).
fn with_saved_rules(
    projects: serde_json::Value,
    root: &Path,
) -> (super::client::Client, Arc<FakeLauncher>, Rig) {
    let r = rig();
    let server = r.servers.ensure_up("main", root).unwrap();
    let fake = r.launcher.current().server.clone();
    *fake.shared.handler.lock() = Some(Box::new(move |req| {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api/project") => Some((200, projects.clone())),
            ("GET", "/api/permission/saved") => Some((
                200,
                serde_json::json!({"data": [
                    {"id": "psv_mine", "projectID": "prj_repo", "action": "shell", "resource": "ls *"},
                    {"id": "psv_foreign", "projectID": "prj_other", "action": "edit", "resource": "*"},
                ]}),
            )),
            _ => None,
        }
    }));
    let client = server.connection().unwrap().client;
    let launcher = Arc::clone(&r.launcher);
    (client, launcher, r)
}

fn two_projects(root: &Path) -> serde_json::Value {
    serde_json::json!({"data": [
        {"id": "prj_repo", "canonical": root, "sandboxes": []},
        {"id": "prj_other", "canonical": "/somewhere/else", "sandboxes": []},
    ]})
}

#[test]
fn the_saved_rules_are_the_vaults_projects_and_the_project_goes_in_the_query() {
    let (_v, root) = vault();
    let (client, launcher, _r) = with_saved_rules(two_projects(&root), &root);
    let got = rt(super::commands::vault_rules(client, root.clone())).unwrap();
    assert!(got.project_scoped);
    assert_eq!(
        got.rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["psv_mine"],
        "the other project's rule is not shown"
    );
    let asked = launcher
        .current()
        .server
        .shared
        .requests
        .lock()
        .iter()
        .any(|q| q.path == "/api/permission/saved" && q.query == "projectID=prj_repo");
    assert!(asked, "the project is asked for");
}

#[test]
fn the_project_the_server_names_for_the_vault_wins_over_a_folder_match() {
    let (_v, root) = vault();
    // the folders say prj_repo; the server, asked for the vault's location, says prj_other
    let (client, launcher, r) = with_saved_rules(two_projects(&root), &root);
    let fake = r.launcher.current().server.clone();
    let base = fake.shared.handler.lock().take().unwrap();
    *fake.shared.handler.lock() = Some(Box::new(move |req| {
        if req.path == "/api/location" {
            return Some((
                200,
                serde_json::json!({"directory": "/v", "project": {"id": "prj_other", "directory": "/v", "canonical": "/v"}}),
            ));
        }
        base(req)
    }));
    let got = rt(super::commands::vault_rules(client, root.clone())).unwrap();
    assert_eq!(
        got.rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["psv_foreign"]
    );
    let asked = launcher
        .current()
        .server
        .shared
        .requests
        .lock()
        .iter()
        .any(|q| {
            q.path == "/api/location"
                && (q.query.contains("location[directory]=")
                    || q.query.contains("location%5Bdirectory%5D="))
        });
    assert!(asked, "the location is asked for by its directory");
}

#[test]
fn a_catch_all_project_at_the_filesystem_root_is_no_project_of_the_vault() {
    let (_v, root) = vault();
    let projects = serde_json::json!({"data": [
        {"id": "prj_global", "canonical": "/", "sandboxes": []},
    ]});
    let (client, _launcher, _r) = with_saved_rules(projects, &root);
    let got = rt(super::commands::vault_rules(client, root)).unwrap();
    assert!(!got.project_scoped, "read-only, every project's");
    assert_eq!(got.rules.len(), 2);
}

#[test]
fn a_rule_of_another_project_is_refused_and_one_of_this_project_is_removed() {
    let (_v, root) = vault();
    let (client, launcher, _r) = with_saved_rules(two_projects(&root), &root);
    let err = rt(super::commands::remove_rule(
        client.clone(),
        root.clone(),
        "psv_foreign".into(),
    ))
    .unwrap_err();
    assert!(err.to_string().contains("not a saved rule of this project"));
    assert!(!requests(&launcher)
        .iter()
        .any(|(m, p, _)| m == "DELETE" && p.contains("psv_")));
    rt(super::commands::remove_rule(
        client,
        root,
        "psv_mine".into(),
    ))
    .unwrap();
    assert!(requests(&launcher)
        .iter()
        .any(|(m, p, _)| m == "DELETE" && p == "/api/permission/saved/psv_mine"));
}

#[test]
fn with_no_project_known_the_list_is_every_projects_and_nothing_can_be_removed() {
    let (_v, root) = vault();
    let (client, launcher, _r) = with_saved_rules(serde_json::json!({"data": []}), &root);
    let got = rt(super::commands::vault_rules(client.clone(), root.clone())).unwrap();
    assert!(!got.project_scoped);
    assert_eq!(got.rules.len(), 2);
    assert!(rt(super::commands::remove_rule(
        client,
        root,
        "psv_mine".into()
    ))
    .is_err());
    assert!(!requests(&launcher)
        .iter()
        .any(|(m, p, _)| m == "DELETE" && p.contains("psv_")));
}

/// Runs a future of the commands on a throwaway runtime.
fn rt<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

// ---------------------------------------------------------------------------------------------
// the version rule and where the program is searched

#[cfg(unix)]
#[test]
fn a_version_of_another_major_is_found_but_not_supported() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = |version: &str| {
        let p = dir.path().join(format!("opencode-{version}"));
        std::fs::write(&p, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    };
    let spawner = Spawner::detached();
    let detect =
        |version: &str| super::driver::detect(&spawner, Some(script(version).to_str().unwrap()));
    let new = detect("3.0.0");
    assert!(new.found);
    assert_eq!(new.version.as_deref(), Some("3.0.0"));
    assert_eq!(new.supported, Some(false));
    assert_eq!(
        new.min_version.as_deref(),
        Some(super::opencode_api::MIN_VERSION)
    );
    assert_eq!(detect("2.4.0").supported, Some(true));
    assert_eq!(
        detect("2.3.9").supported,
        Some(false),
        "older than the pinned one"
    );
    // not found: nothing to say about a version
    let missing = super::driver::detect(&spawner, Some("/nonexistent/opencode"));
    assert!(!missing.found);
    assert_eq!(missing.supported, None);
}

#[test]
fn the_servers_models_changing_is_told_to_whoever_listens() {
    let r = rig();
    let (_v, root) = vault();
    let server = r.servers.ensure_up("main", &root).unwrap();
    let told = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let count = Arc::clone(&told);
    server.on_models_changed(Box::new(move || {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    let fake = r.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.emit(
        &serde_json::json!({"id": "evt_fake", "created": 1, "type": "model.updated", "data": {}})
            .to_string(),
    );
    wait_for("the hook", 5, || {
        told.load(std::sync::atomic::Ordering::SeqCst) == 1
    });
}

// ---------------------------------------------------------------------------------------------
// The MCP menu and the provider tabs over the user's own config (ADR 2026-11-24)

/// The window's settings with these global lists set (what Settings wrote).
fn set_lists(r: &Rig, lists: &[(&str, &[&str])]) -> tempfile::TempDir {
    let (dir, mut s) = settings(None);
    for (key, values) in lists {
        s.set_global(
            key,
            ConfigValue::List(values.iter().map(|v| v.to_string()).collect()),
        )
        .unwrap();
    }
    *r.app
        .state::<AppState>()
        .get_or_create("main")
        .settings
        .write() = Some(s);
    dir
}

fn user_config(servers: serde_json::Value) -> serde_json::Value {
    serde_json::json!([{"type": "file", "path": "/never/read", "info": {"mcp": {"servers": servers}}}])
}

/// The menu lists what the server runs and the servers its deny-all policies hold off, which the
/// server does not list: those are `disabled` rows, and the switches come from the setting.
#[test]
fn the_mcp_list_holds_the_servers_the_policies_keep_off_as_disabled_rows() {
    use crate::agent::backend::HelperCtx;
    use crate::agent::config_sync::{McpProbe, ProbeTarget};
    use crate::agent::events::{McpServerStatus, McpState};
    struct NeverRun;
    impl McpProbe for NeverRun {
        fn probe(
            &self,
            _: &ProbeTarget,
            _: Duration,
            _: &Spawner,
        ) -> Result<Vec<McpServerStatus>, String> {
            panic!("OpenCode must not run a CLI list");
        }
    }
    let (_v, root) = vault();
    let r = rig();
    let _settings = set_lists(&r, &[("agent.opencode.enabled-mcp-servers", &["g-a"])]);
    *r.launcher.config_reply.lock() = Some(user_config(serde_json::json!({"g-a": {}, "g-b": {}})));
    *r.launcher.mcp_reply.lock() = Some(serde_json::json!({"data": [
        {"name": "writer", "status": {"status": "connected"}},
        {"name": "g-a", "status": {"status": "connected"}},
    ]}));
    let (backend, launcher, servers, _keep) = backend_and_servers(r);
    let spawner = Spawner::detached();
    let ctx = HelperCtx {
        spawner: &spawner,
        program: Path::new("opencode"),
        cwd: &root,
        label: "main",
        root: &root,
    };
    let got = backend
        .ops()
        .mcp_list(&ctx, &NeverRun)
        .expect("the server answers");
    let rows: Vec<(String, McpState)> = got.into_iter().map(|s| (s.name, s.status)).collect();
    assert_eq!(
        rows,
        [
            ("writer".to_string(), McpState::Connected),
            ("g-a".to_string(), McpState::Connected),
            ("g-b".to_string(), McpState::Disabled),
        ]
    );
    // the switch is on for g-a only: the file holds its allow and g-b's placeholder
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(servers_file(&launcher)).unwrap()).unwrap();
    let allows: Vec<_> = doc["policies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["effect"] == "allow")
        .map(|p| p["resource"].as_str().unwrap())
        .collect();
    assert_eq!(allows, ["writer", "g-a"]);
    assert_eq!(doc["mcp"]["servers"]["g-b"]["disabled"], true);
    assert_eq!(
        servers.global_config("main"),
        Some(super::server::GlobalConfig::Loaded)
    );
    assert_eq!(servers.global_config("other"), None);
}

/// The config file the first launch was given (`OPENCODE_CONFIG`).
fn servers_file(launcher: &FakeLauncher) -> String {
    launcher.specs.lock()[0]
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG")
        .map(|(_, v)| v.clone())
        .unwrap()
}

/// A switch written in Settings: `mcp_apply` renders the file again and the server reads it again.
#[test]
fn applying_a_switch_renders_the_config_again_and_reloads_once() {
    use crate::agent::backend::HelperCtx;
    let (_v, root) = vault();
    let r = rig();
    let _settings = set_lists(&r, &[]);
    *r.launcher.config_reply.lock() = Some(user_config(serde_json::json!({"g-a": {}})));
    let (backend, launcher, servers, _keep) = backend_and_servers(r);
    // no server yet: nothing to apply, nothing is started for it
    servers.reapply("main").unwrap();
    assert_eq!(launcher.launches(), 0);
    servers.ensure_up("main", &root).unwrap();
    let fake = launcher.current().server.clone();
    let reloads = || fake.find("POST", "/api/location/reload").len();
    let before = reloads();
    // the user switches g-a on
    *servers
        .app()
        .state::<AppState>()
        .get_or_create("main")
        .settings
        .write() = Some({
        let (_d, mut s) = settings(None);
        s.set_global(
            "agent.opencode.enabled-mcp-servers",
            ConfigValue::List(vec!["g-a".into()]),
        )
        .unwrap();
        std::mem::forget(_d);
        s
    });
    let spawner = Spawner::detached();
    backend
        .ops()
        .mcp_apply(&HelperCtx {
            spawner: &spawner,
            program: Path::new("opencode"),
            cwd: &root,
            label: "main",
            root: &root,
        })
        .unwrap();
    assert_eq!(reloads(), before + 1);
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(servers_file(&launcher)).unwrap()).unwrap();
    assert!(doc["policies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["resource"] == "g-a" && p["effect"] == "allow"));
    assert!(
        doc["mcp"]["servers"].get("g-a").is_none(),
        "no placeholder for a server that is on"
    );
    // the same again changes nothing
    servers.reapply("main").unwrap();
    assert_eq!(reloads(), before + 1);
}

/// The provider tabs are the server's providers together with the ones switched off, which the
/// server stops listing; names only, never a provider's headers.
#[test]
fn the_provider_tabs_keep_a_switched_off_provider_the_server_no_longer_lists() {
    let (_v, root) = vault();
    let r = rig();
    let _settings = set_lists(&r, &[("agent.opencode.disabled-providers", &["fake-b"])]);
    let servers = Arc::new(r.servers);
    let _keep = (r.app, r.data);
    servers.ensure_up("main", &root).unwrap();
    *r.launcher.current().server.shared.handler.lock() =
        Some(Box::new(|q: &super::fake_server_tests::Req| {
            (q.method == "GET" && q.path == "/api/provider").then(|| {
                (
                    200,
                    serde_json::json!({"data": [
                        {"id": "fake-a", "name": "Fake A", "headers": {"authorization": "secret"}},
                    ]}),
                )
            })
        }));
    let rows = servers.providers("main", &root).unwrap();
    let got: Vec<(&str, &str, bool)> = rows
        .iter()
        .map(|r| (r.id.as_str(), r.name.as_str(), r.off))
        .collect();
    assert_eq!(
        got,
        [("fake-a", "Fake A", false), ("fake-b", "fake-b", true)]
    );
    assert!(!format!("{rows:?}").contains("secret"));
}

/// The provider switch is in the file the server loads.
#[test]
fn a_provider_switch_is_a_policy_in_the_file() {
    let (_v, root) = vault();
    let r = rig();
    let _settings = set_lists(&r, &[("agent.opencode.disabled-providers", &["fake-b"])]);
    r.servers.ensure_up("main", &root).unwrap();
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(servers_file(&r.launcher)).unwrap()).unwrap();
    assert!(doc["policies"].as_array().unwrap().iter().any(|p| {
        p["action"] == "provider.use" && p["resource"] == "fake-b" && p["effect"] == "deny"
    }));
}
