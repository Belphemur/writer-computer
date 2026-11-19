//! The fake `claude` (`e2e/fixtures/agent-fake-claude/fake-claude.cjs`) driven over real pipes
//! and read back through the production mapper, so the e2e fake cannot drift from what
//! `claude_stream.rs` understands. Skipped when `node` is not installed.

use desktop_lib::agent::chat_store::is_session_missing;
use desktop_lib::agent::claude_stream::*;
use desktop_lib::agent::events::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const SESSION: &str = "11111111-1111-4111-8111-111111111111";

fn fake_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../e2e/fixtures/agent-fake-claude/fake-claude.cjs")
        .canonicalize()
        .expect("fake-claude.cjs")
}

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct Fake {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    mapper: ClaudeStreamMapper,
    events: Vec<AgentEvent>,
}

impl Fake {
    fn spawn(home: &Path, cwd: &Path, args: &[&str]) -> Fake {
        Fake::spawn_env(home, cwd, args, &[])
    }

    /// `env` is set for the fake and so for anything it starts (the MCP server).
    fn spawn_env(home: &Path, cwd: &Path, args: &[&str], env: &[(&str, &Path)]) -> Fake {
        let mut child = Command::new("node")
            .arg(fake_path())
            .args(args)
            .envs(env.iter().copied())
            .env("FAKE_CLAUDE_HOME", home)
            .env_remove("FAKE_CLAUDE_SCENARIO")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        Fake {
            child,
            stdin,
            lines: rx,
            mapper: ClaudeStreamMapper::new(),
            events: Vec::new(),
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn prompt(&mut self, text: &str) {
        self.send(&encode_user_message(text, &[]));
    }

    /// Read mapped events until one matches; returns it. Panics after 10 s of silence.
    fn until(&mut self, pred: impl Fn(&AgentEvent) -> bool) -> AgentEvent {
        loop {
            if let Some(i) = self.events.iter().position(&pred) {
                return self.events.remove(i);
            }
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|_| panic!("timed out; pending events: {:?}", self.events));
            let out = self.mapper.map_line(&line);
            assert_eq!(out.unsupported_control_request, None);
            self.events.extend(out.events);
        }
    }

    fn finished(&mut self) -> TurnFinishReason {
        match self.until(|e| matches!(e, AgentEvent::TurnFinished { .. })) {
            AgentEvent::TurnFinished { reason, .. } => reason,
            _ => unreachable!(),
        }
    }

    fn close(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().unwrap()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn dirs() -> (tempfile::TempDir, tempfile::TempDir) {
    (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
}

macro_rules! need_node {
    () => {
        if !node_available() {
            eprintln!("skipped: node not installed");
            return;
        }
    };
}

#[test]
fn version_probe() {
    need_node!();
    let out = Command::new("node")
        .arg(fake_path())
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "2.1.325 (Claude Code)"
    );
}

#[test]
fn plain_reply_echoes_the_session_id_and_streams_the_turn() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(
        home.path(),
        cwd.path(),
        &["-p", "--session-id", SESSION, "--model", "claude-test-1"],
    );
    f.prompt("hello there");
    match f.until(|e| matches!(e, AgentEvent::SessionStarted { .. })) {
        AgentEvent::SessionStarted {
            session_id,
            model,
            cli_version,
            cwd: c,
            ..
        } => {
            assert_eq!(session_id, SESSION);
            assert_eq!(model.as_deref(), Some("claude-test-1"));
            assert_eq!(cli_version.as_deref(), Some("2.1.325"));
            assert!(c.ends_with(cwd.path().file_name().unwrap().to_str().unwrap()));
        }
        _ => unreachable!(),
    }
    match f.until(|e| matches!(e, AgentEvent::Text { .. })) {
        AgentEvent::Text { text, .. } => assert_eq!(text, "FAKE-CLAUDE-REPLY: hello there"),
        _ => unreachable!(),
    }
    assert_eq!(f.finished(), TurnFinishReason::Completed);
    assert!(f.close().success());
}

#[test]
fn a_second_turn_in_the_same_process_has_fresh_message_ids() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    let mut ids = Vec::new();
    for text in ["first", "second"] {
        f.prompt(text);
        if let AgentEvent::Text {
            message_id,
            text: t,
            ..
        } = f.until(|e| matches!(e, AgentEvent::Text { .. }))
        {
            assert!(t.ends_with(text));
            ids.push(message_id);
        }
        assert_eq!(f.finished(), TurnFinishReason::Completed);
    }
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn tool_without_permission_runs_to_an_answer() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:tool-auto] list files");
    let started = f.until(|e| matches!(e, AgentEvent::ToolCallStarted { .. }));
    assert!(matches!(started, AgentEvent::ToolCallStarted { ref tool, .. } if tool == "Bash"));
    f.until(|e| {
        matches!(
            e,
            AgentEvent::ToolCallFinished {
                outcome: ToolOutcome::Ok,
                ..
            }
        )
    });
    f.until(|e| {
        matches!(
            e,
            AgentEvent::Thinking {
                phase: ThinkingPhase::End,
                ..
            }
        )
    });
    assert_eq!(f.finished(), TurnFinishReason::Completed);
}

#[test]
fn permission_allow_waits_for_the_answer_and_persists_the_rule() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:permission-allow] write a file");
    // First request: Write, with the setMode suggestion.
    let AgentEvent::PermissionRequest {
        request_id,
        tool,
        input,
        ..
    } = f.until(|e| matches!(e, AgentEvent::PermissionRequest { .. }))
    else {
        unreachable!()
    };
    assert_eq!(tool, "Write");
    // The turn is paused: nothing finishes before the answer.
    assert!(f.lines.recv_timeout(Duration::from_millis(300)).is_err());
    f.send(&encode_permission_allow(&request_id, &input, &[]));
    // Second request: Bash, answered with "Always in this project".
    let AgentEvent::PermissionRequest {
        request_id,
        tool,
        input,
        suggestions,
        ..
    } = f.until(|e| matches!(e, AgentEvent::PermissionRequest { .. }))
    else {
        unreachable!()
    };
    assert_eq!(tool, "Bash");
    let updated = updated_permissions(&suggestions, Some(PermissionPersist::Project));
    assert_eq!(updated.len(), 1);
    f.send(&encode_permission_allow(&request_id, &input, &updated));
    assert_eq!(f.finished(), TurnFinishReason::Completed);
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(cwd.path().join(".claude/settings.local.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["permissions"]["allow"],
        json!(["Bash(python3 -c 'print\\(1\\)')"])
    );
}

#[test]
fn permission_deny_finishes_with_a_rejected_tool() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:permission-deny] run it");
    let AgentEvent::PermissionRequest { request_id, .. } =
        f.until(|e| matches!(e, AgentEvent::PermissionRequest { .. }))
    else {
        unreachable!()
    };
    f.send(&encode_permission_deny(&request_id, "User denied"));
    f.until(|e| matches!(e, AgentEvent::ToolCallFinished { is_error: true, .. }));
    assert_eq!(f.finished(), TurnFinishReason::Completed);
}

#[test]
fn interrupt_with_a_pending_permission_cancels_it() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:interrupt] go");
    f.until(|e| matches!(e, AgentEvent::PermissionRequest { .. }));
    f.send(&encode_interrupt("req_int_1"));
    f.until(|e| {
        matches!(
            e,
            AgentEvent::PermissionResolved {
                resolution: PermissionResolution::Cancelled,
                ..
            }
        )
    });
    assert_eq!(f.finished(), TurnFinishReason::Interrupted);
}

#[test]
fn interrupt_mid_stream_aborts_the_turn() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:slow] take your time");
    f.until(|e| matches!(e, AgentEvent::SessionStarted { .. }));
    f.send(&encode_interrupt("req_int_9"));
    assert_eq!(f.finished(), TurnFinishReason::Interrupted);
    // The process survives and answers the next prompt.
    f.prompt("[fake:plain] again");
    assert_eq!(f.finished(), TurnFinishReason::Completed);
}

#[test]
fn crash_mid_turn_exits_without_a_result() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:crash] boom");
    f.until(|e| matches!(e, AgentEvent::SessionStarted { .. }));
    let status = f.child.wait().unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(!f
        .events
        .iter()
        .any(|e| matches!(e, AgentEvent::TurnFinished { .. })));
}

#[test]
fn auth_error_maps_to_an_auth_error_event() {
    need_node!();
    let (home, cwd) = dirs();
    let mut f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    f.prompt("[fake:auth-error] hi");
    assert_eq!(f.finished(), TurnFinishReason::Error);
    assert!(matches!(
        f.until(|e| matches!(e, AgentEvent::Error { .. })),
        AgentEvent::Error {
            kind: AgentErrorKind::Auth,
            retryable: false,
            ..
        }
    ));
}

#[test]
fn resume_works_for_a_known_session_and_fails_like_the_cli_for_an_unknown_one() {
    need_node!();
    let (home, cwd) = dirs();
    let mut first = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    first.prompt("remember");
    assert_eq!(first.finished(), TurnFinishReason::Completed);
    assert!(first.close().success());

    let mut again = Fake::spawn(home.path(), cwd.path(), &["-p", "--resume", SESSION]);
    again.prompt("again");
    match again.until(|e| matches!(e, AgentEvent::SessionStarted { .. })) {
        AgentEvent::SessionStarted { session_id, .. } => assert_eq!(session_id, SESSION),
        _ => unreachable!(),
    }
    assert_eq!(again.finished(), TurnFinishReason::Completed);
    drop(again);

    let missing = Command::new("node")
        .arg(fake_path())
        .args(["-p", "--resume", "22222222-2222-4222-8222-222222222222"])
        .env("FAKE_CLAUDE_HOME", home.path())
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(missing.stdout.is_empty(), "exits before any output");
    assert!(is_session_missing(&String::from_utf8_lossy(
        &missing.stderr
    )));
}

#[test]
fn the_cli_never_hangs_on_stdin_close() {
    need_node!();
    let (home, cwd) = dirs();
    let f = Fake::spawn(home.path(), cwd.path(), &["-p", "--session-id", SESSION]);
    assert!(f.close().success());
}

/// The ADR's end-to-end check: the argv Writer builds (`build_args` with the MCP wiring) hands the
/// fake `claude` Writer's real `writer mcp` server (the app binary under its CLI name); the fake
/// calls `search` through it and the chat shows an `mcp__writer__search` call with the ranked
/// hit. Unix only: the launcher is a symlink.
#[cfg(unix)]
#[test]
fn a_chat_searches_through_the_writer_mcp_server() {
    need_node!();
    use desktop_lib::agent::{cli_launcher, mcp_wiring};
    let (home, vault) = dirs();
    let vault_root = vault.path().canonicalize().unwrap();
    std::fs::create_dir_all(vault_root.join(".obsidian")).unwrap();
    std::fs::write(vault_root.join(".obsidian/app.json"), "{}").unwrap();
    std::fs::write(
        vault_root.join("Beta.md"),
        "# Beta\nbeta body with the word Needle\n",
    )
    .unwrap();
    std::fs::write(vault_root.join("Other.md"), "# Other\nnothing here\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let bin = cli_launcher::ensure(
        &data.path().join("bin"),
        Path::new(env!("CARGO_BIN_EXE_desktop")),
    )
    .unwrap();
    let wiring = mcp_wiring::wiring(&bin.join(cli_launcher::LAUNCHER_NAME), &vault_root).unwrap();
    let settings = AgentSettings {
        binary_path: None,
        model: None,
        effort: None,
        permission_mode: AgentPermissionMode::Manual,
        allowed_tools: vec![],
        disallowed_tools: vec![],
        orchestrate: false,
        show_thinking: false,
        memory: AgentMemory::Off,
        auto_reload: true,
        tier_models: Default::default(),
    };
    let args = build_args(&ClaudeSpawn {
        session: SessionRef::New(SESSION.into()),
        settings: &settings,
        append_system_prompt: None,
        add_dirs: &[],
        agents: None,
        memory_dir: None,
        mcp: Some(&wiring),
    })
    .unwrap();
    assert!(
        args.contains(&"mcp__writer__search".to_string()),
        "read tools are allowed"
    );
    assert!(
        !args.contains(&"mcp__writer__create".to_string()),
        "write tools ask"
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let cli_home = tempfile::tempdir().unwrap();
    let mut f = Fake::spawn_env(
        home.path(),
        &vault_root,
        &argv,
        &[("HOME", cli_home.path()), ("WRITER_INDEX_DIR", data.path())],
    );
    f.prompt("[fake:mcp-search] Needle");
    match f.until(|e| matches!(e, AgentEvent::SessionStarted { .. })) {
        AgentEvent::SessionStarted { mcp_servers, .. } => {
            assert!(
                mcp_servers.iter().any(|m| m.name == "writer"),
                "{mcp_servers:?}"
            )
        }
        _ => unreachable!(),
    }
    match f.until(|e| matches!(e, AgentEvent::ToolCallStarted { .. })) {
        AgentEvent::ToolCallStarted { tool, .. } => assert_eq!(tool, "mcp__writer__search"),
        _ => unreachable!(),
    }
    match f.until(|e| matches!(e, AgentEvent::ToolCallInput { .. })) {
        AgentEvent::ToolCallInput { input, .. } => assert_eq!(input, json!({"query": "Needle"})),
        _ => unreachable!(),
    }
    match f.until(|e| matches!(e, AgentEvent::ToolCallFinished { .. })) {
        AgentEvent::ToolCallFinished {
            output,
            is_error,
            outcome,
            ..
        } => {
            assert!(!is_error && outcome == ToolOutcome::Ok, "{output}");
            assert!(output.contains("Beta"), "{output}");
            assert!(!output.contains("Other"), "{output}");
        }
        _ => unreachable!(),
    }
    assert_eq!(f.finished(), TurnFinishReason::Completed);
}
