//! The server owner against the fake OpenCode: the environment, the version check, the fan-out of
//! events to the chat that owns each session, and a crash and restart.

use super::client::{Endpoint, Io};
use super::fake_server_tests::*;
use super::opencode_api as api;
use super::server::*;
use crate::features::scope::Spawner;
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(super) struct Harness {
    pub server: Arc<OpencodeServer>,
    pub launcher: Arc<FakeLauncher>,
    pub dir: tempfile::TempDir,
}

pub(super) fn harness(version: &str) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let spawner = Spawner::detached();
    let io = Io::start(&spawner).unwrap();
    let launcher = FakeLauncher::new(version);
    let settings = ServerSettings {
        program: "opencode".into(),
        root: dir.path().to_path_buf(),
        config_file: dir.path().join("opencode/opencode.json"),
        config_home: dir.path().join("opencode/xdg-config"),
        shell_wrapper: dir.path().join("opencode/writer-shell"),
        app_data: dir.path().to_path_buf(),
    };
    let inherited: Box<dyn Fn() -> Vec<(String, String)> + Send + Sync> = Box::new(|| {
        vec![
            ("HOME".into(), "/home/fake".into()),
            ("PATH".into(), "/usr/bin".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), "{\"fake\":true}".into()),
            ("OPENCODE_SERVER_PASSWORD".into(), "inherited".into()),
            ("XDG_CONFIG_HOME".into(), "/home/fake/.config".into()),
        ]
    });
    let server = OpencodeServer::new(io, launcher.clone(), settings, inherited);
    Harness {
        server,
        launcher,
        dir,
    }
}

type Seen = Arc<Mutex<Vec<ChatInput>>>;

fn collect(server: &OpencodeServer) -> (u64, Seen) {
    let seen: Seen = Arc::default();
    let s = Arc::clone(&seen);
    let key = server.register(Arc::new(move |i| s.lock().push(i)));
    (key, seen)
}

fn kinds(seen: &Seen) -> Vec<String> {
    seen.lock()
        .iter()
        .map(|i| match i {
            ChatInput::Event(e) => e.kind.clone(),
            ChatInput::Resync => "resync".into(),
            ChatInput::Reloaded => "reloaded".into(),
            ChatInput::Down(_) => "down".into(),
        })
        .collect()
}

fn ev(kind: &str, data: serde_json::Value) -> String {
    json!({"id": "evt_fake", "created": 1, "type": kind, "data": data}).to_string()
}

#[test]
fn the_environment_drops_every_inherited_opencode_variable_and_keeps_the_home() {
    let s = ServerSettings {
        program: "opencode".into(),
        root: "/v".into(),
        config_file: "/w/opencode.json".into(),
        config_home: "/w/opencode/xdg-config".into(),
        shell_wrapper: "/w/opencode/writer-shell".into(),
        app_data: "/w".into(),
    };
    let env = isolated_env(
        [
            ("HOME", "/home/fake"),
            ("PATH", "/usr/bin"),
            ("OPENCODE_CONFIG_CONTENT", "{}"),
            ("OPENCODE_SERVER_PASSWORD", "old"),
            ("XDG_CONFIG_HOME", "/home/fake/.config"),
            ("SHELL", "/bin/fish"),
            ("WRITER_USER_SHELL", "/tmp/spoofed"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string())),
        "pw",
        &s,
    );
    let get = |k: &str| -> Vec<&str> {
        env.iter()
            .filter(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
            .collect()
    };
    assert_eq!(get("HOME"), ["/home/fake"]);
    assert_eq!(get("PATH"), ["/usr/bin"]);
    assert!(get("OPENCODE_CONFIG_CONTENT").is_empty());
    assert_eq!(get("OPENCODE_SERVER_PASSWORD"), ["pw"]);
    assert_eq!(get("OPENCODE_CONFIG"), ["/w/opencode.json"]);
    assert_eq!(get("OPENCODE_DISABLE_PROJECT_CONFIG"), ["1"]);
    assert_eq!(get("OPENCODE_DISABLE_CLAUDE_CODE"), ["1"]);
    assert_eq!(get("OPENCODE_DISABLE_AUTOUPDATE"), ["1"]);
    assert_eq!(get("XDG_CONFIG_HOME"), ["/w/opencode/xdg-config"]);
    // the shell the user had goes to the wrapper, which is the server's `SHELL`; nothing spoofs it
    assert_eq!(get("SHELL"), ["/w/opencode/writer-shell"]);
    assert_eq!(get("WRITER_USER_SHELL"), ["/bin/fish"]);
    assert_eq!(get("WRITER_USER_XDG_CONFIG_HOME"), ["/home/fake/.config"]);
}

fn settings_in(dir: &std::path::Path) -> ServerSettings {
    ServerSettings {
        program: "opencode".into(),
        root: dir.to_path_buf(),
        config_file: dir.join("opencode/vault.json"),
        config_home: dir.join("opencode/xdg-config"),
        shell_wrapper: dir.join("opencode/writer-shell"),
        app_data: dir.to_path_buf(),
    }
}

/// The names the wrapper unsets are exactly the ones the environment sets for the server (and
/// the one name OpenCode reads before its password variable): one list, two uses.
#[test]
fn the_wrapper_unsets_what_the_environment_sets_and_nothing_else() {
    let env = isolated_env(Vec::new(), "pw", &settings_in(std::path::Path::new("/w")));
    let mut set: Vec<&str> = env
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| k.starts_with("OPENCODE_") || *k == "XDG_CONFIG_HOME")
        .collect();
    set.push("OPENCODE_PASSWORD");
    set.sort();
    let text = shell_wrapper();
    let unset_line = text
        .lines()
        .find(|l| l.starts_with("unset OPENCODE"))
        .unwrap();
    let mut unset: Vec<&str> = unset_line.split_whitespace().skip(1).collect();
    unset.sort();
    assert_eq!(set, unset);
    // it ends by running the shell the user had, with the arguments it was given
    assert!(text.ends_with("exec \"$SHELL\" \"$@\"\n"));
    assert!(text.starts_with("#!/bin/sh\n"));
}

/// Runs the wrapper for real: the command the agent's shell would run sees none of the server's
/// settings, the user's own shell and config home are back, and the arguments reach the shell.
#[cfg(unix)]
#[test]
fn the_wrapper_hides_the_servers_settings_from_the_commands_it_runs() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("writer-shell");
    std::fs::write(&path, shell_wrapper()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let s = settings_in(std::path::Path::new("/w"));
    let env = isolated_env(
        [
            ("PATH", "/usr/bin:/bin"),
            ("SHELL", "/bin/sh"),
            ("XDG_CONFIG_HOME", "/home/fake/.config"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string())),
        "the-password",
        &s,
    );
    let run = |env: &[(String, String)]| {
        let out = std::process::Command::new(&path)
            .args(["-c", "env"])
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    };
    let seen = run(&env);
    for name in ["OPENCODE_", "WRITER_USER_", "the-password", "/w/opencode"] {
        assert!(!seen.contains(name), "the shell sees {name}");
    }
    assert!(
        seen.contains("XDG_CONFIG_HOME=/home/fake/.config"),
        "{seen}"
    );
    assert!(seen.contains("SHELL=/bin/sh"), "{seen}");
    // a user with no `XDG_CONFIG_HOME` of their own has none, and a missing shell is `sh`
    let env: Vec<_> = isolated_env(
        [("PATH", "/usr/bin:/bin")].map(|(k, v)| (k.to_string(), v.to_string())),
        "pw",
        &s,
    );
    let seen = run(&env);
    assert!(!seen.contains("XDG_CONFIG_HOME"), "{seen}");
    assert!(seen.contains("SHELL=/bin/sh"), "{seen}");
}

#[cfg(unix)]
#[test]
fn a_start_writes_the_wrapper_executable_and_hands_it_to_the_server_as_its_shell() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    let wrapper = h.dir.path().join("opencode/writer-shell");
    assert_eq!(std::fs::read_to_string(&wrapper).unwrap(), shell_wrapper());
    assert_eq!(
        std::fs::metadata(&wrapper).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let spec = h.launcher.specs.lock()[0].clone();
    assert!(spec
        .env
        .iter()
        .any(|(k, v)| k == "SHELL" && *v == wrapper.to_string_lossy()));
    h.server.shutdown();
}

#[test]
fn a_wrapper_path_that_is_not_writers_own_is_never_written() {
    let mut h = harness("2.4.0");
    let other = h.dir.path().join("somebodys-shell");
    let spawner = Spawner::detached();
    let io = Io::start(&spawner).unwrap();
    let mut settings = settings_in(h.dir.path());
    settings.shell_wrapper = other.clone();
    assert!(!settings.shell_wrapper_is_ours());
    h.server = OpencodeServer::new(io, h.launcher.clone(), settings, Box::new(Vec::new));
    assert!(matches!(
        h.server.ensure_started(),
        Err(ServerError::Failed(_))
    ));
    assert!(!other.exists());
    assert_eq!(h.launcher.launches(), 0);
}

#[cfg(unix)]
#[test]
fn the_config_is_written_private_once_and_a_change_reloads_a_running_server_once() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness("2.4.0");
    let file = h.dir.path().join("opencode/opencode.json");
    // before any server: written, nothing to reload
    h.server.apply_config("{\"a\":1}\n").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}\n");
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    assert!(fake.find("POST", "/api/location/reload").is_empty());
    // the same text again: nothing is written, nothing reloads
    std::fs::write(&file, "touched").unwrap();
    h.server.apply_config("{\"a\":1}\n").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "touched");
    assert!(fake.find("POST", "/api/location/reload").is_empty());
    // a change: written and the running server reads it again, once
    h.server.apply_config("{\"a\":2}\n").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":2}\n");
    assert_eq!(fake.find("POST", "/api/location/reload").len(), 1);
    h.server.apply_config("{\"a\":2}\n").unwrap();
    assert_eq!(fake.find("POST", "/api/location/reload").len(), 1);
    h.server.shutdown();
}

#[test]
fn the_ready_line_and_the_versions_are_read_strictly() {
    assert_eq!(
        listening_url("server listening on http://127.0.0.1:4242"),
        Some(Listening::Loopback("http://127.0.0.1:4242".into()))
    );
    assert_eq!(listening_url("starting"), None);
    // anything but the host 127.0.0.1 is refused, tricks of the URL grammar included
    for bad in [
        "https://elsewhere",
        "http://evil.example:4242",
        "http://127.0.0.1.evil.example:4242",
        "http://127.0.0.1:4242@evil.example",
        "http://127.0.0.1:80@evil.example:80",
        "http://127.0.0.1:4242/path",
        "http://127.0.0.1:",
        "http://127.0.0.1:99999",
        "http://127.0.0.1:0",
        "http://localhost:4242",
        "http://[::1]:4242",
        "http://0.0.0.0:4242",
        "",
    ] {
        assert_eq!(
            listening_url(&format!("server listening on {bad}")),
            Some(Listening::Elsewhere),
            "{bad}"
        );
    }
    for ok in ["2.4.0", "2.4.1", "2.10.0", "v2.4.0", "2.4.0-beta.1"] {
        assert!(version_ok(ok), "{ok}");
    }
    for bad in ["2.3.9", "1.99.0", "3.0.0", "3.1.0", "", "dev", "2"] {
        assert!(!version_ok(bad), "{bad}");
    }
}

#[test]
fn a_server_that_was_never_asked_for_starts_no_process() {
    let h = harness("2.4.0");
    let (_, _seen) = collect(&h.server);
    assert_eq!(h.launcher.launches(), 0);
    assert_eq!(h.server.starts(), 0);
    assert!(h.server.connection().is_none());
}

#[test]
fn the_server_starts_once_with_the_isolated_environment_and_a_fresh_config_home() {
    let h = harness("2.4.0");
    std::fs::create_dir_all(h.dir.path().join("opencode/xdg-config")).unwrap();
    std::fs::write(h.dir.path().join("opencode/xdg-config/stale"), "x").unwrap();
    let a = h.server.ensure_started().unwrap();
    let b = h.server.ensure_started().unwrap();
    assert_eq!(a.epoch, b.epoch);
    assert_eq!(a.version, "2.4.0");
    assert_eq!(h.launcher.launches(), 1);
    assert!(
        !h.dir.path().join("xdg/stale").exists(),
        "the config home is recreated empty"
    );
    let spec = h.launcher.specs.lock()[0].clone();
    assert!(spec.env.iter().all(|(k, _)| k != "OPENCODE_CONFIG_CONTENT"));
    assert!(spec
        .env
        .iter()
        .any(|(k, v)| k == "OPENCODE_SERVER_PASSWORD" && *v == spec.password));
    assert!(spec.password.len() >= 32);
    // the fake saw the stream open
    wait_for("the event stream", 5, || {
        h.launcher.current().server.streams() == 1
    });
    h.server.shutdown();
}

#[test]
fn a_version_older_than_the_pinned_one_is_refused_and_its_process_stopped() {
    let h = harness("2.3.9");
    let err = h.server.ensure_started().err().unwrap();
    assert_eq!(err, ServerError::Unsupported("2.3.9".into()));
    assert!(
        h.launcher.current().exited().is_some(),
        "the refused process is stopped"
    );
    assert!(h.server.connection().is_none());
    h.server.shutdown();
}

#[test]
fn a_missing_program_is_not_found() {
    let h = harness("2.4.0");
    *h.launcher.fail.lock() = Some(LaunchError::NotFound);
    assert_eq!(h.server.ensure_started().err(), Some(ServerError::NotFound));
    h.server.shutdown();
}

#[test]
fn a_request_without_the_password_is_unauthorized() {
    let h = harness("2.4.0");
    let conn = h.server.ensure_started().unwrap();
    let port = h.launcher.current().server.port;
    let bad = h.server.io().client(Endpoint::without_password(&format!(
        "http://127.0.0.1:{port}"
    )));
    let c = bad.clone();
    let r = h
        .server
        .io()
        .call(
            async move { c.get(&api::INFO, &[]).await },
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(r.unwrap_err().is_unauthorized());
    // and with it: the same call works
    let c = conn.client.clone();
    let ok = h
        .server
        .io()
        .call(
            async move { c.get(&api::INFO, &[]).await },
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(ok.unwrap()["version"], "2.4.0");
    h.server.shutdown();
}

#[test]
fn events_go_to_the_chat_that_owns_their_session_and_children_follow_their_parent() {
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let (a, seen_a) = collect(&h.server);
    let (b, seen_b) = collect(&h.server);
    h.server.own(a, "ses_a");
    h.server.own(b, "ses_b");
    fake.emit(&ev("session.text.delta", json!({"sessionID": "ses_a"})));
    fake.emit(&ev("session.text.delta", json!({"sessionID": "ses_b"})));
    // a child of a, then a grandchild, each owned by a from their creation on
    fake.emit(&ev(
        "session.created",
        json!({"sessionID": "ses_a1", "parentID": "ses_a"}),
    ));
    fake.emit(&ev(
        "session.created",
        json!({"sessionID": "ses_a2", "parentID": "ses_a1"}),
    ));
    fake.emit(&ev("session.text.delta", json!({"sessionID": "ses_a2"})));
    // nobody owns this one
    fake.emit(&ev(
        "session.text.delta",
        json!({"sessionID": "ses_stranger"}),
    ));
    // a server-wide event names no session
    fake.emit(&ev("model.updated", json!({})));
    wait_for("the fan-out", 5, || {
        kinds(&seen_a).len() == 5 && h.server.dropped() == 1
    });
    // `model.updated` is the one server-wide event the chats are told (they read the models again)
    assert_eq!(kinds(&seen_b), ["session.text.delta", "model.updated"]);
    assert!(h.server.owns(a, "ses_a2") && !h.server.owns(b, "ses_a2"));
    h.server.release(a);
    assert!(!h.server.owns(a, "ses_a1"));
    h.server.shutdown();
}

#[test]
fn a_dropped_stream_reconnects_and_every_chat_resyncs() {
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    let (_, seen) = collect(&h.server);
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.drop_streams();
    wait_for("the reconnect", 5, || fake.streams() == 2);
    wait_for("the resync", 5, || {
        kinds(&seen).contains(&"resync".to_string())
    });
    assert_eq!(h.launcher.launches(), 1, "the process was not restarted");
    h.server.shutdown();
}

#[test]
fn a_crash_tells_every_chat_once_and_the_next_start_is_a_new_process() {
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    let first = h.launcher.current();
    let (_, seen) = collect(&h.server);
    wait_for("the stream", 5, || first.server.streams() == 1);
    first.crash(9);
    wait_for("the down", 5, || kinds(&seen).contains(&"down".to_string()));
    // a marker event after the crash would go through the same sink: the stream is gone, so ask
    // the server directly whether it is still considered up, then count
    assert!(h.server.connection().is_none());
    assert_eq!(
        kinds(&seen).iter().filter(|k| *k == "down").count(),
        1,
        "once"
    );
    assert!(h.server.connection().is_none());
    let again = h.server.ensure_started().unwrap();
    assert_eq!(h.launcher.launches(), 2);
    assert_eq!(h.server.starts(), 2);
    assert!(again.epoch > 1);
    let pw: Vec<String> = h
        .launcher
        .specs
        .lock()
        .iter()
        .map(|s| s.password.clone())
        .collect();
    assert_ne!(pw[0], pw[1], "a new password per process");
    h.server.shutdown();
}

#[test]
fn shutdown_stops_the_process_and_refuses_a_start() {
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    h.server.shutdown();
    assert!(h.launcher.current().exited().is_some());
    assert!(h.server.ensure_started().is_err());
}

#[cfg(unix)]
#[test]
fn the_real_launcher_runs_a_program_reads_its_ready_line_and_stops_its_group() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake-opencode");
    let out = dir.path().join("env.txt");
    // prints its environment and its arguments, then the ready line with a port of its own
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nenv > '{}'\necho \"$@\" >> '{}'\necho \"server listening on http://127.0.0.1:41234\"\nexec sleep 60\n",
            out.display(),
            out.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launcher = ProcessLauncher {
        spawner: Spawner::detached(),
    };
    let spec = LaunchSpec {
        program: script,
        root: dir.path().to_path_buf(),
        env: vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("OPENCODE_SERVER_PASSWORD".into(), "pw".into()),
            ("ONLY_THIS".into(), "1".into()),
        ],
        password: "pw".into(),
    };
    let p = launcher.launch(&spec).unwrap();
    // the URL is the one the ready line named, and the process was asked for port 0
    assert_eq!(p.endpoint().base, "http://127.0.0.1:41234");
    let env = std::fs::read_to_string(&out).unwrap();
    assert!(env.contains("serve --hostname 127.0.0.1 --port 0"), "{env}");
    assert!(env.contains("ONLY_THIS=1") && env.contains("OPENCODE_SERVER_PASSWORD=pw"));
    assert!(!env.contains("USER="), "nothing is inherited: {env}");
    assert!(p.exited().is_none());
    p.stop();
    assert!(p.exited().is_some());
}

#[cfg(unix)]
#[test]
fn a_program_that_exits_before_it_listens_is_a_failed_start() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("dies");
    std::fs::write(&script, "#!/bin/sh\nexit 3\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launcher = ProcessLauncher {
        spawner: Spawner::detached(),
    };
    let spec = LaunchSpec {
        program: script,
        root: dir.path().to_path_buf(),
        env: vec![],
        password: "pw".into(),
    };
    assert!(matches!(
        launcher.launch(&spec),
        Err(LaunchError::Failed(_))
    ));
    let missing = LaunchSpec {
        program: dir.path().join("nope"),
        ..spec
    };
    assert_eq!(launcher.launch(&missing).err(), Some(LaunchError::NotFound));
}

#[cfg(unix)]
#[test]
fn a_ready_line_naming_another_host_is_a_failed_start_and_the_process_is_stopped() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("elsewhere");
    let pid_file = dir.path().join("pid");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho $$ > '{}'\necho \"server listening on http://127.0.0.1:80@evil.example:80\"\nexec sleep 60\n",
            pid_file.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launcher = ProcessLauncher {
        spawner: Spawner::detached(),
    };
    let spec = LaunchSpec {
        program: script,
        root: dir.path().to_path_buf(),
        env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        password: "pw".into(),
    };
    // fails at once (no request was possible: there is no endpoint to send one to)
    let t = Instant::now();
    assert_eq!(
        launcher.launch(&spec).err(),
        Some(LaunchError::Failed("OpenCode listens elsewhere".into()))
    );
    assert!(t.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_config_home_that_is_not_writers_own_is_never_deleted() {
    let mut h = harness("2.4.0");
    let other = h.dir.path().join("somebody-elses-folder");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("keep.txt"), "mine").unwrap();
    // a server built over a config home outside `<app data>/opencode/xdg-config`
    let spawner = Spawner::detached();
    let io = Io::start(&spawner).unwrap();
    let settings = ServerSettings {
        program: "opencode".into(),
        root: h.dir.path().to_path_buf(),
        config_file: h.dir.path().join("opencode/opencode.json"),
        config_home: other.clone(),
        shell_wrapper: h.dir.path().join("opencode/writer-shell"),
        app_data: h.dir.path().to_path_buf(),
    };
    assert!(!settings.config_home_is_ours());
    h.server = OpencodeServer::new(io, h.launcher.clone(), settings, Box::new(Vec::new));
    assert!(matches!(
        h.server.ensure_started(),
        Err(ServerError::Failed(_))
    ));
    assert!(other.join("keep.txt").exists());
    assert_eq!(h.launcher.launches(), 0, "no process was started either");
}

#[cfg(unix)]
fn script(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-opencode");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn the_endpoint_is_the_one_the_ready_line_names_and_only_loopback_is_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = ProcessLauncher {
        spawner: Spawner::detached(),
    };
    let spec = |program| LaunchSpec {
        program,
        root: dir.path().to_path_buf(),
        env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        password: "pw".into(),
    };
    let p = launcher
        .launch(&spec(script(
            dir.path(),
            "echo 'server listening on http://127.0.0.1:41999'\nexec sleep 60",
        )))
        .unwrap();
    assert_eq!(p.endpoint().base, "http://127.0.0.1:41999");
    p.stop();
    let err = launcher
        .launch(&spec(script(
            dir.path(),
            "echo 'server listening on http://203.0.113.9:80'\nexec sleep 60",
        )))
        .err();
    assert!(matches!(err, Some(LaunchError::Failed(_))));
}

fn exec_event(kind: &str, session: &str) -> String {
    ev(kind, json!({"sessionID": session}))
}

/// Another chat's turn is running: the config is written at once, the server reads it when the
/// last turn ends and not before, every chat is told once, and a reload nobody waits for is
/// never made.
#[test]
fn a_changed_config_is_read_when_the_last_running_turn_ends_and_every_chat_is_told_once() {
    let h = harness("2.4.0");
    let (_, seen) = collect(&h.server);
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let reloads = || fake.find("POST", "/api/location/reload").len();
    h.server.apply_config("{\"v\":1}\n").unwrap();
    assert_eq!(reloads(), 1, "nothing runs: read at once");
    fake.emit(&exec_event("session.execution.started", "ses_a"));
    fake.emit(&exec_event("session.execution.started", "ses_b"));
    wait_for("the events", 5, || h.server.dropped() == 2);
    h.server.apply_config("{\"v\":2}\n").unwrap();
    let file = h.dir.path().join("opencode/opencode.json");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"v\":2}\n");
    assert_eq!(reloads(), 1, "written, but a turn is running");
    fake.emit(&exec_event("session.execution.succeeded", "ses_a"));
    fake.emit(&exec_event("session.execution.interrupted", "ses_x"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(reloads(), 1, "one turn is still running");
    fake.emit(&exec_event("session.execution.failed", "ses_b"));
    wait_for("the reload", 5, || reloads() == 2);
    wait_for("the chats told", 5, || {
        kinds(&seen).iter().filter(|k| *k == "reloaded").count() == 2
    });
    // idle again: a turn that ends changes nothing
    fake.emit(&exec_event("session.execution.succeeded", "ses_a"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(reloads(), 2);
    h.server.shutdown();
}

/// The end of a turn went by while the stream was down: after the reconnect the gate counts the
/// turns the server says run, so the next config change is read at once, once.
#[test]
fn a_turn_that_ended_unseen_does_not_hold_the_reload_gate() {
    let h = harness("2.4.0");
    let (_, seen) = collect(&h.server);
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let reloads = || fake.find("POST", "/api/location/reload").len();
    fake.emit(&exec_event("session.execution.started", "ses_a"));
    wait_for("the event", 5, || h.server.dropped() == 1);
    // the stream drops, the turn ends where nobody sees it (the server lists no active session)
    fake.shared.active.lock().clear();
    fake.drop_streams();
    wait_for("the reconnect", 5, || fake.streams() == 2);
    wait_for("the resync", 5, || {
        kinds(&seen).contains(&"resync".to_string())
    });
    h.server.apply_config("{\"v\":1}\n").unwrap();
    assert_eq!(reloads(), 1, "nothing runs any more: read at once, once");
    // a turn that still runs after the reconnect is still waited for
    fake.shared.active.lock().push("ses_b".into());
    fake.drop_streams();
    wait_for("the second reconnect", 5, || fake.streams() == 3);
    wait_for("the second resync", 5, || {
        kinds(&seen).iter().filter(|k| *k == "resync").count() == 2
    });
    h.server.apply_config("{\"v\":2}\n").unwrap();
    assert_eq!(reloads(), 1, "ses_b runs");
    fake.emit(&exec_event("session.execution.succeeded", "ses_b"));
    wait_for("the reload", 5, || reloads() == 2);
    h.server.shutdown();
}

/// A reload that waited for a turn whose end went unseen is made when the reconnect finds the
/// server idle.
#[test]
fn a_waiting_reload_is_made_when_the_reconnect_finds_nothing_running() {
    let h = harness("2.4.0");
    let (_, seen) = collect(&h.server);
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let reloads = || fake.find("POST", "/api/location/reload").len();
    fake.emit(&exec_event("session.execution.started", "ses_a"));
    wait_for("the event", 5, || h.server.dropped() == 1);
    h.server.apply_config("{\"v\":1}\n").unwrap();
    assert_eq!(reloads(), 0, "a turn is running");
    fake.drop_streams();
    wait_for("the reconnect", 5, || fake.streams() == 2);
    wait_for("the reload", 5, || reloads() == 1);
    wait_for("the chats told", 5, || {
        kinds(&seen).contains(&"reloaded".to_string())
    });
    h.server.shutdown();
}

/// A chat that goes away takes its running turns, its children's included, out of the count.
#[test]
fn a_released_chat_no_longer_holds_the_reload_gate() {
    let h = harness("2.4.0");
    let (key, seen) = collect(&h.server);
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let reloads = || fake.find("POST", "/api/location/reload").len();
    h.server.own(key, "ses_a");
    h.server.own(key, "ses_child");
    fake.emit(&exec_event("session.execution.started", "ses_a"));
    fake.emit(&exec_event("session.execution.started", "ses_child"));
    wait_for("the events", 5, || {
        kinds(&seen)
            .iter()
            .filter(|k| *k == "session.execution.started")
            .count()
            == 2
    });
    h.server.apply_config("{\"v\":1}\n").unwrap();
    assert_eq!(reloads(), 0, "turns are running");
    h.server.release(key);
    wait_for("the reload", 5, || reloads() == 1);
    h.server.shutdown();
}

/// An end event that never comes cannot hold the configuration for ever: past the deadline it
/// is read anyway, once, and a late end changes nothing.
#[test]
fn a_reload_that_waited_too_long_is_made_anyway_once() {
    let h = harness("2.4.0");
    h.server.ensure_started().unwrap();
    let fake = h.launcher.current().server.clone();
    wait_for("the stream", 5, || fake.streams() == 1);
    let reloads = || fake.find("POST", "/api/location/reload").len();
    h.server.set_reload_deadline(Duration::from_millis(150));
    fake.emit(&exec_event("session.execution.started", "ses_a"));
    wait_for("the event", 5, || h.server.dropped() == 1);
    h.server.apply_config("{\"v\":1}\n").unwrap();
    h.server.apply_config("{\"v\":2}\n").unwrap();
    assert_eq!(reloads(), 0);
    wait_for("the reload past the deadline", 5, || reloads() == 1);
    fake.emit(&exec_event("session.execution.succeeded", "ses_a"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(reloads(), 1, "once");
    h.server.shutdown();
}

#[test]
fn a_config_path_that_is_not_writers_own_is_never_written() {
    let mut h = harness("2.4.0");
    let spawner = Spawner::detached();
    let io = Io::start(&spawner).unwrap();
    let mut settings = settings_in(h.dir.path());
    settings.config_file = h.dir.path().join("elsewhere.json");
    assert!(!settings.config_file_is_ours());
    settings.config_file = h.dir.path().join("opencode/not-json.txt");
    assert!(!settings.config_file_is_ours());
    settings.config_file = h.dir.path().join("elsewhere.json");
    h.server = OpencodeServer::new(io, h.launcher.clone(), settings, Box::new(Vec::new));
    assert!(matches!(
        h.server.apply_config("{}"),
        Err(ServerError::Failed(_))
    ));
    assert!(!h.dir.path().join("elsewhere.json").exists());
}

/// A wrapper that is already there, the same and executable, is not written again; one that
/// changed is.
#[cfg(unix)]
#[test]
fn the_wrapper_is_not_rewritten_when_it_is_the_same_and_is_when_it_is_not() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let h2 = harness("2.4.0");
    // the same folder is another harness: stage the same file there, then start
    let w2 = h2.dir.path().join("opencode/writer-shell");
    std::fs::create_dir_all(w2.parent().unwrap()).unwrap();
    std::fs::write(&w2, shell_wrapper()).unwrap();
    std::fs::set_permissions(&w2, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ino2 = std::fs::metadata(&w2).unwrap().ino();
    h2.server.ensure_started().unwrap();
    assert_eq!(std::fs::metadata(&w2).unwrap().ino(), ino2, "not replaced");
    h2.server.shutdown();
    let h3 = harness("2.4.0");
    let w3 = h3.dir.path().join("opencode/writer-shell");
    std::fs::create_dir_all(w3.parent().unwrap()).unwrap();
    std::fs::write(&w3, "#!/bin/sh\nold\n").unwrap();
    std::fs::set_permissions(&w3, std::fs::Permissions::from_mode(0o755)).unwrap();
    h3.server.ensure_started().unwrap();
    assert_eq!(std::fs::read_to_string(&w3).unwrap(), shell_wrapper());
    assert_eq!(
        std::fs::metadata(&w3).unwrap().permissions().mode() & 0o777,
        0o700
    );
    h3.server.shutdown();
}

/// A server started from a shell that is the wrapper itself would run the wrapper for ever: the
/// wrapper is never its own user shell.
#[cfg(unix)]
#[test]
fn a_shell_that_is_the_wrapper_itself_falls_back_to_sh() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let s = settings_in(dir.path());
    let env = isolated_env(
        [
            ("PATH", "/usr/bin:/bin"),
            ("SHELL", &*s.shell_wrapper.to_string_lossy()),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string())),
        "pw",
        &s,
    );
    assert!(env.iter().all(|(k, _)| k != "WRITER_USER_SHELL"));
    std::fs::create_dir_all(s.shell_wrapper.parent().unwrap()).unwrap();
    std::fs::write(&s.shell_wrapper, shell_wrapper()).unwrap();
    std::fs::set_permissions(&s.shell_wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let out = std::process::Command::new(&s.shell_wrapper)
        .args(["-c", "echo ran $SHELL"])
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "ran /bin/sh");
}
