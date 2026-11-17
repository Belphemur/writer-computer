//! Runner tests against a FAKE `claude`: a bash script written to a temp dir that replays the
//! captured fixtures (`agent/fixtures/*.jsonl`) over stdio, pausing after each `control_request`
//! until the next stdin line arrives (the permission answer or the interrupt). The real CLI is
//! never started here (spec 12). The script records what it was given in files next to it:
//! `argv.log`, `cwd.log`, `pids.log`, `stdin.log`.
//!
//! A `{"type":"fake_pause"}` line in a fixture makes the script wait until the test creates `go`
//! (`Harness::go`), so a test can act between two lines (a tool "running" after its call was
//! announced). Fixtures named `subagent-*` are synthetic, built from the shapes of a real claude
//! 2.1.326 run that delegated to a sub-agent (`system` `task_*` lines, `parent_tool_use_id`).
//!
//! Modes (read from `mode.txt` at every stdin line, and once at launch): `normal`,
//! `crash-after-init`, `crash-before-init`, `hang`, `resume-missing`, `mode-error`,
//! `unsupported`, `grandchild`.

use super::events::*;
use super::ports::{ChatPort, InjectAgentsMd, ProjectPort, SpawnContext};
use super::session::{AgentSessions, Sink, StartParams, StartedIds, Timing};
use crate::plugin_consent::ConsentStore;
use crate::plugin_proc::{Consent, ConsentRequest, Decision};
use parking_lot::Mutex;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

const FAKE: &str = r##"#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "--version" ]; then echo "2.1.325 (Claude Code)"; exit 0; fi
if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'; exit 0; fi
MODE="$(cat "$D/mode.txt" 2>/dev/null || echo normal)"
SID=""; prev=""
for a in "$@"; do case "$prev" in --session-id|--resume) SID="$a";; esac; prev="$a"; done
echo "$@" >> "$D/argv.log"
echo "$$" >> "$D/pids.log"
pwd >> "$D/cwd.log"
if [ "$MODE" = resume-missing ]; then
  case " $* " in *" --resume "*) echo "No conversation found with session ID: $SID" >&2; exit 1;; esac
fi
exec 3<&0
if [ "$MODE" = grandchild ]; then sleep 300 & echo $! > "$D/grandchild.pid"; fi
turn=0
play() { # fixture, max lines
  sed -E "s/\"session_id\":\"[^\"]*\"/\"session_id\":\"$SID\"/g" "$1" > "$D/turn.tmp"
  exec 4< "$D/turn.tmp"
  n=0
  while IFS= read -r l <&4; do
    printf '%s\n' "$l"
    n=$((n+1))
    [ -n "$2" ] && [ "$n" -ge "$2" ] && break
    case "$l" in
      *'"type":"control_request"'*) read -r resp <&3 || exit 0; echo "$resp" >> "$D/stdin.log";;
      *'"type":"fake_pause"'*) while [ ! -e "$D/go" ]; do sleep 0.05; done; rm -f "$D/go";;
    esac
  done
  exec 4<&-
}
while IFS= read -r line <&3; do
  echo "$line" >> "$D/stdin.log"
  MODE="$(cat "$D/mode.txt" 2>/dev/null || echo normal)"
  case "$line" in
    *'"subtype":"set_permission_mode"'*|*'"subtype":"set_model"'*)
      rid=$(printf '%s' "$line" | sed -E 's/.*"request_id":"([^"]*)".*/\1/')
      if [ "$MODE" = model-restricted ] && printf '%s' "$line" | grep -q set_model; then
        printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"restricted","error_code":"restricted_by_org","model":"claude-haiku-5-5"}}\n' "$rid"
      elif [ "$MODE" = mode-error ]; then
        printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"nope"}}\n' "$rid"
      else
        printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid"
      fi
      continue;;
    *'"type":"user"'*) ;;
    *) continue;;
  esac
  f="$(sed -n "$((turn+1))p" "$D/turns.txt")"; turn=$((turn+1))
  [ -z "$f" ] && f="$(tail -n 1 "$D/turns.txt")"
  case "$MODE" in
    crash-before-init) exit 3;;
    crash-after-init) play "$f" 2; exit 3;;
    hang) play "$f" 17; sleep 300;;
    unsupported)
      printf '%s\n' '{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback","callback_id":"x"}}'
      read -r resp <&3 || exit 0; echo "$resp" >> "$D/stdin.log"
      play "$f";;
    *) play "$f";;
  esac
done
[ "$MODE" = grandchild ] && wait
exit 0
"##;

fn init_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // the login-PATH probe runs `$SHELL -ilc`: keep it to a plain sh in tests
        std::env::set_var("SHELL", "/bin/sh");
    });
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/agent/fixtures")
        .join(format!("{name}.jsonl"))
}

struct Ask {
    decision: Decision,
    asked: AtomicUsize,
}

impl Ask {
    fn new(decision: Decision) -> Self {
        Self {
            decision,
            asked: AtomicUsize::new(0),
        }
    }
    fn asked(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }
}

impl Consent for Ask {
    fn ask(&self, req: &ConsentRequest) -> Decision {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let m = req.message();
        assert!(m.contains("--permission-mode"), "dialog shows the argv");
        assert!(!m.contains("dangerously"));
        self.decision
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    fdir: PathBuf,
    fake: PathBuf,
    sessions: AgentSessions,
    rx: Receiver<AgentEventEnvelope>,
    sink: Sink,
    store: ConsentStore,
    seen: Vec<AgentEventEnvelope>,
    cursor: usize,
}

fn test_timing() -> Timing {
    Timing {
        cancel_grace: Duration::from_millis(500),
        close_grace: Duration::from_millis(300),
        term_to_kill: Duration::from_millis(300),
        idle_after: Duration::from_secs(1800),
        reaper_every: Duration::from_millis(50),
    }
}

impl Harness {
    fn new(turns: &[&str], mode: &str) -> Self {
        Self::with_timing(turns, mode, test_timing())
    }

    fn with_timing(turns: &[&str], mode: &str, timing: Timing) -> Self {
        init_env();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let fdir = dir.path().join("fake");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&fdir).unwrap();
        let root = root.canonicalize().unwrap();
        let fake = fdir.join("claude");
        std::fs::write(&fake, FAKE).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let h = {
            let (tx, rx) = channel();
            let tx = Mutex::new(tx);
            let sink: Sink = Arc::new(move |e| {
                let _ = tx.lock().send(e);
            });
            Harness {
                store: ConsentStore::new(dir.path().join("consent.json")),
                _dir: dir,
                root,
                fdir,
                fake,
                sessions: AgentSessions::with_timing(timing),
                rx,
                sink,
                seen: Vec::new(),
                cursor: 0,
            }
        };
        h.set_turns(turns);
        h.set_mode(mode);
        h
    }

    fn set_turns(&self, turns: &[&str]) {
        let body: String = turns
            .iter()
            .map(|t| format!("{}\n", fixture(t).display()))
            .collect();
        std::fs::write(self.fdir.join("turns.txt"), body).unwrap();
    }

    fn set_mode(&self, mode: &str) {
        std::fs::write(self.fdir.join("mode.txt"), mode).unwrap();
    }

    fn log(&self, name: &str) -> String {
        std::fs::read_to_string(self.fdir.join(name)).unwrap_or_default()
    }

    fn lines(&self, name: &str) -> Vec<String> {
        self.log(name).lines().map(String::from).collect()
    }

    fn settings(&self) -> AgentSettings {
        AgentSettings {
            binary_path: Some(self.fake.to_string_lossy().into_owned()),
            model: None,
            effort: None,
            permission_mode: AgentPermissionMode::Manual,
            allowed_tools: vec![],
            disallowed_tools: vec![],
            orchestrate: true,
            tier_models: Default::default(),
        }
    }

    fn params(&self, chat_id: &str, label: &str, project: Option<&str>) -> StartParams {
        StartParams {
            label: label.into(),
            root: self.root.clone(),
            request: StartSessionRequest {
                chat_id: chat_id.into(),
                project_path: project.map(String::from),
                resume_session_id: None,
                settings: self.settings(),
                append_system_prompt: None,
            },
            inject_agents_md: InjectAgentsMd::Auto,
            store: self.store.clone(),
            still_ok: Arc::new(|| true),
            sink: Arc::clone(&self.sink),
        }
    }

    fn start(&self, chat: &str) -> StartedIds {
        self.sessions
            .start(self.params(chat, "w", None), &Ask::new(Decision::Once))
            .unwrap()
    }

    fn send(&self, chat: &str, text: &str) {
        self.sessions
            .send("w", chat, text.into(), &[])
            .expect("send");
    }

    /// The next event (after the ones already consumed) of `chat` matching `pred`.
    fn next(&mut self, chat: &str, what: &str, pred: impl Fn(&AgentEvent) -> bool) -> AgentEvent {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            while self.cursor < self.seen.len() {
                let e = &self.seen[self.cursor];
                self.cursor += 1;
                if e.chat_id == chat && pred(&e.event) {
                    return e.event.clone();
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(e) => self.seen.push(e),
                Err(_) => panic!(
                    "timed out waiting for {what}; saw {:?}",
                    self.seen
                        .iter()
                        .map(|e| format!(
                            "{}:{}",
                            e.seq,
                            serde_json::to_string(&e.event)
                                .unwrap()
                                .chars()
                                .take(60)
                                .collect::<String>()
                        ))
                        .collect::<Vec<_>>()
                ),
            }
        }
    }

    fn turn_finished(&mut self, chat: &str) -> TurnFinishReason {
        match self.next(chat, "turn-finished", |e| {
            matches!(e, AgentEvent::TurnFinished { .. })
        }) {
            AgentEvent::TurnFinished { reason, .. } => reason,
            _ => unreachable!(),
        }
    }

    /// Drain whatever else is already queued without waiting for more.
    fn drain(&mut self) {
        std::thread::sleep(Duration::from_millis(150));
        while let Ok(e) = self.rx.try_recv() {
            self.seen.push(e);
        }
    }

    /// Releases a `fake_pause` of the fixture.
    fn go(&self) {
        std::fs::write(self.fdir.join("go"), "").unwrap();
    }

    /// Points the harness at a fixture whose `__FILE__` is `file` (a path in the harness vault).
    fn use_fixture_for(&self, name: &str, file: &Path) {
        let derived = std::fs::read_to_string(fixture(name))
            .unwrap()
            .replace("__FILE__", &file.to_string_lossy());
        std::fs::write(self.fdir.join("derived.jsonl"), derived).unwrap();
        std::fs::write(
            self.fdir.join("turns.txt"),
            format!("{}\n", self.fdir.join("derived.jsonl").display()),
        )
        .unwrap();
    }

    fn wait_until(&self, what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.sessions.kill_all();
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

const CHAT: &str = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";

#[test]
fn an_attached_image_reaches_claude_as_a_native_image_block_before_the_text() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    std::fs::create_dir_all(h.root.join("pics")).unwrap();
    std::fs::write(h.root.join("pics/a.png"), png).unwrap();
    let r = |p: &str| [ContextRef::Image { path: p.into() }];
    // a gone image or an unreadable type fails the send and writes nothing to claude
    assert!(h
        .sessions
        .send("w", CHAT, "x".into(), &r("pics/gone.png"))
        .is_err());
    std::fs::write(h.root.join("pics/a.svg"), "<svg/>").unwrap();
    assert!(h
        .sessions
        .send("w", CHAT, "x".into(), &r("pics/a.svg"))
        .is_err());
    assert!(h.lines("stdin.log").is_empty());

    h.sessions
        .send("w", CHAT, "what is this? PICTEXT".into(), &r("pics/a.png"))
        .expect("send");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let line = h
        .lines("stdin.log")
        .into_iter()
        .find(|l| l.contains("PICTEXT"))
        .expect("the user message");
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    let content = v["message"]["content"].as_array().expect("a content array");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["source"]["type"], "base64");
    assert_eq!(content[0]["source"]["media_type"], "image/png");
    use base64::Engine as _;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(content[0]["source"]["data"].as_str().unwrap())
            .unwrap(),
        png
    );
    assert_eq!(content[1]["type"], "text");
    assert!(content[1]["text"].as_str().unwrap().contains("PICTEXT"));
}

#[test]
fn plain_turn_flows_as_numbered_events_with_the_fixed_argv() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    let ids = h.start(CHAT);
    assert_eq!(ids.session_id, CHAT);
    h.send(CHAT, "hello");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    h.drain();

    let types: Vec<String> = h
        .seen
        .iter()
        .map(|e| {
            serde_json::to_value(&e.event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert!(types.contains(&"session-started".to_string()), "{types:?}");
    assert!(types.contains(&"text".to_string()));
    assert!(types.contains(&"usage".to_string()));
    assert!(
        h.seen
            .iter()
            .enumerate()
            .all(|(i, e)| e.seq == i as u64 + 1),
        "seq from 1, no gaps"
    );
    assert!(h.seen.iter().all(|e| e.chat_id == CHAT));

    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 1);
    let a = &argv[0];
    for want in [
        "-p",
        "--input-format stream-json",
        "--output-format stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-prompt-tool stdio",
        "--permission-mode manual",
        "--setting-sources user,project,local",
        &format!("--session-id {CHAT}"),
    ] {
        assert!(a.contains(want), "argv lacks {want}: {a}");
    }
    for never in ["dangerously", "bypass", "--bare", "--resume", "--add-dir"] {
        assert!(!a.contains(never), "argv has {never}: {a}");
    }
    assert_eq!(
        h.lines("cwd.log"),
        vec![h.root.to_string_lossy().to_string()]
    );

    let (state, snap) = h.sessions.snapshot("w", CHAT, 0);
    assert_eq!(state, AgentSessionState::Idle);
    assert_eq!(snap.len(), h.seen.len());
    let (_, tail) = h.sessions.snapshot("w", CHAT, 3);
    assert_eq!(tail.len(), h.seen.len() - 3);
    // a snapshot of an unknown chat is "ended", not an error
    assert_eq!(
        h.sessions.snapshot("w", "nope", 0).0,
        AgentSessionState::Ended
    );
}

#[test]
fn one_process_serves_several_turns_and_queues_while_busy() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "first");
    h.send(CHAT, "second"); // queued by the runner until the first turn finishes
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    assert_eq!(h.lines("pids.log").len(), 1, "one process for the chat");
    let stdin = h.log("stdin.log");
    let first = stdin.find("first").expect("first sent");
    let second = stdin.find("second").expect("second sent");
    assert!(first < second);
    assert!(h.sessions.get("w", CHAT).unwrap().is_live());
}

#[test]
fn permission_round_trip_allow_with_persist_choices() {
    let mut h = Harness::new(&["permission-allow"], "normal");
    h.start(CHAT);
    h.send(CHAT, "run it");
    let req = |h: &mut Harness| match h.next(CHAT, "permission-request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    }) {
        AgentEvent::PermissionRequest {
            request_id,
            suggestions,
            ..
        } => (request_id, suggestions),
        _ => unreachable!(),
    };
    let (id1, suggestions) = req(&mut h);
    assert!(!suggestions.is_empty(), "the CLI sent suggestions");
    assert_eq!(
        h.sessions.get("w", CHAT).unwrap().state(),
        AgentSessionState::AwaitingPermission
    );

    h.sessions
        .permission(
            "w",
            CHAT,
            &id1,
            PermissionDecision::Allow,
            Some(PermissionPersist::AcceptEdits),
            None,
        )
        .unwrap();
    match h.next(CHAT, "resolved", |e| {
        matches!(e, AgentEvent::PermissionResolved { .. })
    }) {
        AgentEvent::PermissionResolved {
            request_id,
            resolution,
        } => {
            assert_eq!(request_id, id1);
            assert_eq!(resolution, PermissionResolution::Allowed);
        }
        _ => unreachable!(),
    }
    assert!(
        h.sessions
            .permission("w", CHAT, &id1, PermissionDecision::Allow, None, None)
            .is_err(),
        "answering twice is an error"
    );
    assert!(h
        .sessions
        .permission("w", CHAT, "unknown", PermissionDecision::Deny, None, None)
        .is_err());

    let (id2, _) = req(&mut h);
    h.sessions
        .permission(
            "w",
            CHAT,
            &id2,
            PermissionDecision::Allow,
            Some(PermissionPersist::Project),
            None,
        )
        .unwrap();
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);

    h.wait_until("both answers reached the CLI", || {
        h.log("stdin.log").matches("control_response").count() == 2
    });
    let stdin = h.log("stdin.log");
    let answers: Vec<&str> = stdin
        .lines()
        .filter(|l| l.contains("control_response"))
        .collect();
    assert_eq!(answers.len(), 2, "{stdin}");
    assert!(answers[0].contains("\"behavior\":\"allow\""));
    assert!(
        answers[0].contains("\"setMode\"") && answers[0].contains("\"destination\":\"session\"")
    );
    assert!(answers[0].contains(&id1));
    assert!(answers[1].contains("\"behavior\":\"allow\""));
    assert!(
        answers[1].contains("addRules") && answers[1].contains("localSettings"),
        "{}",
        answers[1]
    );
}

#[test]
fn deny_without_reason_tells_the_model_why() {
    let mut h = Harness::new(&["permission-deny"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    let id = match h.next(CHAT, "request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    }) {
        AgentEvent::PermissionRequest { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    h.sessions
        .permission("w", CHAT, &id, PermissionDecision::Deny, None, None)
        .unwrap();
    h.turn_finished(CHAT);
    h.wait_until("deny reached the CLI", || {
        h.log("stdin.log").contains("The user denied this action")
    });
    assert!(h.log("stdin.log").contains("\"behavior\":\"deny\""));
}

#[test]
fn cancel_sends_interrupt_and_the_turn_ends_interrupted() {
    let mut h = Harness::new(&["interrupt"], "normal");
    h.start(CHAT);
    h.send(CHAT, "do something");
    h.next(CHAT, "request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    });
    h.sessions.cancel("w", CHAT).unwrap();
    assert_eq!(
        h.sessions.get("w", CHAT).unwrap().state(),
        AgentSessionState::Cancelling
    );
    match h.next(CHAT, "cancelled card", |e| {
        matches!(e, AgentEvent::PermissionResolved { .. })
    }) {
        AgentEvent::PermissionResolved { resolution, .. } => {
            assert_eq!(resolution, PermissionResolution::Cancelled)
        }
        _ => unreachable!(),
    }
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Interrupted);
    assert!(h.log("stdin.log").contains("\"subtype\":\"interrupt\""));
    h.wait_until("idle after interrupt", || {
        h.sessions.get("w", CHAT).unwrap().state() == AgentSessionState::Idle
    });
    // the process survived the interrupt
    assert_eq!(h.lines("pids.log").len(), 1);
    assert!(h.sessions.get("w", CHAT).unwrap().is_live());
}

#[test]
fn a_process_that_ignores_the_interrupt_is_killed_and_resumes_on_the_next_send() {
    let mut h = Harness::new(&["interrupt"], "hang");
    h.start(CHAT);
    h.send(CHAT, "go");
    h.next(CHAT, "request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    });
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.sessions.cancel("w", CHAT).unwrap();
    match h.next(CHAT, "session-ended", |e| {
        matches!(e, AgentEvent::SessionEnded { .. })
    }) {
        AgentEvent::SessionEnded { reason, .. } => assert_eq!(reason, SessionEndReason::Killed),
        _ => unreachable!(),
    }
    h.wait_until("process gone", || !alive(pid));

    h.set_mode("normal");
    h.set_turns(&["ok-turn"]);
    h.send(CHAT, "again");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 2);
    assert!(argv[1].contains(&format!("--resume {CHAT}")), "{}", argv[1]);
}

#[test]
fn a_crash_during_a_turn_reports_it_and_respawns_with_resume() {
    let mut h = Harness::new(&["ok-turn"], "crash-after-init");
    h.start(CHAT);
    h.send(CHAT, "x");
    match h.next(CHAT, "process-exited", |e| {
        matches!(e, AgentEvent::Error { .. })
    }) {
        AgentEvent::Error {
            kind, retryable, ..
        } => {
            assert_eq!(kind, AgentErrorKind::ProcessExited);
            assert!(retryable);
        }
        _ => unreachable!(),
    }
    // the transcript's turn ends, then a process waits with --resume
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Error);
    h.wait_until("respawned", || h.lines("argv.log").len() == 2);
    let argv = h.lines("argv.log");
    assert!(argv[1].contains(&format!("--resume {CHAT}")), "{}", argv[1]);
    h.wait_until("idle again", || {
        h.sessions.get("w", CHAT).unwrap().state() == AgentSessionState::Idle
    });
}

#[test]
fn a_process_that_never_comes_up_is_retried_twice_then_the_session_ends() {
    let mut h = Harness::new(&["ok-turn"], "crash-before-init");
    h.start(CHAT);
    h.send(CHAT, "x");
    match h.next(CHAT, "session-ended", |e| {
        matches!(e, AgentEvent::SessionEnded { .. })
    }) {
        AgentEvent::SessionEnded {
            reason, exit_code, ..
        } => {
            assert_eq!(reason, SessionEndReason::Exit);
            assert_eq!(exit_code, Some(3));
        }
        _ => unreachable!(),
    }
    assert_eq!(
        h.lines("pids.log").len(),
        3,
        "first start plus two respawns"
    );
    assert_eq!(
        h.sessions.get("w", CHAT).unwrap().state(),
        AgentSessionState::Error
    );
    assert_eq!(h.sessions.live_count("w"), 0);
    // the user can still try again
    h.set_mode("normal");
    h.send(CHAT, "retry");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
}

#[test]
fn consent_denied_is_an_error_event_and_nothing_is_spawned() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    let deny = Ask::new(Decision::Deny);
    h.sessions.start(h.params(CHAT, "w", None), &deny).unwrap();
    match h.next(CHAT, "spawn-denied", |e| {
        matches!(e, AgentEvent::Error { .. })
    }) {
        AgentEvent::Error { kind, .. } => assert_eq!(kind, AgentErrorKind::SpawnDenied),
        _ => unreachable!(),
    }
    assert_eq!(deny.asked(), 1);
    assert!(h.lines("pids.log").is_empty(), "no process");
    assert_eq!(
        h.sessions.get("w", CHAT).unwrap().state(),
        AgentSessionState::Error
    );
    assert!(
        h.store.list(&h.root).is_empty(),
        "a denial is not remembered"
    );

    // asked again on retry, and a message without a started process cannot sneak one in
    h.send(CHAT, "sneaky");
    h.next(CHAT, "not consented", |e| {
        matches!(
            e,
            AgentEvent::Error {
                kind: AgentErrorKind::SpawnDenied,
                ..
            }
        )
    });
    assert!(h.lines("pids.log").is_empty());

    let once = Ask::new(Decision::Once);
    h.sessions.start(h.params(CHAT, "w", None), &once).unwrap();
    assert_eq!(once.asked(), 1);
    h.send(CHAT, "now");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
}

#[test]
fn always_allow_is_remembered_per_vault_for_every_chat() {
    let h = Harness::new(&["ok-turn"], "normal");
    let always = Ask::new(Decision::Always);
    let chat2 = "6a2f41a2-9b7c-4d52-8c36-2f1c4ee0a111";
    h.sessions
        .start(h.params(CHAT, "w", None), &always)
        .unwrap();
    h.sessions
        .start(h.params(chat2, "w", None), &always)
        .unwrap();
    assert_eq!(always.asked(), 1, "second chat skips the dialog");
    h.wait_until("both processes", || h.lines("pids.log").len() == 2);
    assert!(h
        .store
        .has_wildcard(&h.root, super::consent::AGENT_PLUGIN_ID));
}

#[test]
fn a_missing_binary_is_a_binary_not_found_event() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    let mut p = h.params(CHAT, "w", None);
    p.request.settings.binary_path =
        Some(h.fdir.join("does-not-exist").to_string_lossy().into_owned());
    h.sessions.start(p, &Ask::new(Decision::Once)).unwrap();
    match h.next(CHAT, "binary-not-found", |e| {
        matches!(e, AgentEvent::Error { .. })
    }) {
        AgentEvent::Error {
            kind, retryable, ..
        } => {
            assert_eq!(kind, AgentErrorKind::BinaryNotFound);
            assert!(!retryable);
        }
        _ => unreachable!(),
    }
}

#[test]
fn close_ends_the_session_and_the_whole_process_group() {
    let mut h = Harness::new(&["ok-turn"], "grandchild");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.wait_until("grandchild", || h.fdir.join("grandchild.pid").exists());
    let grandchild: i32 = h.log("grandchild.pid").trim().parse().unwrap();
    assert!(alive(pid) && alive(grandchild));

    h.sessions.close("w", CHAT).unwrap();
    match h.next(CHAT, "session-ended", |e| {
        matches!(e, AgentEvent::SessionEnded { .. })
    }) {
        AgentEvent::SessionEnded { reason, .. } => assert_eq!(reason, SessionEndReason::Closed),
        _ => unreachable!(),
    }
    h.wait_until("no orphan", || !alive(pid) && !alive(grandchild));
    assert!(
        h.sessions.get("w", CHAT).is_err(),
        "removed from the registry"
    );
    assert!(h.sessions.send("w", CHAT, "late".into(), &[]).is_err());
}

#[test]
fn closing_a_chat_that_never_started_ends_it_at_once() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    let deny = Ask::new(Decision::Deny);
    h.sessions.start(h.params(CHAT, "w", None), &deny).unwrap();
    h.next(CHAT, "denied", |e| matches!(e, AgentEvent::Error { .. }));
    h.sessions.close("w", CHAT).unwrap();
    match h.next(CHAT, "ended", |e| {
        matches!(e, AgentEvent::SessionEnded { .. })
    }) {
        AgentEvent::SessionEnded { reason, .. } => assert_eq!(reason, SessionEndReason::Closed),
        _ => unreachable!(),
    }
}

#[test]
fn vault_and_window_shutdown_kill_the_group_without_orphans() {
    let mut h = Harness::new(&["ok-turn"], "grandchild");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.wait_until("grandchild", || h.fdir.join("grandchild.pid").exists());
    let grandchild: i32 = h.log("grandchild.pid").trim().parse().unwrap();

    // another window's chat is untouched by `kill_window("w")`
    let other = "7b3a52b3-0c8d-4e63-9d47-3a2d5ff1b222";
    h.sessions
        .start(h.params(other, "w2", None), &Ask::new(Decision::Once))
        .unwrap();
    h.wait_until("second process", || h.lines("pids.log").len() == 2);
    assert_eq!(h.sessions.live_count("w"), 1);
    assert_eq!(h.sessions.live_count("w2"), 1);

    h.sessions.kill_window("w");
    match h.next(CHAT, "session-ended", |e| {
        matches!(e, AgentEvent::SessionEnded { .. })
    }) {
        AgentEvent::SessionEnded { reason, .. } => {
            assert_eq!(reason, SessionEndReason::VaultSwitched)
        }
        _ => unreachable!(),
    }
    h.wait_until("no orphan", || !alive(pid) && !alive(grandchild));
    assert_eq!(h.sessions.live_count("w2"), 1, "other window keeps running");
    assert!(h.sessions.get("w2", other).is_ok());

    h.sessions.kill_root(&h.root);
    h.wait_until("vault kill", || h.sessions.live_count("w2") == 0);
}

#[test]
fn the_fifth_process_in_a_window_is_refused() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    let ids: Vec<String> = (0..5)
        .map(|i| format!("00000000-0000-4000-8000-00000000000{i}"))
        .collect();
    for id in &ids {
        h.sessions
            .start(h.params(id, "w", None), &Ask::new(Decision::Once))
            .unwrap();
    }
    match h.next(&ids[4], "busy", |e| matches!(e, AgentEvent::Error { .. })) {
        AgentEvent::Error { kind, message, .. } => {
            assert_eq!(kind, AgentErrorKind::SpawnFailed);
            assert!(message.contains('4'));
        }
        _ => unreachable!(),
    }
    assert_eq!(h.sessions.live_count("w"), 4);
    // another window has its own budget
    h.sessions
        .start(
            h.params("00000000-0000-4000-8000-0000000000aa", "w2", None),
            &Ask::new(Decision::Once),
        )
        .unwrap();
    assert_eq!(h.sessions.live_count("w2"), 1);
    // closing one frees a slot
    h.sessions.close("w", &ids[0]).unwrap();
    h.wait_until("slot freed", || h.sessions.live_count("w") == 3);
}

struct Rec {
    replaced: Mutex<Vec<(String, String, String)>>,
    started: Mutex<Vec<String>>,
}

impl ChatPort for Rec {
    fn session_started(&self, _root: &Path, info: &super::ports::ChatSessionInfo) {
        self.started.lock().push(info.session_id.clone());
    }
    fn session_replaced(&self, _root: &Path, chat: &str, old: &str, new: &str) {
        self.replaced
            .lock()
            .push((chat.into(), old.into(), new.into()));
    }
    fn replay_seed(&self, _root: &Path, _chat: &str) -> Option<String> {
        Some("SEED-FROM-NOTES".into())
    }
}

#[test]
fn a_missing_resume_session_starts_a_new_one_seeded_from_the_note() {
    let mut h = Harness::new(&["ok-turn"], "resume-missing");
    let rec = Arc::new(Rec {
        replaced: Mutex::new(vec![]),
        started: Mutex::new(vec![]),
    });
    h.sessions.ports().set_chats(rec.clone());
    let old = "11111111-2222-4333-8444-555555555555";
    let mut p = h.params(CHAT, "w", None);
    p.request.resume_session_id = Some(old.into());
    let ids = h.sessions.start(p, &Ask::new(Decision::Once)).unwrap();
    assert_eq!(ids.session_id, old);
    h.send(CHAT, "hello again");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);

    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 2, "{argv:?}");
    assert!(argv[0].contains(&format!("--resume {old}")));
    assert!(argv[1].contains("--session-id ") && !argv[1].contains("--resume"));
    let replaced = rec.replaced.lock().clone();
    assert_eq!(replaced.len(), 1);
    assert_eq!(
        (replaced[0].0.as_str(), replaced[0].1.as_str()),
        (CHAT, old)
    );
    let new = replaced[0].2.clone();
    assert_ne!(new, old);
    assert!(argv[1].contains(&format!("--session-id {new}")));
    assert_eq!(h.sessions.get("w", CHAT).unwrap().session_id(), new);
    let stdin = h.log("stdin.log");
    assert!(
        stdin.contains("SEED-FROM-NOTES") && stdin.contains("hello again"),
        "{stdin}"
    );
    assert_eq!(rec.started.lock().last().cloned(), Some(new));
}

#[test]
fn permission_mode_changes_live_when_the_cli_accepts_it() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    h.sessions
        .set_permission_mode("w", CHAT, AgentPermissionMode::AcceptEdits)
        .unwrap();
    h.wait_until("request sent", || {
        h.log("stdin.log")
            .contains("\"subtype\":\"set_permission_mode\"")
            && h.log("stdin.log").contains("\"mode\":\"acceptEdits\"")
    });
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        h.lines("pids.log").len(),
        1,
        "no restart when the CLI said yes"
    );
    assert!(h.sessions.get("w", CHAT).unwrap().is_live());
}

#[test]
fn a_refused_permission_mode_restarts_with_resume_and_the_new_mode() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.set_mode("mode-error");
    h.sessions
        .set_permission_mode("w", CHAT, AgentPermissionMode::Plan)
        .unwrap();
    h.wait_until("old process restarted away", || !alive(pid));
    h.send(CHAT, "after the switch");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 2);
    assert!(argv[1].contains("--permission-mode plan"), "{}", argv[1]);
    assert!(argv[1].contains(&format!("--resume {CHAT}")), "{}", argv[1]);
    assert!(
        !h.seen
            .iter()
            .any(|e| matches!(e.event, AgentEvent::SessionEnded { .. })),
        "a silent restart is invisible"
    );
}

#[test]
fn the_model_changes_live_when_the_cli_accepts_it() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    h.sessions
        .set_model("w", CHAT, Some("opus".into()), None)
        .unwrap();
    h.wait_until("request sent", || {
        h.log("stdin.log").contains("\"subtype\":\"set_model\"")
            && h.log("stdin.log").contains("\"model\":\"opus\"")
    });
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        h.lines("pids.log").len(),
        1,
        "no restart when the CLI said yes"
    );
}

#[test]
fn a_refused_model_restarts_with_resume_and_the_new_model() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.set_mode("mode-error");
    h.sessions
        .set_model("w", CHAT, Some("haiku".into()), None)
        .unwrap();
    h.wait_until("old process restarted away", || !alive(pid));
    h.send(CHAT, "after the switch");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 2);
    assert!(argv[1].contains("--model haiku"), "{}", argv[1]);
    assert!(argv[1].contains(&format!("--resume {CHAT}")), "{}", argv[1]);
    assert!(
        !h.seen
            .iter()
            .any(|e| matches!(e.event, AgentEvent::SessionEnded { .. })),
        "a silent restart is invisible"
    );
}

#[test]
fn a_model_restricted_by_the_org_is_dropped_not_retried() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    h.set_mode("model-restricted");
    h.sessions
        .set_model("w", CHAT, Some("opus".into()), None)
        .unwrap();
    let ev = h.next(CHAT, "model-refused", |e| {
        matches!(e, AgentEvent::ModelRefused { .. })
    });
    assert!(matches!(ev, AgentEvent::ModelRefused { requested, using }
        if requested.as_deref() == Some("opus") && using.as_deref() == Some("claude-haiku-5-5")));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        h.lines("pids.log").len(),
        1,
        "no restart for a policy refusal"
    );
    // a later respawn (forced by an effort change) uses the model the CLI kept, not the refused one
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.sessions
        .set_model(
            "w",
            CHAT,
            Some("claude-haiku-5-5".into()),
            Some(Effort::High),
        )
        .unwrap();
    h.wait_until("restarted", || !alive(pid));
    h.send(CHAT, "again");
    h.turn_finished(CHAT);
    let argv = h.lines("argv.log");
    assert!(argv[1].contains("--model claude-haiku-5-5"), "{}", argv[1]);
    assert!(!argv[1].contains("opus"), "{}", argv[1]);
}

#[test]
fn a_changed_effort_restarts_because_it_is_a_spawn_flag() {
    let mut h = Harness::new(&["ok-turn", "ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    let pid: i32 = h.lines("pids.log")[0].parse().unwrap();
    h.sessions
        .set_model("w", CHAT, None, Some(Effort::High))
        .unwrap();
    h.wait_until("old process restarted away", || !alive(pid));
    h.send(CHAT, "again");
    h.turn_finished(CHAT);
    assert!(h.lines("argv.log")[1].contains("--effort high"));
}

#[test]
fn a_model_with_a_flag_shape_is_rejected() {
    let h = Harness::new(&["ok-turn"], "normal");
    h.start(CHAT);
    assert!(h
        .sessions
        .set_model(
            "w",
            CHAT,
            Some("--dangerously-skip-permissions".into()),
            None
        )
        .is_err());
}

#[test]
fn unsupported_control_requests_get_an_error_response() {
    let mut h = Harness::new(&["ok-turn"], "unsupported");
    h.start(CHAT);
    h.send(CHAT, "x");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let stdin = h.log("stdin.log");
    let reply = stdin
        .lines()
        .find(|l| l.contains("control_response"))
        .expect("a reply");
    assert!(
        reply.contains("\"subtype\":\"error\"") && reply.contains("\"request_id\":\"h1\""),
        "{reply}"
    );
}

#[test]
fn idle_processes_end_quietly_and_the_next_message_resumes() {
    let mut t = test_timing();
    t.idle_after = Duration::from_millis(300);
    let mut h = Harness::with_timing(&["ok-turn", "ok-turn"], "normal", t);
    h.start(CHAT);
    h.send(CHAT, "x");
    h.turn_finished(CHAT);
    h.wait_until("idle kill", || h.sessions.live_count("w") == 0);
    h.drain();
    assert!(
        !h.seen.iter().any(|e| matches!(
            e.event,
            AgentEvent::SessionEnded { .. } | AgentEvent::Error { .. }
        )),
        "quiet"
    );
    assert_eq!(
        h.sessions.get("w", CHAT).unwrap().state(),
        AgentSessionState::Idle
    );
    h.send(CHAT, "welcome back");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let argv = h.lines("argv.log");
    assert_eq!(argv.len(), 2);
    assert!(argv[1].contains(&format!("--resume {CHAT}")));
}

#[test]
fn chats_belong_to_their_window_and_context_paths_stay_in_the_vault() {
    let h = Harness::new(&["ok-turn"], "normal");
    h.start(CHAT);
    assert!(h
        .sessions
        .send("other-window", CHAT, "x".into(), &[])
        .is_err());
    assert!(h.sessions.cancel("other-window", CHAT).is_err());
    assert!(h
        .sessions
        .start(
            h.params(CHAT, "other-window", None),
            &Ask::new(Decision::Once)
        )
        .is_err());
    let outside = [ContextRef::Note {
        path: "../secrets.md".into(),
    }];
    assert!(h.sessions.send("w", CHAT, "x".into(), &outside).is_err());
    assert!(h.lines("stdin.log").is_empty());
    assert!(h
        .sessions
        .start(h.params("not-a-uuid", "w", None), &Ask::new(Decision::Once))
        .is_err());
    let mut p = h.params("22222222-2222-4222-8222-222222222222", "w", None);
    p.request.resume_session_id = Some("--evil".into());
    assert!(h.sessions.start(p, &Ask::new(Decision::Once)).is_err());
}

struct Proj {
    seen: Mutex<Vec<(InjectAgentsMd, Option<String>, PathBuf)>>,
    touched: Mutex<Vec<String>>,
}

impl ProjectPort for Proj {
    fn resolve_cwd(&self, root: &Path, project: Option<&str>) -> Result<PathBuf, String> {
        super::ports::DefaultProject.resolve_cwd(root, project)
    }
    fn append_system_prompt(&self, ctx: &SpawnContext<'_>) -> Result<Option<String>, String> {
        self.seen.lock().push((
            ctx.inject_agents_md,
            ctx.cli_version.map(String::from),
            ctx.cwd.to_path_buf(),
        ));
        Ok(Some("PROJECT-PROMPT".into()))
    }
    fn project_permission_mode(
        &self,
        _root: &Path,
        _p: Option<&str>,
    ) -> Option<AgentPermissionMode> {
        Some(AgentPermissionMode::AcceptEdits)
    }
    fn touch_last_used(&self, _root: &Path, project: &str) {
        self.touched.lock().push(project.into());
    }
}

#[test]
fn project_chats_use_the_project_cwd_prompt_and_mode_through_the_port() {
    let h = Harness::new(&["ok-turn"], "normal");
    std::fs::create_dir_all(h.root.join("Projects/Demo")).unwrap();
    let proj = Arc::new(Proj {
        seen: Mutex::new(vec![]),
        touched: Mutex::new(vec![]),
    });
    h.sessions.ports().set_project(proj.clone());
    let mut p = h.params(CHAT, "w", Some("Projects/Demo"));
    p.inject_agents_md = InjectAgentsMd::Always;
    h.sessions.start(p, &Ask::new(Decision::Once)).unwrap();
    h.wait_until("process", || !h.lines("argv.log").is_empty());

    let seen = proj.seen.lock().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, InjectAgentsMd::Always);
    assert_eq!(seen[0].1.as_deref(), Some("2.1.325"));
    let cwd = h.root.join("Projects/Demo");
    assert_eq!(seen[0].2, cwd);
    assert_eq!(h.lines("cwd.log"), vec![cwd.to_string_lossy().to_string()]);
    let argv = &h.lines("argv.log")[0];
    assert!(
        argv.contains("--append-system-prompt PROJECT-PROMPT"),
        "{argv}"
    );
    assert!(
        argv.contains(&format!("--add-dir {}", h.root.display())),
        "{argv}"
    );
    assert!(argv.contains("--permission-mode acceptEdits"), "{argv}");
    assert_eq!(
        proj.touched.lock().clone(),
        vec!["Projects/Demo".to_string()]
    );

    // a project path that escapes the vault is refused before anything starts
    let bad = h.params(
        "33333333-3333-4333-8333-333333333333",
        "w",
        Some("../elsewhere"),
    );
    assert!(h.sessions.start(bad, &Ask::new(Decision::Once)).is_err());
}

#[test]
fn detect_reports_version_and_sign_in_state_of_the_override() {
    let h = Harness::new(&["ok-turn"], "normal");
    let info = super::binary::detect(Some(h.fake.to_str().unwrap()));
    assert!(info.found);
    assert_eq!(info.version.as_deref(), Some("2.1.325"));
    assert_eq!(info.authenticated, Some(true));
    assert_eq!(info.account.as_deref(), Some("claude.ai, pro"));
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(v["authenticated"], true);
    assert!(
        h.lines("pids.log").is_empty(),
        "probes are not chat processes"
    );
}

#[test]
fn a_turn_that_edits_a_vault_file_ends_with_a_turn_changes_event_and_undo_works() {
    let mut h = Harness::new(&["permission-allow"], "normal");
    // the captured Write + Bash turn, pointed at a real file of the harness vault
    let derived = std::fs::read_to_string(fixture("permission-allow"))
        .unwrap()
        .replace(
            "/vault/Projects/Demo/notes.txt",
            &h.root.join("notes.txt").to_string_lossy(),
        );
    std::fs::write(h.fdir.join("derived.jsonl"), derived).unwrap();
    std::fs::write(
        h.fdir.join("turns.txt"),
        format!("{}\n", h.fdir.join("derived.jsonl").display()),
    )
    .unwrap();
    let notes = h.root.join("notes.txt");
    std::fs::write(&notes, "old\nline\n").unwrap();

    h.start(CHAT);
    h.send(CHAT, "write it");
    let ask = |h: &mut Harness| match h.next(CHAT, "permission-request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    }) {
        AgentEvent::PermissionRequest {
            request_id, tool, ..
        } => (request_id, tool),
        _ => unreachable!(),
    };
    let (id, tool) = ask(&mut h);
    assert_eq!(tool, "Write");
    // the snapshot is taken as the request is seen; the (fake) tool only runs after the answer
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&notes, "new\nline\nadded\n").unwrap();
    let allow = |h: &Harness, id: &str| {
        h.sessions
            .permission("w", CHAT, id, PermissionDecision::Allow, None, None)
            .unwrap()
    };
    allow(&h, &id);
    let (id2, tool2) = ask(&mut h);
    assert_eq!(tool2, "Bash");
    allow(&h, &id2);

    let summary = match h.next(CHAT, "turn-changes", |e| {
        matches!(e, AgentEvent::TurnChanges(_))
    }) {
        AgentEvent::TurnChanges(s) => s,
        _ => unreachable!(),
    };
    assert!(summary.bash, "a Bash call ran in the turn");
    assert_eq!(summary.files.len(), 1);
    let f = &summary.files[0];
    assert_eq!(f.path, "notes.txt");
    assert_eq!(f.status, ChangeStatus::Modified);
    assert_eq!((f.added, f.removed), (2, 1));

    let seq_of = |h: &Harness, pred: fn(&AgentEvent) -> bool| {
        h.seen
            .iter()
            .find(|e| pred(&e.event))
            .map(|e| e.seq)
            .unwrap()
    };
    assert!(
        seq_of(&h, |e| matches!(e, AgentEvent::TurnFinished { .. }))
            < seq_of(&h, |e| matches!(e, AgentEvent::TurnChanges(_))),
        "turn-changes follows turn-finished"
    );

    let changes = h.sessions.changes();
    let detail = changes.detail(CHAT, &summary.turn_id, &h.root).unwrap();
    assert_eq!(detail.files[0].undo, UndoState::Available);
    let out = changes
        .revert(CHAT, &summary.turn_id, &h.root, &["notes.txt".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "old\nline\n");
}

#[test]
fn a_read_only_turn_sends_no_turn_changes() {
    let mut h = Harness::new(&["ok-turn"], "normal");
    h.start(CHAT);
    h.send(CHAT, "hi");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    h.drain();
    assert!(!h
        .seen
        .iter()
        .any(|e| matches!(e.event, AgentEvent::TurnChanges(_))));
}

#[test]
fn orchestration_passes_the_agents_flag_only_when_on() {
    for (orchestrate, cheap) in [(true, Some("sonnet")), (false, None)] {
        let h = Harness::new(&["ok-turn"], "normal");
        let mut p = h.params(CHAT, "w", None);
        p.request.settings.orchestrate = orchestrate;
        if let Some(m) = cheap {
            p.request
                .settings
                .tier_models
                .insert("cheap".into(), Some(m.into()));
        }
        h.sessions.start(p, &Ask::new(Decision::Once)).unwrap();
        h.wait_until("process", || !h.lines("argv.log").is_empty());
        let argv = &h.lines("argv.log")[0];
        assert_eq!(argv.contains("--agents"), orchestrate, "{argv}");
        if orchestrate {
            assert!(argv.contains("writer-explorer"), "{argv}");
            assert!(argv.contains("writer-worker"), "{argv}");
            assert!(argv.contains(r#""model":"sonnet""#), "{argv}");
        }
    }
}

// ---- sub-agent edits and the Changes card (ADR "Define agent roles once ...", item 5) ----

fn turn_changes(h: &mut Harness) -> TurnChangesSummary {
    match h.next(CHAT, "turn-changes", |e| {
        matches!(e, AgentEvent::TurnChanges(_))
    }) {
        AgentEvent::TurnChanges(s) => s,
        _ => unreachable!(),
    }
}

/// Item 5a and 5c: a sub-agent's edit (`parentToolCallId` set, no permission request) is
/// snapshotted when its input is seen, before the (fake) tool runs, and the card entry carries the
/// role of the `Agent` call's `subagent_type`.
#[test]
fn a_sub_agent_edit_is_snapshotted_before_it_runs_and_attributed_to_its_role() {
    let mut h = Harness::new(&["subagent-edit"], "normal");
    let notes = h.root.join("notes.txt");
    std::fs::write(&notes, "old\nline\n").unwrap();
    h.use_fixture_for("subagent-edit", &notes);
    h.start(CHAT);
    h.send(CHAT, "edit it");
    let parent = match h.next(
        CHAT,
        "the sub-agent's Write",
        |e| matches!(e, AgentEvent::ToolCallStarted { tool, .. } if tool == "Write"),
    ) {
        AgentEvent::ToolCallStarted {
            parent_tool_call_id,
            ..
        } => parent_tool_call_id,
        _ => unreachable!(),
    };
    assert_eq!(parent.as_deref(), Some("toolu_agent1"));
    h.next(CHAT, "its complete input", |e| {
        matches!(e, AgentEvent::ToolCallInput { tool_call_id, .. } if tool_call_id == "toolu_write1")
    });
    // the fake waits at its pause, as the CLI does while the tool runs: the pre-image is already
    // taken. Only now does the "tool" change the file.
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&notes, "new\nline\nadded\n").unwrap();
    h.go();

    let summary = turn_changes(&mut h);
    assert_eq!(summary.files.len(), 1);
    let f = &summary.files[0];
    assert_eq!(f.status, ChangeStatus::Modified);
    assert_eq!((f.added, f.removed), (2, 1), "diffed against the OLD text");
    assert_eq!(f.by.as_deref(), Some("worker"));
    let changes = h.sessions.changes();
    let out = changes
        .revert(CHAT, &summary.turn_id, &h.root, &["notes.txt".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "old\nline\n");
}

/// Item 5b: the first `result` arrives while a background sub-agent still works (its task is
/// listed); the card stays open, the late edit joins it, and it is sent once the sub-agent's
/// notification and the second `result` have come.
#[test]
fn the_card_stays_open_while_a_sub_agent_works_so_late_edits_land_on_it() {
    let mut h = Harness::new(&["subagent-background"], "normal");
    let notes = h.root.join("notes.txt");
    std::fs::write(&notes, "old\nline\n").unwrap();
    h.use_fixture_for("subagent-background", &notes);
    h.start(CHAT);
    h.send(CHAT, "edit it in the background");
    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    h.drain();
    assert!(
        !h.seen
            .iter()
            .any(|e| matches!(e.event, AgentEvent::TurnChanges(_))),
        "no card yet: the sub-agent still works"
    );
    // the sub-agent's edit comes after the first result
    h.go();
    h.next(CHAT, "the late edit's input", |e| {
        matches!(e, AgentEvent::ToolCallInput { tool_call_id, .. } if tool_call_id == "toolu_write1")
    });
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&notes, "new\nline\nadded\n").unwrap();
    h.go();

    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let summary = turn_changes(&mut h);
    assert_eq!(summary.files.len(), 1);
    assert_eq!(summary.files[0].path, "notes.txt");
    assert_eq!(summary.files[0].by.as_deref(), Some("worker"));
    assert_eq!((summary.files[0].added, summary.files[0].removed), (2, 1));
    // exactly one card for the turn
    h.drain();
    assert_eq!(
        h.seen
            .iter()
            .filter(|e| matches!(e.event, AgentEvent::TurnChanges(_)))
            .count(),
        1
    );
}

/// Item 5d: in manual mode the sub-agent's edit raises a permission card that says who asks and
/// that the user can answer; the answer reaches the CLI and the edit lands on the card.
#[test]
fn a_manual_mode_sub_agent_permission_card_is_attributed_and_answerable() {
    let mut h = Harness::new(&["subagent-permission"], "normal");
    let notes = h.root.join("notes.txt");
    std::fs::write(&notes, "old\nline\n").unwrap();
    h.use_fixture_for("subagent-permission", &notes);
    h.start(CHAT);
    h.send(CHAT, "edit it");
    let (request_id, tool_call_id, by) = match h.next(CHAT, "permission-request", |e| {
        matches!(e, AgentEvent::PermissionRequest { .. })
    }) {
        AgentEvent::PermissionRequest {
            request_id,
            tool_call_id,
            by,
            ..
        } => (request_id, tool_call_id, by),
        _ => unreachable!(),
    };
    assert_eq!(tool_call_id.as_deref(), Some("toolu_write1"));
    assert_eq!(by.as_deref(), Some("worker"), "the card says who asks");
    // nothing has run: the pre-image is taken as the request is seen
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&notes, "new\nline\nadded\n").unwrap();
    h.sessions
        .permission(
            "w",
            CHAT,
            &request_id,
            PermissionDecision::Allow,
            None,
            None,
        )
        .unwrap();
    wait_for_answer(&h);

    assert_eq!(h.turn_finished(CHAT), TurnFinishReason::Completed);
    let summary = turn_changes(&mut h);
    assert_eq!(summary.files[0].by.as_deref(), Some("worker"));
    assert_eq!(summary.files[0].status, ChangeStatus::Modified);
}

/// The answer was written to the CLI's stdin: an allow response for the request.
fn wait_for_answer(h: &Harness) {
    h.wait_until("the permission answer reaches the CLI", || {
        h.log("stdin.log").contains("\"behavior\":\"allow\"")
    });
}

/// A main-agent edit has no role.
#[test]
fn a_main_agent_edit_carries_no_role() {
    let mut h = Harness::new(&["permission-allow"], "normal");
    let derived = std::fs::read_to_string(fixture("permission-allow"))
        .unwrap()
        .replace(
            "/vault/Projects/Demo/notes.txt",
            &h.root.join("notes.txt").to_string_lossy(),
        );
    std::fs::write(h.fdir.join("derived.jsonl"), derived).unwrap();
    std::fs::write(
        h.fdir.join("turns.txt"),
        format!("{}\n", h.fdir.join("derived.jsonl").display()),
    )
    .unwrap();
    std::fs::write(h.root.join("notes.txt"), "old\n").unwrap();
    h.start(CHAT);
    h.send(CHAT, "write it");
    for _ in 0..2 {
        let id = match h.next(CHAT, "permission-request", |e| {
            matches!(e, AgentEvent::PermissionRequest { .. })
        }) {
            AgentEvent::PermissionRequest { request_id, by, .. } => {
                assert_eq!(by, None);
                request_id
            }
            _ => unreachable!(),
        };
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(h.root.join("notes.txt"), "new\n").unwrap();
        h.sessions
            .permission("w", CHAT, &id, PermissionDecision::Allow, None, None)
            .unwrap();
    }
    assert_eq!(turn_changes(&mut h).files[0].by, None);
}
