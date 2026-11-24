//! The OpenCode transport against the fake server: what each `Transport` call does on the wire,
//! what the chat gets back, and how a crash, a dropped stream and a refused call end.

use super::fake_server_tests::*;
use super::modes::ModePolicy;
use super::opencode_api::{message_id_for, receipt_for, ModelRef};
use super::server::Process;
use super::server_tests::{harness, Harness};
use super::transport::*;
use crate::agent::events::*;
use crate::agent::files::{FileKind, FilePart};
use crate::agent::transport::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The real policy of the proposal (spec 10.9), over the real tool table.
fn policy(root: &std::path::Path) -> Arc<ModePolicy> {
    Arc::new(ModePolicy::new(super::events_tests::table()).for_vault(root.to_path_buf()))
}

fn settings(mode: AgentPermissionMode) -> AgentSettings {
    AgentSettings {
        binary_path: None,
        model: None,
        effort: None,
        permission_mode: mode,
        allowed_tools: vec![],
        disallowed_tools: vec![],
        orchestrate: false,
        show_thinking: false,
        auto_reload: true,
        memory: AgentMemory::Default,
        tier_models: Default::default(),
    }
}

pub(super) fn launch(mode: AgentPermissionMode) -> LaunchConfig {
    LaunchConfig {
        program: None,
        cli_version: None,
        system_prompt: Some("WRITER".into()),
        add_dirs: vec![],
        agents: None,
        cli_dir: None,
        memory_dir: None,
        mcp: None,
        settings: settings(mode),
        restart_on_config_change: false,
    }
}

struct Rig {
    h: Harness,
    t: OpencodeTransport,
    rx: Receiver<Inbound>,
    log: Mutex<Vec<Inbound>>,
    cwd: std::path::PathBuf,
}

impl Rig {
    fn new(version: &str) -> Rig {
        Rig::with(version, |_| {})
    }

    /// `setup` configures the fake launcher before any process exists: nothing is raced.
    fn with(version: &str, setup: impl FnOnce(&FakeLauncher)) -> Rig {
        Rig::build(version, setup, policy)
    }

    fn build(
        version: &str,
        setup: impl FnOnce(&FakeLauncher),
        policy: impl FnOnce(&std::path::Path) -> Arc<ModePolicy>,
    ) -> Rig {
        let h = harness(version);
        setup(&h.launcher);
        let policy = policy(&h.dir.path().canonicalize().unwrap());
        let (tx, rx) = channel();
        let root = h.dir.path().canonicalize().unwrap();
        let cwd = root.join("project");
        let t = OpencodeTransport::new(
            TransportInit {
                procs: Arc::default(),
                label: "t".into(),
                root: root.clone(),
                cwd: cwd.clone(),
                project_path: None,
                spawner: crate::features::scope::Spawner::detached(),
                inbound: tx,
            },
            Arc::clone(&h.server),
            policy,
        );
        Rig {
            h,
            t,
            rx,
            log: Mutex::new(Vec::new()),
            cwd,
        }
    }

    fn start(&self, gen: u64, resume: bool, session: &str) -> Result<(), SpawnError> {
        self.start_in(gen, resume, session, AgentPermissionMode::Manual)
    }

    fn start_in(
        &self,
        gen: u64,
        resume: bool,
        session: &str,
        mode: AgentPermissionMode,
    ) -> Result<(), SpawnError> {
        let l = launch(mode);
        self.t.start(&StartRequest {
            gen,
            session_id: session,
            resume,
            launch: &l,
        })
    }

    fn fake(&self) -> Arc<FakeServer> {
        Arc::clone(&self.h.launcher.current().server)
    }

    fn pull(&self) {
        while let Ok(m) = self.rx.try_recv() {
            self.log.lock().push(m);
        }
    }

    /// Polls the chat's inbound messages until `pred` holds.
    fn until(&self, what: &str, pred: impl Fn(&[Inbound]) -> bool) {
        wait_for(what, 10, || {
            self.pull();
            pred(&self.log.lock())
        });
    }

    fn events(&self) -> Vec<AgentEvent> {
        self.pull();
        self.log
            .lock()
            .iter()
            .filter_map(|i| match &i.message {
                Message::Mapped(m) => Some(m.events.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn ended(&self) -> usize {
        self.pull();
        self.log
            .lock()
            .iter()
            .filter(|i| matches!(i.message, Message::Ended(_)))
            .count()
    }

    /// A first message: the session is made and the prompt posted.
    fn first_message(&self) -> Receipt {
        self.first_message_in(AgentPermissionMode::Manual)
    }

    fn first_message_in(&self, mode: AgentPermissionMode) -> Receipt {
        self.start_in(1, false, "chat", mode).unwrap();
        let r = self.t.send(&Outbound {
            text: "hello",
            files: &[],
            delivery: Delivery::Start { receipt: &new_id() },
        });
        wait_for("the prompt", 10, || {
            !self.fake().find("POST", "/prompt").is_empty()
        });
        r
    }
}

/// A fresh receipt for a turn-starting message, as the `Session` makes one.
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// One event of a fixture, by type, as the stream would carry it.
fn emit_of(fake: &FakeServer, fixture: &str, kind: &str) -> Value {
    let (events, _) = super::events_tests::fixture(fixture);
    let e = events.iter().find(|e| e.kind == kind).unwrap();
    let v = json!({"id": e.id, "created": e.created, "type": e.kind, "data": e.data});
    fake.emit(&v.to_string());
    e.data.clone()
}

fn allow<'a>(
    input: &'a Value,
    persist: Option<PermissionPersist>,
    suggestions: &'a [Value],
) -> PermissionReply<'a> {
    PermissionReply::Allow {
        input,
        persist,
        rules: None,
        suggestions,
    }
}

fn count(events: &[AgentEvent], f: impl Fn(&AgentEvent) -> bool) -> usize {
    events.iter().filter(|e| f(e)).count()
}

#[test]
fn the_first_send_makes_the_session_announces_it_and_posts_the_prompt_with_a_stable_id() {
    // the recorded list, `opencode_console` needs_auth included: a server that is not running
    // offers no tools, so it passes the gate
    let r = Rig::with("2.4.0", |l| {
        let all: Value = serde_json::from_str(
            &std::fs::read_to_string(super::events_tests::fixtures_dir().join("rest.json"))
                .unwrap(),
        )
        .unwrap();
        *l.mcp_reply.lock() = Some(all["mcp"]["body"].clone());
    });
    r.start(1, false, "chat").unwrap();
    let id = new_id();
    let receipt = r.t.send(&Outbound {
        text: "hello",
        files: &[],
        delivery: Delivery::Start { receipt: &id },
    });
    assert_eq!(receipt.message_id, id);
    assert_eq!(receipt.backend_id, message_id_for(&id));
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let log = r.fake().log();
    let at = |needle: &str| log.iter().position(|l| l.contains(needle)).unwrap();
    assert!(at("POST /api/session") < at("instructions/entries/writer"));
    assert!(at("instructions/entries/writer") < at("/prompt"));
    // the mode's rules (none outside of Plan: an empty list) are on the session before any prompt
    assert!(at("PATCH") < at("instructions/entries/writer"));
    assert_eq!(r.fake().find("PATCH", "")[0].body["permissions"], json!([]));
    let create = &r.fake().find("POST", "/api/session")[0].body;
    assert_eq!(
        create["location"]["directory"],
        r.cwd.to_string_lossy().as_ref()
    );
    // Writer never picks a model here: a blank one is resolved before the start (the web's one
    // resolver), so none is sent and the server keeps its own
    assert!(create["model"].is_null());
    assert!(
        create.get("permissions").is_none(),
        "no rules outside of Plan"
    );
    assert_eq!(create["agent"], "writer");
    assert_eq!(
        r.fake().find("PUT", "/instructions/entries/writer")[0].body["value"],
        "WRITER"
    );
    let prompt = &r.fake().find("POST", "/prompt")[0].body;
    assert_eq!(prompt["id"], receipt.backend_id.as_str());
    assert_eq!(prompt["text"], "hello");
    assert!(prompt.get("delivery").is_none());
    r.until("started and announced", |l| {
        matches!(l[0].message, Message::Started { .. })
            && l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(
                e,
                AgentEvent::SessionStarted { session_id, slash_commands, skills, mcp_servers, cli_version, .. }
                    if session_id == SESSION
                        && slash_commands.contains(&"init".to_string())
                        && skills.len() == 4
                        && mcp_servers.iter().any(|m| m.name == "writer" && m.status == McpState::Connected)
                        && mcp_servers.iter().any(|m| m.status == McpState::NeedsAuth)
                        && cli_version.as_deref() == Some("2.4.0")
            ))))
    });
    assert!(r.log.lock().iter().all(|i| i.gen == 1));
}

#[test]
fn a_turn_the_server_streams_reaches_the_chat_as_neutral_events() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.replay("text");
    r.until("the turn", |l| {
        l.iter().any(|i| {
            matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(
                e,
                AgentEvent::TurnFinished { reason: TurnFinishReason::Completed, .. }
            )))
        })
    });
    let events = r.events();
    assert!(count(&events, |e| matches!(e, AgentEvent::TextDelta { .. })) > 0);
    assert_eq!(r.h.server.dropped(), 0);
}

#[test]
fn files_go_inline_in_the_prompt() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    let file = FilePart {
        kind: FileKind::Document,
        media_type: "application/pdf",
        data: "UERG".into(),
    };
    r.t.send(&Outbound {
        text: "read it",
        files: std::slice::from_ref(&file),
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let f = &r.fake().find("POST", "/prompt")[0].body["files"][0];
    assert_eq!(f["uri"], "data:application/pdf;base64,UERG");
    assert_eq!(f["source"]["type"], "inline");
}

#[test]
fn a_steer_is_a_steering_prompt_then_an_interrupt_that_resumes_it() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let receipt = uuid::Uuid::new_v4().to_string();
    let got = r.t.send(&Outbound {
        text: "change course",
        files: &[],
        delivery: Delivery::Steer { receipt: &receipt },
    });
    assert_eq!(got.message_id, receipt);
    assert_eq!(
        receipt_for(&got.backend_id).as_deref(),
        Some(receipt.as_str())
    );
    wait_for("the interrupt", 10, || {
        !r.fake().find("POST", "/interrupt").is_empty()
    });
    let log = r.fake().log();
    let prompt = log.iter().rposition(|l| l.ends_with("/prompt")).unwrap();
    let interrupt = log.iter().position(|l| l.ends_with("/interrupt")).unwrap();
    assert!(
        prompt < interrupt,
        "the steering input is queued before the step is cut: {log:?}"
    );
    assert_eq!(
        r.fake().find("POST", "/prompt")[1].body["delivery"],
        "steer"
    );
    assert_eq!(r.fake().find("POST", "/interrupt")[0].query, "resume=true");
}

#[test]
fn a_queued_message_waits_and_a_resend_is_the_same_item() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let receipt = uuid::Uuid::new_v4().to_string();
    for _ in 0..2 {
        r.t.send(&Outbound {
            text: "later",
            files: &[],
            delivery: Delivery::Queued { receipt: &receipt },
        });
    }
    wait_for("both prompts", 10, || {
        r.fake().find("POST", "/prompt").len() == 3
    });
    let prompts = r.fake().find("POST", "/prompt");
    assert_eq!(prompts[1].body["delivery"], "queue");
    assert_eq!(prompts[1].body["id"], message_id_for(&receipt).as_str());
    assert_eq!(prompts[1].body["id"], prompts[2].body["id"]);
    // the server counts the repeated id once
    let items = r.fake().shared.items.lock().clone();
    assert_eq!(items.len(), 2, "{items:?}");
}

#[test]
fn unqueue_waits_for_the_servers_event_and_says_unqueued_in_stream_order() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let receipt = uuid::Uuid::new_v4().to_string();
    r.t.send(&Outbound {
        text: "later",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    wait_for("the prompt", 10, || fake.find("POST", "/prompt").len() == 2);
    // the DELETE answers 204; `inbox.cancelled` is the confirmation
    assert_eq!(r.t.unqueue(&receipt, Duration::from_secs(5)), Ok(true));
    r.until("the confirmation", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Unqueued { receipt: x } if *x == receipt))
    });
    assert_eq!(fake.find("DELETE", &message_id_for(&receipt)).len(), 1);

    // an item the server delivered in the meantime: the DELETE is a no-op, `inbox.delivered`
    // answers, the message is not unqueued
    let taken = uuid::Uuid::new_v4().to_string();
    fake.shared.items.lock().push(message_id_for(&taken));
    fake.shared.taken.lock().insert(message_id_for(&taken));
    assert_eq!(r.t.unqueue(&taken, Duration::from_secs(5)), Ok(false));
    r.pull();
    assert!(!r
        .log
        .lock()
        .iter()
        .any(|i| matches!(&i.message, Message::Unqueued { receipt: x } if *x == taken)));
    // and a later try does not even ask: the server said so
    let before = fake.find("DELETE", "").len();
    assert_eq!(r.t.unqueue(&taken, Duration::from_secs(5)), Ok(false));
    assert_eq!(fake.find("DELETE", "").len(), before);
}

#[test]
fn a_late_answer_after_a_timeout_still_says_unqueued() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let receipt = uuid::Uuid::new_v4().to_string();
    r.t.send(&Outbound {
        text: "later",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    wait_for("the prompt", 10, || fake.find("POST", "/prompt").len() == 2);
    // the server does not say in time
    fake.shared
        .silent_inbox
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        r.t.unqueue(&receipt, Duration::from_millis(300)),
        Err(Unanswered)
    );
    r.pull();
    assert!(!r
        .log
        .lock()
        .iter()
        .any(|i| matches!(i.message, Message::Unqueued { .. })));
    // it says later: the message is gone, and the chat is told
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.inbox.cancelled",
            "data": {"sessionID": SESSION, "inboxID": message_id_for(&receipt)}})
        .to_string(),
    );
    r.until("the late unqueue", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Unqueued { receipt: x } if *x == receipt))
    });
}

#[test]
fn interrupt_close_and_reload_end_as_the_session_expects() {
    let r = Rig::new("2.4.0");
    r.first_message();
    r.t.interrupt();
    wait_for("the interrupt", 10, || {
        !r.fake().find("POST", "/interrupt").is_empty()
    });
    assert_eq!(r.fake().find("POST", "/interrupt")[0].query, "");
    r.t.reload();
    wait_for("the reload", 10, || {
        !r.fake().find("POST", "/api/location/reload").is_empty()
    });
    r.until("ended", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Ended(e) if e.code == Some(0)))
    });
    // a close after the end adds no second end for the generation: its interrupt still goes (the
    // request log is the marker that the worker ran it), the end does not
    let before = r.fake().find("POST", "/interrupt").len();
    r.t.close(Close::Terminate);
    wait_for("the close", 10, || {
        r.fake().find("POST", "/interrupt").len() > before
    });
    assert_eq!(r.ended(), 1);
}

#[test]
fn permission_answers_carry_what_opencode_needs() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let data = emit_of(&fake, "shell-reject", "permission.asked");
    let id = data["id"].as_str().unwrap().to_string();
    r.until("the request", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::PermissionRequest { .. }))))
    });
    let reply_path = format!("/permission/{id}/reply");
    let input = json!({});
    r.t.answer_permission(&id, allow(&input, None, &[]));
    let always = vec![
        json!({"type": "addRules", "behavior": "allow", "destination": "localSettings",
        "rules": [{"toolName": "shell", "ruleContent": "echo *"}]}),
    ];
    r.t.answer_permission(
        &id,
        allow(&input, Some(PermissionPersist::Project), &always),
    );
    r.t.answer_permission(
        &id,
        PermissionReply::Deny {
            message: "not that one",
        },
    );
    r.t.answer_permission(&id, PermissionReply::Deny { message: "  " });
    wait_for("the replies", 10, || {
        fake.find("POST", &reply_path).len() == 4
    });
    let bodies: Vec<Value> = fake
        .find("POST", &reply_path)
        .into_iter()
        .map(|q| q.body)
        .collect();
    assert_eq!(bodies[0], json!({"decision": "once"}));
    assert_eq!(bodies[1], json!({"decision": "always"}));
    assert_eq!(
        bodies[2],
        json!({"decision": "reject", "message": "not that one"})
    );
    assert_eq!(bodies[3]["decision"], "reject");
    assert!(
        !bodies[3]["message"].as_str().unwrap().is_empty(),
        "a reject always tells the model"
    );
}

fn asked_event(id: &str, session: &str, action: &str, resource: &str) -> String {
    json!({"id": "e", "created": 1, "type": "permission.asked", "data": {
        "id": id, "sessionID": session, "action": action, "resources": [resource], "save": [],
        "source": {"type": "tool", "messageID": "msg_fake0002", "id": "call-fake-0009"}}})
    .to_string()
}

#[test]
fn an_allow_for_this_chat_is_writers_own_never_an_opencode_session_rule() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let id = emit_of(&fake, "shell-reject", "permission.asked")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let input = json!({});
    let session = vec![
        json!({"type": "addRules", "behavior": "allow", "destination": "localSettings",
        "rules": [{"toolName": "shell", "ruleContent": "echo *"}]}),
    ];
    r.t.answer_permission(
        &id,
        allow(&input, Some(PermissionPersist::Session), &session),
    );
    wait_for("the reply", 10, || !fake.find("POST", "/reply").is_empty());
    assert_eq!(fake.find("POST", "/reply")[0].body["decision"], "once");
    // a later request that matches is answered by Writer, with no card; one that does not match,
    // and one of a sub-agent's session, are not
    let cards = |l: &[Inbound]| {
        l.iter()
            .map(|i| match &i.message {
                Message::Mapped(m) => m
                    .events
                    .iter()
                    .filter(|e| matches!(e, AgentEvent::PermissionRequest { .. }))
                    .count(),
                _ => 0,
            })
            .sum::<usize>()
    };
    r.pull();
    let before = cards(&r.log.lock());
    fake.emit(&asked_event("per_fake_a", SESSION, "shell", "echo hi"));
    wait_for("the auto reply", 10, || {
        fake.find("POST", "/permission/per_fake_a/reply").len() == 1
    });
    assert_eq!(
        fake.find("POST", "/permission/per_fake_a/reply")[0].body["decision"],
        "once"
    );
    fake.emit(&asked_event("per_fake_b", SESSION, "shell", "rm -rf x"));
    fake.emit(&asked_event("per_fake_c", "ses_child", "shell", "echo hi"));
    // the card of the one that does not match (the child's request is not this chat's to map)
    r.until("the card", |l| cards(l) == before + 1);
    // the session's rules are the mode's (empty) and were never given an allow
    assert!(
        fake.find("PATCH", "")
            .iter()
            .all(|q| q.body["permissions"] == json!([])),
        "no session-level allow"
    );
    assert_eq!(fake.find("POST", "/permission/per_fake_b/reply").len(), 0);
}

#[test]
fn under_accept_edits_writer_answers_the_chats_own_edits_and_nothing_else() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    r.t.set_permission_mode(AgentPermissionMode::AcceptEdits);
    wait_for("the mode", 10, || {
        fake.find("PATCH", "/api/session/ses_fake0001").len() == 2
    });
    fake.emit(&asked_event("per_fake_e", SESSION, "edit", "a.txt"));
    fake.emit(&asked_event("per_fake_s", SESSION, "shell", "ls"));
    wait_for("the edit answered", 10, || {
        fake.find("POST", "/permission/per_fake_e/reply").len() == 1
    });
    // a marker: the shell request is mapped (the card) after the edit one went through the task
    r.until("the shell card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::PermissionRequest { request_id, .. } if request_id == "per_fake_s"))))
    });
    assert!(fake.find("POST", "/permission/per_fake_s/reply").is_empty());
}

/// A chat in `mode`, its stream open and the mode on the session.
fn chat_in(mode: AgentPermissionMode) -> (Rig, Arc<FakeServer>) {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    r.t.set_permission_mode(mode);
    wait_for("the mode", 10, || {
        fake.find("PATCH", "/api/session/ses_fake0001").len() == 2
    });
    (r, fake)
}

/// A sub-agent session of the chat, named `agent`; `link` is the launch call that names it (its
/// events are held until then).
fn emit_sub(fake: &FakeServer, session: &str, agent: &str, link: Option<&str>) {
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.created",
            "data": {"sessionID": session, "parentID": SESSION, "agent": agent}})
        .to_string(),
    );
    if let Some(call) = link {
        fake.emit(
            &json!({"id": "e", "created": 1, "type": "session.tool.progress",
                "data": {"sessionID": SESSION, "id": call, "metadata": {"sessionID": session}}})
            .to_string(),
        );
    }
}

/// Is there a card for request `id` in the log (for `Rig::until`, which holds the log's lock)?
fn carded(log: &[Inbound], id: &str) -> bool {
    log.iter().any(|i| {
        matches!(&i.message, Message::Mapped(m) if m.events.iter().any(
        |e| matches!(e, AgentEvent::PermissionRequest { request_id, .. } if request_id == id)))
    })
}

fn has_card(r: &Rig, id: &str) -> bool {
    r.pull();
    carded(&r.log.lock(), id)
}

/// Everything emitted so far went through the chat's task: the chat's own shell request (a card
/// in every mode) comes back mapped, and the replies posted for what came before are in.
fn settle(r: &Rig, fake: &FakeServer) {
    fake.emit(&asked_event("per_marker", SESSION, "shell", "ls"));
    r.until("the marker", |l| carded(l, "per_marker"));
    r.t.interrupt();
    wait_for("the marker's round trip", 10, || {
        !fake.find("POST", "/interrupt").is_empty()
    });
}

fn replied(fake: &FakeServer, id: &str) -> bool {
    !fake
        .find("POST", &format!("/permission/{id}/reply"))
        .is_empty()
}

/// A chat in `mode` with a worker and an explorer of its own, and edit requests from them and from
/// a session the chat does not know. Returns the ids that got a reply.
fn sub_agent_edits(mode: AgentPermissionMode) -> Vec<&'static str> {
    let (r, fake) = chat_in(mode);
    emit_sub(&fake, "ses_worker", "writer-worker", Some("call_w"));
    emit_sub(&fake, "ses_explorer", "writer-explorer", Some("call_x"));
    let asks = [
        ("per_inside", "ses_worker", "a.md"),
        ("per_protected", "ses_worker", ".obsidian/app.json"),
        ("per_outside", "ses_worker", "../../outside.md"),
        ("per_explorer", "ses_explorer", "a.md"),
        // a session the chat does not know: another chat's, the server routes it elsewhere
        ("per_foreign", "ses_other_chat", "a.md"),
    ];
    for (id, session, resource) in asks {
        fake.emit(&asked_event(id, session, "edit", resource));
    }
    settle(&r, &fake);
    asks.iter()
        .map(|a| a.0)
        .filter(|id| replied(&fake, id))
        .collect()
}

#[test]
fn under_accept_edits_a_workers_confined_edit_is_answered_once_and_no_other_sub_agent_request() {
    // inside the vault: answered; outside it, an explorer's, another chat's: left to a card
    assert_eq!(
        sub_agent_edits(AgentPermissionMode::AcceptEdits),
        vec!["per_inside"]
    );
}

/// The Changes capture reads the file when the runner sees the edit's tool call (its input or its
/// request), so an answered request must not skip that: the worker's tool events are mapped, as
/// the worker's (`parent_tool_call_id`), before the reply is posted (the runner captures on
/// `ToolCallInput`).
#[test]
fn a_workers_answered_edit_still_reaches_the_changes_capture_before_the_reply() {
    let (r, fake) = chat_in(AgentPermissionMode::AcceptEdits);
    emit_sub(&fake, "ses_worker", "writer-worker", Some("call_w"));
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.tool.input.started",
            "data": {"sessionID": "ses_worker", "assistantMessageID": "msg_w", "id": "call_edit", "name": "edit"}})
        .to_string(),
    );
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.tool.called",
            "data": {"sessionID": "ses_worker", "id": "call_edit",
                "input": {"filePath": "a.md", "oldString": "x", "newString": "y"}}})
        .to_string(),
    );
    fake.emit(&asked_event("per_w", "ses_worker", "edit", "a.md"));
    wait_for("the edit answered", 10, || replied(&fake, "per_w"));
    // the reply is posted after the earlier events were pushed to the chat: they are all there
    let events = r.events();
    assert!(events.iter().any(|e| matches!(e,
        AgentEvent::ToolCallStarted { tool_call_id, parent_tool_call_id: Some(parent), .. }
            if tool_call_id == "call_edit" && parent == "call_w")));
    assert!(events.iter().any(
        |e| matches!(e, AgentEvent::ToolCallInput { tool_call_id, .. } if tool_call_id == "call_edit")
    ));
}

#[test]
fn a_worker_not_yet_linked_to_its_launch_call_is_left_to_the_card() {
    let (r, fake) = chat_in(AgentPermissionMode::AcceptEdits);
    emit_sub(&fake, "ses_worker", "writer-worker", None);
    fake.emit(&asked_event("per_w", "ses_worker", "edit", "a.md"));
    settle(&r, &fake);
    assert!(!replied(&fake, "per_w") && !has_card(&r, "per_w"), "held");
    // the link releases the request: it is a card then, and still not answered
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.tool.progress",
            "data": {"sessionID": SESSION, "id": "call_w", "metadata": {"sessionID": "ses_worker"}}})
        .to_string(),
    );
    r.until("the card", |l| carded(l, "per_w"));
    assert!(!replied(&fake, "per_w"));
}

#[test]
fn in_manual_and_plan_a_sub_agents_edit_is_never_answered() {
    for mode in [AgentPermissionMode::Manual, AgentPermissionMode::Plan] {
        assert!(sub_agent_edits(mode).is_empty(), "{mode:?}");
    }
}

#[test]
fn the_glob_of_a_kept_rule_matches_like_a_prefix_pattern() {
    use super::transport::glob;
    assert!(
        glob("echo *", "echo hi")
            && glob("*", "anything")
            && glob("a*c", "abc")
            && glob("a.txt", "a.txt")
    );
    assert!(!glob("echo *", "ls") && !glob("a.txt", "a.txt.bak") && !glob("a*c", "abd"));
}

#[test]
fn replying_to_a_request_a_reject_already_settled_is_not_an_error() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let id = emit_of(&fake, "shell-reject", "permission.asked")["id"]
        .as_str()
        .unwrap()
        .to_string();
    fake.shared.gone.lock().insert(id.clone());
    r.t.answer_permission(&id, PermissionReply::Deny { message: "no" });
    wait_for("the reply", 10, || !fake.find("POST", "/reply").is_empty());
    // a marker behind the reply in the worker's queue: once it ran, the reply's outcome is in
    r.t.interrupt();
    wait_for("the marker", 10, || {
        !fake.find("POST", "/interrupt").is_empty()
    });
    assert_eq!(
        count(&r.events(), |e| matches!(e, AgentEvent::Error { .. })),
        0
    );
}

#[test]
fn questions_are_answered_by_field_and_skipped_with_a_message() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    assert!(
        !r.t.answer_question("frm_unknown", None),
        "an unknown question is not ours"
    );
    let form = emit_of(&fake, "question", "form.created")["form"].clone();
    let id = form["id"].as_str().unwrap().to_string();
    r.until("the card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::QuestionRequest { .. }))))
    });
    let answers = [QuestionAnswer {
        question: "Which fruit do you prefer?".into(),
        answers: vec!["Pear".into()],
    }];
    assert!(r.t.answer_question(&id, Some(&answers)));
    wait_for("the reply", 10, || {
        !fake.find("POST", &format!("/form/{id}/reply")).is_empty()
    });
    assert_eq!(
        fake.find("POST", &format!("/form/{id}/reply"))[0].body,
        json!({"answer": {"q0": "Pear"}})
    );

    // the fixtures share their form id: tell the replies apart by their order
    let multi = emit_of(&fake, "question-multi", "form.created")["form"].clone();
    let mid = multi["id"].as_str().unwrap().to_string();
    r.until("the multi card", |l| {
        l.iter()
            .filter(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::QuestionRequest { .. }))))
            .count()
            == 2
    });
    let q = multi["fields"][0]["description"]
        .as_str()
        .unwrap()
        .to_string();
    let many = [QuestionAnswer {
        question: q,
        answers: vec!["apple".into(), "plum".into()],
    }];
    assert!(r.t.answer_question(&mid, Some(&many)));
    wait_for("the multi reply", 10, || {
        fake.find("POST", &format!("/form/{mid}/reply")).len() == 2
    });
    assert_eq!(
        fake.find("POST", &format!("/form/{mid}/reply"))[1].body,
        json!({"answer": {"q0": ["apple", "plum"]}})
    );

    // a skip is a delete that tells the asker, so the turn goes on
    let skip = emit_of(&fake, "question-skip", "form.created")["form"].clone();
    let sid = skip["id"].as_str().unwrap().to_string();
    r.until("the skip card", |l| {
        l.iter()
            .filter(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::QuestionRequest { .. }))))
            .count()
            == 3
    });
    assert!(r.t.answer_question(&sid, None));
    wait_for("the skip", 10, || {
        !fake.find("DELETE", &format!("/form/{sid}")).is_empty()
    });
    assert!(fake.find("DELETE", &format!("/form/{sid}"))[0]
        .query
        .starts_with("message="));
}

#[test]
fn a_sub_agents_events_reach_the_chat_and_in_plan_its_session_gets_the_plan_rules() {
    let r = Rig::new("2.4.0");
    r.first_message_in(AgentPermissionMode::Plan);
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.replay("subagent");
    r.until("the sub-agent", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Mapped(m) if !m.tasks.is_empty()))
    });
    r.until("the end of the turn", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { .. }))))
    });
    assert_eq!(r.h.server.dropped(), 0, "no event of a sub-agent was lost");
    // a child's own calls are read from its message list after it is linked, so they can come
    // after the end of the main turn: wait for them, never assume the order
    r.until("a call of the sub-agent", |l| {
        l.iter().any(|i| {
            matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(
                e,
                AgentEvent::ToolCallStarted { parent_tool_call_id: Some(_), .. }
            )))
        })
    });
    // the child's rules were set when it was created, before anything it did could run
    wait_for("the child patch", 10, || {
        fake.find("PATCH", "")
            .iter()
            .any(|q| q.path != "/api/session/ses_fake0001")
    });
    let patch = fake
        .find("PATCH", "")
        .into_iter()
        .find(|q| q.path != "/api/session/ses_fake0001")
        .unwrap();
    assert_eq!(patch.body["permissions"][0]["effect"], "deny");
}

#[test]
fn a_dropped_stream_is_reconciled_from_the_message_list_without_repeats() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    // the first half of a turn, then the stream breaks and the rest is only in the list
    fake.replay_where("tool-search", |v| {
        !matches!(
            v["type"].as_str(),
            Some(
                "session.tool.success"
                    | "session.step.ended"
                    | "session.execution.succeeded"
                    | "session.text.delta"
                    | "session.text.ended"
                    | "session.text.started"
            )
        )
    });
    r.until("the first half", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::ToolCallStarted { .. }))))
    });
    fake.serve_messages_of("tool-search");
    fake.drop_streams();
    wait_for("the list read", 10, || {
        !fake.find("GET", "/message").is_empty()
    });
    r.until("the rest", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::ToolCallFinished { .. }))))
    });
    let finished =
        |ev: &[AgentEvent]| count(ev, |e| matches!(e, AgentEvent::ToolCallFinished { .. }));
    let once = finished(&r.events());
    // a second break adds nothing the chat has
    fake.drop_streams();
    wait_for("a second read", 10, || {
        fake.find("GET", "/message").len() >= 2
    });
    // a marker event on the new stream: the events task handles it after the resync
    wait_for("the third stream", 10, || fake.streams() == 3);
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.text.delta",
            "data": {"sessionID": SESSION, "assistantMessageID": "msg_marker", "ordinal": 0, "delta": "m"}})
        .to_string(),
    );
    r.until("the marker", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TextDelta { message_id, .. } if message_id == "msg_marker"))))
    });
    assert_eq!(finished(&r.events()), once);
}

#[test]
fn a_crash_ends_the_generation_once_and_the_resume_sends_the_same_message_id() {
    let r = Rig::new("2.4.0");
    let receipt = uuid::Uuid::new_v4().to_string();
    r.start(1, false, "chat").unwrap();
    r.t.send(&Outbound {
        text: "work",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let first_id = r.fake().find("POST", "/prompt")[0].body["id"].clone();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    r.h.launcher.current().crash(9);
    r.until("the end", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Ended(_)))
    });
    assert!(r.h.server.connection().is_none());
    assert_eq!(r.ended(), 1, "exactly one end for the generation");
    assert!(r.log.lock().iter().all(|i| i.gen == 1));

    // the Session starts again, resuming the session it learned, and sends the pending message
    r.start(2, true, SESSION).unwrap();
    r.t.send(&Outbound {
        text: "work",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    let second = r.fake();
    assert_eq!(r.h.launcher.launches(), 2);
    // the resumed chat reads what the server holds first, and the re-send of an id it holds is
    // not posted again: one delivery over the restart
    r.until("announced again", |l| {
        l.iter().any(|i| i.gen == 2 && matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::SessionStarted { .. }))))
    });
    wait_for("the inbox read", 10, || {
        !second.find("GET", "/inbox").is_empty()
    });
    // a marker behind the re-send in the worker's queue: when it ran, so did the send
    r.t.interrupt();
    wait_for("the marker", 10, || {
        !second.find("POST", "/interrupt").is_empty()
    });
    assert!(
        second.find("POST", "/prompt").is_empty(),
        "the held id is not posted again"
    );
    assert_eq!(
        r.h.launcher.items.lock().as_slice(),
        [first_id.as_str().unwrap()]
    );
    // and by now (the whole second generation has gone through the worker) still one end of the first
    assert_eq!(
        r.log
            .lock()
            .iter()
            .filter(|i| i.gen == 1 && matches!(i.message, Message::Ended(_)))
            .count(),
        1
    );
    // the resumed chat is announced again and the list read
    r.until("announced again", |l| {
        l.iter().any(|i| i.gen == 2 && matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::SessionStarted { .. }))))
    });
    assert!(!second.find("GET", "/message").is_empty());
}

#[test]
fn a_command_of_an_ended_generation_is_dropped_and_the_next_start_makes_the_session() {
    let r = Rig::with("2.4.0", |l| {
        l.unknown_session
            .store(true, std::sync::atomic::Ordering::SeqCst)
    });
    r.start(1, true, "ses_gone").unwrap();
    // the Session sends right away, as it does, before the end is known
    r.t.send(&Outbound {
        text: "lost",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    r.until("session unknown", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Ended(e) if e.session_unknown))
    });
    // generation 2 starts from scratch; the worker is FIFO, so by the time its prompt is posted
    // the lost send of generation 1 has been looked at and dropped
    r.h.launcher
        .unknown_session
        .store(false, std::sync::atomic::Ordering::SeqCst);
    r.fake()
        .shared
        .unknown_session
        .store(false, std::sync::atomic::Ordering::SeqCst);
    r.start(2, false, "chat").unwrap();
    r.t.send(&Outbound {
        text: "hello",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let log = r.fake().log();
    assert_eq!(
        log.iter().filter(|l| *l == "POST /api/session").count(),
        1,
        "{log:?}"
    );
    assert_eq!(r.fake().find("POST", "/prompt").len(), 1);
    assert_eq!(r.fake().find("POST", "/prompt")[0].body["text"], "hello");
    r.until("announced at generation 2", |l| {
        l.iter().any(|i| i.gen == 2 && matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::SessionStarted { .. }))))
    });
    assert!(
        !r.log
            .lock()
            .iter()
            .any(|i| i.gen == 1 && matches!(&i.message, Message::Mapped(_))),
        "nothing of the dropped generation reaches the chat"
    );
}

#[test]
fn a_refused_first_prompt_is_an_error_card_and_a_finished_turn_a_refused_queued_one_only_a_card() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.handler.lock() = Some(Box::new(|q: &Req| {
        q.path
            .ends_with("/prompt")
            .then(|| (400, json!({"_tag": "InvalidRequestError"})))
    }));
    r.t.send(&Outbound {
        text: "x",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    r.until("the card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { is_error: true, .. }))))
    });
    let events = r.events();
    assert_eq!(
        count(&events, |e| matches!(
            e,
            AgentEvent::Error {
                kind: AgentErrorKind::Api,
                retryable: false,
                ..
            }
        )),
        1
    );
    let receipt = uuid::Uuid::new_v4().to_string();
    r.t.send(&Outbound {
        text: "y",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    wait_for("the second refusal", 10, || {
        r.fake().find("POST", "/prompt").len() == 2
    });
    r.t.interrupt();
    wait_for("the marker", 10, || {
        !r.fake().find("POST", "/interrupt").is_empty()
    });
    let events = r.events();
    assert_eq!(count(&events, |e| matches!(e, AgentEvent::Error { .. })), 2);
    assert_eq!(
        count(&events, |e| matches!(e, AgentEvent::TurnFinished { .. })),
        1,
        "a queued message never ends the running turn"
    );
    assert_eq!(r.ended(), 0);
}

#[test]
fn start_reports_a_missing_program_and_an_unsupported_version_in_its_own_words() {
    let r = Rig::new("2.4.0");
    *r.h.launcher.fail.lock() = Some(super::server::LaunchError::NotFound);
    assert_eq!(r.start(1, false, "chat"), Err(SpawnError::NotFound));
    let old = Rig::new("2.0.0");
    match old.start(1, false, "chat") {
        Err(SpawnError::Failed {
            kind: AgentErrorKind::SpawnFailed,
            message,
            retryable: false,
        }) => {
            assert!(
                message.contains("2.0.0") && message.contains("2.4.0"),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_live_model_and_mode_change_is_applied_on_the_session_and_not_before_it_exists() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    let change = ModelChange {
        model: Some("fake/other".into()),
        effort: Some(Effort::High),
        model_changed: true,
        effort_changed: true,
    };
    assert_eq!(r.t.set_model(&change), LiveChange::Applied);
    r.t.set_permission_mode(AgentPermissionMode::Plan);
    // the first send creates the session with what was asked
    r.t.send(&Outbound {
        text: "hi",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    // nothing was changed before the session existed (the request log says in what order); the
    // rules of the mode go on right after it is made
    let log = r.fake().log();
    let at = |needle: &str| log.iter().position(|l| l.contains(needle));
    assert!(
        at("POST /api/session").is_some()
            && !log
                .iter()
                .any(|l| l.starts_with("POST") && l.ends_with("/model"))
            && at("POST /api/session") < at("PATCH")
            && at("PATCH") < at("/prompt"),
        "{log:?}"
    );
    let create = &r.fake().find("POST", "/api/session")[0].body;
    assert_eq!(
        create["model"],
        json!({"id": "other", "providerID": "fake", "variant": "high"})
    );
    // Plan: an allow-list, the deny first
    assert_eq!(create["permissions"][0]["effect"], "deny");
    assert_eq!(create["permissions"][1]["action"], "read");
    assert_eq!(
        r.fake().find("PATCH", "")[0].body["permissions"],
        create["permissions"]
    );
    // now live: leaving Plan clears the rules, it does not just stop naming them
    r.t.set_permission_mode(AgentPermissionMode::Manual);
    r.t.set_model(&ModelChange {
        model: Some("fake/third".into()),
        effort: None,
        model_changed: true,
        effort_changed: false,
    });
    wait_for("the changes", 10, || {
        r.fake().find("PATCH", "").len() == 2 && !r.fake().find("POST", "/model").is_empty()
    });
    assert_eq!(r.fake().find("PATCH", "")[1].body["permissions"], json!([]));
    assert_eq!(r.fake().find("POST", "/agent")[0].body["agent"], "writer");
    assert_eq!(
        r.fake().find("POST", "/model")[0].body["model"]["id"],
        "third"
    );
}

#[test]
fn a_refused_live_change_asks_for_a_restart() {
    let r = Rig::new("2.4.0");
    r.first_message();
    *r.fake().shared.handler.lock() = Some(Box::new(|q: &Req| {
        q.path
            .ends_with("/model")
            .then(|| (400, json!({"_tag": "InvalidRequestError"})))
    }));
    r.t.set_model(&ModelChange {
        model: Some("fake/x".into()),
        effort: None,
        model_changed: true,
        effort_changed: false,
    });
    r.until("refused", |l| {
        l.iter().any(|i| matches!(i.message, Message::Refused))
    });
}

#[test]
fn dropping_the_transport_gives_back_its_routes() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let before = r.h.server.dropped();
    let Rig { h, t, .. } = r;
    drop(t);
    let fake = Arc::clone(&h.launcher.current().server);
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.emit(&json!({"id": "e", "created": 1, "type": "session.text.delta", "data": {"sessionID": SESSION}}).to_string());
    wait_for("dropped", 5, || h.server.dropped() == before + 1);
}

#[test]
fn a_child_whose_rules_cannot_be_set_is_interrupted_and_the_chat_is_told() {
    let r = Rig::new("2.4.0");
    r.first_message_in(AgentPermissionMode::Plan);
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    *fake.shared.handler.lock() = Some(Box::new(|q: &Req| {
        (q.method == "PATCH").then(|| (500, json!({"_tag": "InternalError"})))
    }));
    fake.replay("subagent");
    wait_for("the child's interrupt", 10, || {
        fake.find("POST", "/interrupt")
            .iter()
            .any(|q| !q.path.contains(SESSION))
    });
    r.until("the card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("sub-agent")))))
    });
}

#[test]
fn a_late_child_patch_does_not_hold_the_stream_and_a_mode_change_reaches_the_running_child() {
    let r = Rig::new("2.4.0");
    r.first_message_in(AgentPermissionMode::Plan);
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    // the child's `PATCH` lands long after its first calls (the A2 race): the stream goes on
    fake.shared
        .delays
        .lock()
        .push(("ses_fake0002".into(), Duration::from_millis(500)));
    fake.replay("subagent");
    r.until("the whole turn, with the patch still pending", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { .. }))))
    });
    wait_for("the patch", 10, || {
        fake.find("PATCH", "/api/session/ses_fake0002").len() == 1
    });
    assert_eq!(
        fake.find("PATCH", "/api/session/ses_fake0002")[0].body["permissions"][0]["effect"],
        "deny"
    );
}

#[test]
fn entering_plan_puts_its_rules_on_the_running_children_and_outside_of_plan_a_child_is_left_alone()
{
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    fake.replay("subagent");
    r.until("the whole turn", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { .. }))))
    });
    // Manual: the child inherits the session's (empty) rules and its role's own: no PATCH
    assert!(fake.find("PATCH", "/api/session/ses_fake0002").is_empty());
    r.t.set_permission_mode(AgentPermissionMode::Plan);
    wait_for("the child's plan rules", 10, || {
        !fake.find("PATCH", "/api/session/ses_fake0002").is_empty()
    });
    let patch = &fake.find("PATCH", "/api/session/ses_fake0002")[0].body;
    assert_eq!(patch["permissions"][0]["effect"], "deny");
    assert_eq!(patch["permissions"][0]["action"], "*");
}

#[test]
fn queued_commands_run_when_the_transport_is_dropped() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    r.t.send(&Outbound {
        text: "last words",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    let Rig { h, t, .. } = r;
    drop(t);
    let fake = Arc::clone(&h.launcher.current().server);
    wait_for("the prompt", 10, || {
        !fake.find("POST", "/prompt").is_empty()
    });
    assert_eq!(fake.find("POST", "/prompt")[0].body["text"], "last words");
}

#[test]
fn the_models_are_read_again_when_they_change() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let before = fake.find("GET", "/api/model").len();
    fake.emit(&json!({"id": "e", "created": 1, "type": "model.updated", "data": {}}).to_string());
    wait_for("the re-read", 10, || {
        fake.find("GET", "/api/model").len() == before + 1
    });
}

#[test]
fn a_failed_instruction_put_is_an_error_card_and_the_prompt_still_goes() {
    let r = Rig::with("2.4.0", |_| {});
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.handler.lock() = Some(Box::new(|q: &Req| {
        q.path
            .contains("/instructions/")
            .then(|| (500, json!({"_tag": "InternalError"})))
    }));
    r.t.send(&Outbound {
        text: "hi",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    r.until("the card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("instructions")))))
    });
}

#[test]
fn accepting_edits_for_good_switches_the_mode_and_the_other_choices_do_what_they_say() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let id = emit_of(&fake, "shell-reject", "permission.asked")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let input = json!({});
    let edits = vec![json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"})];
    r.t.answer_permission(
        &id,
        allow(&input, Some(PermissionPersist::AcceptEdits), &edits),
    );
    wait_for("the mode", 10, || {
        fake.find("PATCH", "/api/session/ses_fake0001").len() == 2
    });
    // accepting edits is Writer's own: the session never gets an allow
    assert!(fake
        .find("PATCH", "/api/session/ses_fake0001")
        .iter()
        .all(|q| q.body["permissions"] == json!([])));
    wait_for("the reply", 10, || !fake.find("POST", "/reply").is_empty());
    assert_eq!(fake.find("POST", "/reply")[0].body["decision"], "once");
}

#[test]
fn a_blocking_stop_never_stalls_the_runtime() {
    let r = Rig::with("2.4.0", |l| {
        *l.stop_delay.lock() = Duration::from_millis(1200)
    });
    r.start(1, false, "chat").unwrap();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    // the stream is refused from now on: the server ends the process (and that takes a while)
    fake.shared
        .reject_stream
        .store(true, std::sync::atomic::Ordering::SeqCst);
    fake.drop_streams();
    wait_for("the second open", 10, || {
        fake.requests()
            .iter()
            .filter(|q| q.path == "/api/event")
            .count()
            >= 2
    });
    let t = Instant::now();
    let answered = r.h.server.io().call(async { 7 }, Duration::from_secs(2));
    assert_eq!(answered, Some(7));
    assert!(
        t.elapsed() < Duration::from_millis(600),
        "the runtime was blocked: {:?}",
        t.elapsed()
    );
    wait_for("the process is gone", 10, || {
        r.h.launcher.current().exited().is_some()
    });
}

#[test]
fn a_chat_resumed_in_a_fresh_transport_does_not_replay_its_history() {
    let (_, rest) = super::events_tests::fixture("steer-now");
    let history = rest["messages"].clone();
    let r = Rig::with("2.4.0", |l| *l.messages.lock() = Some(history));
    r.start(1, true, SESSION).unwrap();
    r.until("announced", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::SessionStarted { .. }))))
    });
    // the list was read (the seed), and a marker behind it in the worker's queue has run
    wait_for("the list", 10, || {
        !r.fake().find("GET", "/message").is_empty()
    });
    r.t.interrupt();
    wait_for("the marker", 10, || {
        !r.fake().find("POST", "/interrupt").is_empty()
    });
    let events = r.events();
    assert_eq!(
        count(&events, |e| matches!(
            e,
            AgentEvent::Text { .. }
                | AgentEvent::ToolCallStarted { .. }
                | AgentEvent::TurnFinished { .. }
        )),
        0,
        "the chat note holds the history: {events:?}"
    );
}

#[test]
fn a_new_start_after_a_crash_is_a_new_item_and_a_replayed_one_keeps_its_id() {
    let r = Rig::new("2.4.0");
    let id = new_id();
    r.start(1, false, "chat").unwrap();
    r.t.send(&Outbound {
        text: "same words",
        files: &[],
        delivery: Delivery::Start { receipt: &id },
    });
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let first = r.fake().find("POST", "/prompt")[0].body["id"].clone();
    assert_eq!(first, message_id_for(&id));
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    r.h.launcher.current().crash(9);
    r.until("the end", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Ended(_)))
    });
    // a new message with the same text is another item
    r.start(2, true, SESSION).unwrap();
    let again = new_id();
    r.t.send(&Outbound {
        text: "same words",
        files: &[],
        delivery: Delivery::Start { receipt: &again },
    });
    let second = r.fake();
    wait_for("the second prompt", 10, || {
        !second.find("POST", "/prompt").is_empty()
    });
    let posted = second.find("POST", "/prompt")[0].body["id"].clone();
    assert_eq!(posted, message_id_for(&again));
    assert_ne!(posted, first);
}

#[test]
fn a_child_created_while_the_stream_was_down_is_owned_from_the_launch_block_of_the_list() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    let (events, rest) = super::events_tests::fixture("subagent");
    let child = events
        .iter()
        .find(|e| e.kind == "session.created" && e.data.get("parentID").is_some())
        .and_then(|e| e.data["sessionID"].as_str().map(String::from))
        .unwrap();
    // the stream breaks before the child is created: only the list knows it
    *fake.shared.messages.lock() = rest["parent"].clone();
    fake.drop_streams();
    // the child's own list is read once the chat owns it (events of the gap are in that list)
    wait_for("the child's list", 10, || {
        fake.requests()
            .iter()
            .any(|q| q.method == "GET" && q.path == format!("/api/session/{child}/message"))
    });
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.text.delta",
            "data": {"sessionID": child, "assistantMessageID": "msg_child", "ordinal": 0, "delta": "c"}})
        .to_string(),
    );
    fake.emit(
        &json!({"id": "f", "created": 2, "type": "session.text.delta",
            "data": {"sessionID": SESSION, "assistantMessageID": "msg_marker", "ordinal": 0, "delta": "m"}})
        .to_string(),
    );
    r.until("the marker", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TextDelta { message_id, .. } if message_id == "msg_marker"))))
    });
    assert_eq!(r.h.server.dropped(), 0, "the child's event was the chat's");
}

#[test]
fn plan_set_while_the_server_is_down_is_on_the_session_before_the_first_prompt_of_the_resume() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    r.h.launcher.current().crash(9);
    r.until("the end", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Ended(_)))
    });
    // the user picks Plan while nothing runs
    r.t.set_permission_mode(AgentPermissionMode::Plan);
    r.start_in(2, true, SESSION, AgentPermissionMode::Plan)
        .unwrap();
    r.t.send(&Outbound {
        text: "next",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    let second = r.fake();
    wait_for("the prompt", 10, || {
        !second.find("POST", "/prompt").is_empty()
    });
    let log = second.log();
    let at = |needle: &str| log.iter().position(|l| l.contains(needle)).unwrap();
    assert!(at("PATCH") < at("/prompt"), "{log:?}");
    assert_eq!(
        second.find("PATCH", "")[0].body["permissions"][0]["effect"],
        "deny"
    );
}

#[test]
fn rules_that_cannot_be_set_refuse_the_turn_and_no_prompt_goes() {
    let r = Rig::new("2.4.0");
    r.start_in(1, false, "chat", AgentPermissionMode::Plan)
        .unwrap();
    let fake = r.fake();
    *fake.shared.handler.lock() = Some(Box::new(|q: &Req| {
        (q.method == "PATCH").then(|| (500, json!({"_tag": "InternalError"})))
    }));
    r.t.send(&Outbound {
        text: "do it",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    r.until("the refusal", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { is_error: true, .. }))))
    });
    assert!(
        fake.find("POST", "/prompt").is_empty(),
        "Plan did not hold, nothing was said"
    );
    // the next send tries the rules again before it prompts
    *fake.shared.handler.lock() = None;
    r.t.send(&Outbound {
        text: "again",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !fake.find("POST", "/prompt").is_empty()
    });
    let log = fake.log();
    let last_patch = log.iter().rposition(|l| l.starts_with("PATCH")).unwrap();
    let prompt = log.iter().position(|l| l.contains("/prompt")).unwrap();
    assert!(last_patch < prompt);
}

#[test]
fn an_id_another_session_holds_is_a_conflict_and_the_message_goes_again_under_a_fresh_id() {
    // ids are global on the server (`rest.json` `prompt-id-conflict`, captured by s33): the replay
    // of a message into a new session cannot reuse the id the lost session held
    let id = new_id();
    let held = id.clone();
    let r = Rig::with("2.4.0", |_| {});
    r.start(1, false, "chat").unwrap();
    // the fake of the first launch: the id is taken by "another session"
    r.t.send(&Outbound {
        text: "warm up",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the first prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let fake = r.fake();
    fake.shared
        .conflict_ids
        .lock()
        .insert(message_id_for(&held));
    r.t.send(&Outbound {
        text: "replayed",
        files: &[],
        delivery: Delivery::Queued { receipt: &id },
    });
    wait_for("both attempts", 10, || {
        fake.find("POST", "/prompt").len() == 3
    });
    let posts = fake.find("POST", "/prompt");
    assert_eq!(posts[1].body["id"], message_id_for(&held));
    let fresh = posts[2].body["id"].as_str().unwrap().to_string();
    assert_ne!(fresh, message_id_for(&held));
    assert!(fresh.starts_with("msg_"));
    // what the server says of the fresh id is the receipt the `Session` knows
    fake.emit(
        &json!({"id": "d", "created": 1, "type": "session.inbox.delivered",
            "data": {"sessionID": SESSION, "inboxID": fresh}})
        .to_string(),
    );
    r.until("taken under the original receipt", |l| {
        l.iter().any(
            |i| matches!(&i.message, Message::Mapped(m) if m.taken.as_deref() == Some(id.as_str())),
        )
    });
    // and a cancel names the fresh id too
    assert!(r.t.unqueue(&id, Duration::from_secs(1)).is_ok());
    assert_eq!(
        fake.find("DELETE", &format!("/inbox/{fresh}")).len(),
        0,
        "delivered: nothing to cancel"
    );
}

#[test]
fn a_queued_line_refused_for_rules_that_cannot_be_set_is_forgotten_by_the_session() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 5, || fake.streams() == 1);
    // a mode switch in the middle of the turn whose PATCH fails: the change stays pending
    *fake.shared.handler.lock() = Some(Box::new(|q: &Req| {
        (q.method == "PATCH").then(|| (500, json!({"_tag": "InternalError"})))
    }));
    r.t.set_permission_mode(AgentPermissionMode::Plan);
    r.until("the refusal", |l| {
        l.iter().any(|i| matches!(i.message, Message::Refused))
    });
    // the user's next message is written while the turn still runs
    let receipt = new_id();
    r.t.send(&Outbound {
        text: "also this",
        files: &[],
        delivery: Delivery::Queued { receipt: &receipt },
    });
    // it is not posted, and the `Session` is told to forget the line (chip and echo wait included),
    // before the turn ends
    r.until("forgotten", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Unqueued { receipt: x } if *x == receipt))
            && l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::SteerUndelivered { message_id } if *message_id == receipt))))
    });
    assert_eq!(
        fake.find("POST", "/prompt").len(),
        1,
        "only the first message"
    );
    // a steer is refused the same way
    let steer = new_id();
    r.t.send(&Outbound {
        text: "now this",
        files: &[],
        delivery: Delivery::Steer { receipt: &steer },
    });
    r.until("the steer forgotten", |l| {
        l.iter()
            .any(|i| matches!(&i.message, Message::Unqueued { receipt: x } if *x == steer))
    });
    assert_eq!(fake.find("POST", "/prompt").len(), 1);
    assert!(fake.find("POST", "/interrupt").is_empty());
}

#[test]
fn the_session_is_announced_once_by_the_send_that_retried_the_rules_and_before_the_prompt() {
    let r = Rig::new("2.4.0");
    r.start_in(1, false, "chat", AgentPermissionMode::Plan)
        .unwrap();
    let fake = r.fake();
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let once = Arc::clone(&failed);
    *fake.shared.handler.lock() = Some(Box::new(move |q: &Req| {
        (q.method == "PATCH" && !once.swap(true, std::sync::atomic::Ordering::SeqCst))
            .then(|| (500, json!({"_tag": "InternalError"})))
    }));
    let started = |l: &[Inbound]| {
        l.iter()
            .map(|i| match &i.message {
                Message::Mapped(m) => m
                    .events
                    .iter()
                    .filter(|e| matches!(e, AgentEvent::SessionStarted { .. }))
                    .count(),
                _ => 0,
            })
            .sum::<usize>()
    };
    // create works, the rules do not: the turn is refused and nothing is announced
    r.t.send(&Outbound {
        text: "one",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    r.until("the refused turn", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { is_error: true, .. }))))
    });
    r.pull();
    assert_eq!(started(&r.log.lock()), 0);
    // the retry in the next send works: the session is announced, and that is before its prompt
    r.t.send(&Outbound {
        text: "two",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    wait_for("the prompt", 10, || {
        !fake.find("POST", "/prompt").is_empty()
    });
    r.pull();
    assert_eq!(
        started(&r.log.lock()),
        1,
        "announced by the time of the prompt"
    );
    // a third send adds nothing
    r.t.send(&Outbound {
        text: "three",
        files: &[],
        delivery: Delivery::Queued { receipt: &new_id() },
    });
    wait_for("the second prompt", 10, || {
        fake.find("POST", "/prompt").len() == 2
    });
    r.pull();
    assert_eq!(started(&r.log.lock()), 1);
    // a session made in one go announces itself too (once)
    let r2 = Rig::new("2.4.0");
    r2.first_message();
    r2.pull();
    assert_eq!(started(&r2.log.lock()), 1);
}

#[test]
fn two_queued_sends_of_one_receipt_never_both_post_the_original_id() {
    // the id is read when the worker runs the send, not when it is queued: after the first send was
    // given a fresh id (a 409), the second of the same receipt uses it
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    let id = new_id();
    fake.shared.conflict_ids.lock().insert(message_id_for(&id));
    for _ in 0..2 {
        r.t.send(&Outbound {
            text: "again",
            files: &[],
            delivery: Delivery::Queued { receipt: &id },
        });
    }
    wait_for("the posts", 10, || fake.find("POST", "/prompt").len() == 4);
    let ids: Vec<String> = fake
        .find("POST", "/prompt")
        .iter()
        .map(|q| q.body["id"].as_str().unwrap().to_string())
        .collect();
    let original = message_id_for(&id);
    assert_eq!(ids.iter().filter(|i| **i == original).count(), 1, "{ids:?}");
    assert_eq!(ids[2], ids[3], "both under the fresh id");
}

#[test]
fn a_start_writes_the_config_first_and_a_changed_one_reloads_the_running_server_once() {
    let r = Rig::new("2.4.0");
    let file = r.h.dir.path().join("opencode/opencode.json");
    assert!(!file.exists());
    r.start(1, false, "chat").unwrap();
    // the file is there before the server answered anything, and the server started once
    let text = std::fs::read_to_string(&file).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["agents"]["writer"]["mode"], "primary");
    assert_eq!(v["agents"]["title"], json!({"disabled": true}));
    assert!(v.get("instructions").is_none());
    assert_eq!(r.h.launcher.launches(), 1);
    let fake = r.fake();
    assert!(fake.find("POST", "/api/location/reload").is_empty());
    // the same start again changes nothing
    r.start(2, false, "chat").unwrap();
    assert!(fake.find("POST", "/api/location/reload").is_empty());
    // an instruction file appeared: the next start writes it in and the server reads it again
    std::fs::write(r.h.dir.path().join("AGENTS.md"), "rules").unwrap();
    r.start(3, false, "chat").unwrap();
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v["instructions"].as_array().unwrap().len(), 1);
    assert_eq!(fake.find("POST", "/api/location/reload").len(), 1);
    assert_eq!(r.h.launcher.launches(), 1, "no restart for a config change");
}

#[test]
fn the_chats_own_memory_is_written_without_a_card_and_a_sub_agents_never() {
    let r = Rig::new("2.4.0");
    let mut l = launch(AgentPermissionMode::Manual);
    l.memory_dir = Some(r.cwd.join(".memory"));
    r.t.start(&StartRequest {
        gen: 1,
        session_id: "chat",
        resume: false,
        launch: &l,
    })
    .unwrap();
    r.t.send(&Outbound {
        text: "hello",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    let fake = r.fake();
    wait_for("the stream", 10, || fake.streams() == 1);
    wait_for("the prompt", 10, || {
        !fake.find("POST", "/prompt").is_empty()
    });
    // a sub-agent of the chat, owned by it as soon as it exists
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.created",
            "data": {"sessionID": "ses_child", "parentID": SESSION}})
        .to_string(),
    );
    // in this order: by the time the note's card is there, the sub-agent's request was seen
    let note = r
        .cwd
        .join(".memory/MEMORY.md")
        .to_string_lossy()
        .into_owned();
    fake.emit(&asked_event("per_fake_k", "ses_child", "edit", &note));
    fake.emit(&asked_event("per_fake_m", SESSION, "edit", &note));
    fake.emit(&asked_event("per_fake_n", SESSION, "edit", "notes.md"));
    wait_for("the memory write answered", 10, || {
        fake.find("POST", "/permission/per_fake_m/reply").len() == 1
    });
    assert_eq!(
        fake.find("POST", "/permission/per_fake_m/reply")[0].body["decision"],
        "once"
    );
    // a note is a card; the sub-agent's request (it names no launch call yet) is not answered
    r.until("the card", |l| {
        let cards: Vec<String> = l
            .iter()
            .filter_map(|i| match &i.message {
                Message::Mapped(m) => Some(m.events.iter().filter_map(|e| match e {
                    AgentEvent::PermissionRequest { request_id, .. } => Some(request_id.clone()),
                    _ => None,
                })),
                _ => None,
            })
            .flatten()
            .collect();
        cards.contains(&"per_fake_n".to_string())
    });
    assert!(fake.find("POST", "/permission/per_fake_n/reply").is_empty());
    assert!(fake.find("POST", "/permission/per_fake_k/reply").is_empty());
}

#[test]
fn memory_is_not_written_unasked_in_plan() {
    let r = Rig::new("2.4.0");
    let mut l = launch(AgentPermissionMode::Plan);
    l.memory_dir = Some(r.cwd.join(".memory"));
    r.t.start(&StartRequest {
        gen: 1,
        session_id: "chat",
        resume: false,
        launch: &l,
    })
    .unwrap();
    r.t.send(&Outbound {
        text: "hello",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
    let fake = r.fake();
    wait_for("the stream", 10, || fake.streams() == 1);
    wait_for("the prompt", 10, || {
        !fake.find("POST", "/prompt").is_empty()
    });
    // the server denies an edit in Plan before anyone is asked; if it ever asked, it is a card
    let note = r
        .cwd
        .join(".memory/MEMORY.md")
        .to_string_lossy()
        .into_owned();
    fake.emit(&asked_event("per_fake_p", SESSION, "edit", &note));
    r.until("the card", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::PermissionRequest { request_id, .. } if request_id == "per_fake_p"))))
    });
    assert!(fake.find("POST", "/permission/per_fake_p/reply").is_empty());
}

#[test]
fn what_the_card_keeps_for_this_chat_is_what_the_shared_conversion_reads_of_the_suggestions() {
    let suggestions = vec![
        json!({"type": "addRules", "behavior": "allow", "destination": "localSettings",
            "proposal": true,
            "rules": [{"toolName": "shell", "ruleContent": "echo *"},
                      {"toolName": "shell", "ruleContent": "ls *"}]}),
        json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
    ];
    // all of them, or the ticked ones; a rule that is in no suggestion is never kept
    let all = super::transport::kept_rules(&suggestions, None);
    assert_eq!(all.len(), 2);
    let ticked = super::transport::kept_rules(
        &suggestions,
        Some(&["ls *".to_string(), "rm -rf *".to_string()]),
    );
    assert_eq!(ticked.len(), 1);
    assert_eq!(ticked[0].action, "shell");
    assert_eq!(ticked[0].resource, "ls *");
    assert_eq!(
        ticked[0].to_json(),
        json!({"action": "shell", "resource": "ls *", "effect": "allow"})
    );
}

fn agent_list(entries: Value) -> Handler {
    Box::new(move |q: &Req| {
        (q.method == "GET" && q.path == "/api/agent").then(|| (200, json!({"data": entries})))
    })
}

fn send_first(r: &Rig) {
    r.t.send(&Outbound {
        text: "hello",
        files: &[],
        delivery: Delivery::Start { receipt: &new_id() },
    });
}

#[test]
fn an_enabled_agent_that_is_not_writers_refuses_the_start_with_a_card_and_no_prompt() {
    for list in [
        // a built-in that was not switched off
        json!([{"id": "writer", "mode": "primary"}, {"id": "build", "mode": "primary"}]),
        json!([{"id": "writer", "mode": "primary"}, {"id": "mine", "mode": "all"}]),
        json!([{"id": "writer", "mode": "primary"}, {"id": "general", "mode": "subagent"}]),
    ] {
        let r = Rig::new("2.4.0");
        r.start(1, false, "chat").unwrap();
        *r.fake().shared.handler.lock() = Some(agent_list(list));
        send_first(&r);
        r.until("the refusal", |l| {
            l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::TurnFinished { is_error: true, .. }))))
        });
        let events = r.events();
        assert!(events.iter().any(
            |e| matches!(e, AgentEvent::Error { message, .. } if message.contains("did not configure"))
        ));
        assert!(
            r.fake().find("POST", "/prompt").is_empty(),
            "no prompt went"
        );
    }
}

fn refusals(l: &[Inbound]) -> usize {
    l.iter()
        .filter(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("did not configure")))))
        .count()
}

/// A refused agent check stays refused: sending again does not get past it (the rules were set
/// and the session announced the first time, which must not be taken for a passed check).
#[test]
fn a_refused_agent_check_is_refused_again_on_the_next_send_and_no_prompt_ever_goes() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.handler.lock() = Some(agent_list(
        json!([{"id": "writer", "mode": "primary"}, {"id": "build", "mode": "primary"}]),
    ));
    send_first(&r);
    r.until("the first refusal", |l| refusals(l) == 1);
    send_first(&r);
    r.until("the second refusal", |l| refusals(l) == 2);
    assert!(
        r.fake().find("POST", "/prompt").is_empty(),
        "no prompt went"
    );
    // the server is fixed (the config reloaded): the next send passes the gate for good
    *r.fake().shared.handler.lock() =
        Some(agent_list(json!([{"id": "writer", "mode": "primary"}])));
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
}

/// The list is polled once per start of the server, before a session is given an agent of it.
#[test]
fn the_agent_list_is_read_once_per_start_and_before_the_session_is_given_its_agent() {
    let r = Rig::new("2.4.0");
    r.first_message();
    send_first(&r);
    let fake = r.fake();
    wait_for("the second prompt", 10, || {
        fake.find("POST", "/prompt").len() == 2
    });
    let calls = fake.requests();
    let at = |m: &str, frag: &str| {
        calls
            .iter()
            .position(|q| q.method == m && q.path.contains(frag))
    };
    assert_eq!(
        calls
            .iter()
            .filter(|q| q.method == "GET" && q.path == "/api/agent")
            .count(),
        1,
        "the list is read once"
    );
    assert!(at("GET", "/api/agent").unwrap() < at("POST", "/agent").unwrap());
    // the one gate also asks for the MCP servers, once per start and before the first prompt
    let first_patch = at("PATCH", "/api/session").unwrap();
    let gate_reads = calls[..first_patch]
        .iter()
        .filter(|q| q.method == "GET" && q.path == "/api/mcp")
        .count();
    assert_eq!(
        gate_reads, 1,
        "the servers are read once, before the rules are set"
    );
}

/// The text of the first card that says something went wrong.
fn error_texts(r: &Rig) -> Vec<String> {
    r.events()
        .into_iter()
        .filter_map(|e| match e {
            AgentEvent::Error { message, .. } => Some(message),
            _ => None,
        })
        .collect()
}

/// A scripted `GET /api/mcp` that answers `bad` while no reload has happened and the rig's own
/// list (nothing running but Writer's) after it, like a server that obeys the rewritten file.
fn mcp_until_reload(shared: Arc<super::fake_server_tests::Shared>, bad: Value) -> Handler {
    Box::new(move |q: &Req| {
        if !(q.method == "GET" && q.path == "/api/mcp") {
            return None;
        }
        let reloaded = shared
            .requests
            .lock()
            .iter()
            .any(|r| r.path == "/api/location/reload");
        (!reloaded).then(|| (200, bad.clone()))
    })
}

/// (b) A server that runs and was not switched on is put under the lever by name (a placeholder,
/// the file rewritten and read again, once); when the reload obeys, the start goes on.
#[test]
fn an_mcp_server_that_runs_unasked_is_held_off_by_name_and_the_start_goes_on() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    let shared = Arc::clone(&r.fake().shared);
    *shared.handler.lock() = Some(mcp_until_reload(
        Arc::clone(&shared),
        json!({"data": [
            {"name": "writer", "status": {"status": "connected"}},
            {"name": "opencode_console", "status": {"status": "connected"}},
        ]}),
    ));
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    assert_eq!(
        r.fake().find("POST", "/api/location/reload").len(),
        1,
        "read again once"
    );
    let doc: Value = serde_json::from_str(
        &std::fs::read_to_string(r.h.dir.path().join("opencode/opencode.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(doc["mcp"]["servers"]["opencode_console"]["disabled"], true);
    assert!(r
        .h
        .server
        .mcp_known()
        .contains(&"opencode_console".to_string()));
}

/// (b) One that still runs after that stops the server and refuses, with a neutral message and
/// no prompt; the next start is a new process.
#[test]
fn an_mcp_server_that_still_runs_after_the_rewrite_stops_the_server_and_refuses_the_chat() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.mcp_reply.lock() = Some(json!({"data": [
        {"name": "writer", "status": {"status": "connected"}},
        {"name": "g-x", "status": {"status": "connected"}},
    ]}));
    send_first(&r);
    r.until("the refusal", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("not switched on")))))
    });
    assert!(r.fake().find("POST", "/prompt").is_empty());
    wait_for("the process to stop", 10, || {
        r.h.launcher.current().exited().is_some()
    });
    assert_eq!(
        r.fake().find("POST", "/api/location/reload").len(),
        1,
        "one rewrite, then refused"
    );
    let said = error_texts(&r).join("\n");
    assert!(!said.contains("g-x"), "the card names no server: {said}");
}

/// (b) A server that is switched on may run; a `disabled` one that is not is fine.
#[test]
fn a_switched_on_server_and_a_disabled_one_pass_the_gate() {
    let r = Rig::new("2.4.0");
    r.h.server.on_switches(Arc::new(|| super::server::Stored {
        mcp_on: vec!["g-a".to_string()],
        providers_off: Vec::new(),
    }));
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.mcp_reply.lock() = Some(json!({"data": [
        {"name": "writer", "status": {"status": "connected"}},
        {"name": "g-a", "status": {"status": "failed", "error": "x"}},
        {"name": "g-b", "status": {"status": "disabled"}},
    ]}));
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
}

/// (a) An agent of the user's is disabled by name (rewrite, reload, recheck) and the start goes on.
#[test]
fn a_foreign_agent_is_disabled_by_name_and_the_start_goes_on() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    let shared = Arc::clone(&r.fake().shared);
    let seen = Arc::clone(&shared);
    *shared.handler.lock() = Some(Box::new(move |q: &Req| {
        if !(q.method == "GET" && q.path == "/api/agent") {
            return None;
        }
        let reloaded = seen
            .requests
            .lock()
            .iter()
            .any(|r| r.path == "/api/location/reload");
        let mut list = vec![json!({"id": "writer", "mode": "primary"})];
        if !reloaded {
            list.push(json!({"id": "g-prim", "mode": "primary"}));
        }
        Some((200, json!({"data": list})))
    }));
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    let doc: Value = serde_json::from_str(
        &std::fs::read_to_string(r.h.dir.path().join("opencode/opencode.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(doc["agents"]["g-prim"], json!({"disabled": true}));
}

/// (c) Writer's agent resolves to more than Writer wrote (a later allow): refused at once, no
/// reload, no prompt.
#[test]
fn permissions_that_are_looser_than_writers_refuse_the_start() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.handler.lock() = Some(Box::new(|q: &Req| {
        (q.method == "GET" && q.path == "/api/agent").then(|| {
            (
                200,
                json!({"data": [{"id": "writer", "mode": "primary", "permissions": [
                    {"action": "*", "resource": "*", "effect": "ask"},
                    {"action": "edit", "resource": "*", "effect": "allow"},
                ]}]}),
            )
        })
    }));
    send_first(&r);
    r.until("the refusal", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("permissions")))))
    });
    assert!(r.fake().find("POST", "/prompt").is_empty());
    assert!(
        r.fake().find("POST", "/api/location/reload").is_empty(),
        "nothing to rewrite"
    );
}

/// A hidden agent is trusted by OpenCode's own names only; whether a model may launch any other
/// hidden one is not in the contract, so it is refused like a visible one.
#[test]
fn a_hidden_agent_of_another_name_is_foreign_and_opencodes_own_are_not() {
    let ours = vec!["writer".to_string()];
    let list = |extra: Value| -> Vec<Value> {
        let mut v = vec![
            json!({"id": "writer", "mode": "primary"}),
            json!({"id": "compaction", "mode": "primary", "hidden": true}),
            json!({"id": "summary", "mode": "primary", "hidden": true}),
        ];
        v.push(extra);
        v
    };
    assert_eq!(
        super::config::foreign_agents(
            &list(json!({"id": "helper", "mode": "subagent", "hidden": true})),
            &ours
        ),
        ["helper"]
    );
    // a visible agent that borrows a system name is foreign: the name is trusted only when hidden
    assert_eq!(
        super::config::foreign_agents(&[json!({"id": "summary", "mode": "all"})], &ours),
        ["summary"]
    );
    assert!(super::config::foreign_agents(
        &list(json!({"id": "x", "mode": "all", "disabled": true})),
        &ours
    )
    .is_empty());
}

/// The real 2.4.0 lists (`fixtures/config-load.json`, s35): the built-in list is foreign, Writer's
/// own once the config is loaded is not (OpenCode's hidden compaction and summary stay).
#[test]
fn the_captured_agent_lists_decide_as_the_check_needs() {
    let cap: Value = serde_json::from_str(
        &std::fs::read_to_string(super::events_tests::fixtures_dir().join("config-load.json"))
            .unwrap(),
    )
    .unwrap();
    let list = |key: &str| -> Vec<Value> {
        cap[key][0]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, v)| json!({"id": id, "mode": v[0], "hidden": v[1], "disabled": v[2]}))
            .collect()
    };
    let ours = ModePolicy::new(super::events_tests::table()).known_agents();
    assert!(!super::config::foreign_agents(&list("immediately"), &ours).is_empty());
    assert!(super::config::foreign_agents(&list("later"), &ours).is_empty());
    assert!(super::config::foreign_agents(&list("after_reload"), &ours).is_empty());
    assert_eq!(cap["session_survives_reload"], true);
}

/// A policy that cannot write the config fails the start at once, with a clear error.
#[test]
fn a_policy_with_no_vault_fails_the_start_and_names_why() {
    let r = Rig::build(
        "2.4.0",
        |_| {},
        |_| Arc::new(ModePolicy::new(super::events_tests::table())),
    );
    match r.start(1, false, "chat") {
        Err(SpawnError::Failed {
            message, retryable, ..
        }) => {
            assert!(message.contains("no vault"), "{message}");
            assert!(!retryable);
        }
        other => panic!("{other:?}"),
    }
    assert!(r.h.launcher.launches() == 0, "no server was started");
}

#[test]
fn hidden_disabled_and_writers_own_agents_are_fine() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    *r.fake().shared.handler.lock() = Some(agent_list(json!([
        {"id": "writer", "mode": "primary"},
        {"id": "writer-worker", "mode": "subagent"},
        {"id": "compaction", "mode": "primary", "hidden": true},
        {"id": "title", "mode": "primary", "disabled": true},
        {"id": "tool-helper", "mode": "tool"},
    ])));
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
}

#[test]
fn a_server_that_never_shows_writers_agent_is_refused_too() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    // only the built-in list: the config did not load
    *r.fake().shared.handler.lock() = Some(agent_list(json!([{"id": "build", "mode": "primary"}])));
    send_first(&r);
    r.until("the refusal", |l| {
        l.iter().any(|i| matches!(&i.message, Message::Mapped(m) if m.events.iter().any(|e| matches!(e, AgentEvent::Error { message, .. } if message.contains("did not load")))))
    });
    assert!(r.fake().find("POST", "/prompt").is_empty());
}

/// After the server read its config again, each live chat puts its instruction entry back.
#[test]
fn a_reload_puts_the_instruction_entry_of_every_live_chat_back_once() {
    let r = Rig::new("2.4.0");
    r.first_message();
    let fake = r.fake();
    wait_for("the stream", 10, || fake.streams() == 1);
    let puts = || fake.find("PUT", "/instructions/entries/writer").len();
    wait_for("the first put", 10, || puts() == 1);
    // a turn is running: the reload waits
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.execution.started",
            "data": {"sessionID": SESSION}})
        .to_string(),
    );
    r.h.server.apply_config("{\"v\":1}\n").unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(fake.find("POST", "/api/location/reload").is_empty());
    assert_eq!(puts(), 1);
    fake.emit(
        &json!({"id": "e", "created": 1, "type": "session.execution.succeeded",
            "data": {"sessionID": SESSION}})
        .to_string(),
    );
    wait_for("the reload", 10, || {
        fake.find("POST", "/api/location/reload").len() == 1
    });
    wait_for("the entry put back", 10, || puts() == 2);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(puts(), 2);
}

#[test]
fn a_model_the_user_switched_off_refuses_the_start_before_any_server_runs() {
    let r = Rig::build(
        "2.4.0",
        |_| {},
        |root| {
            Arc::new(
                ModePolicy::new(super::events_tests::table())
                    .with_disabled(Arc::new(|| vec!["fake/off".to_string()]))
                    .for_vault(root.to_path_buf()),
            )
        },
    );
    let mut l = launch(AgentPermissionMode::Manual);
    l.settings.model = Some("fake/off".into());
    let err =
        r.t.start(&StartRequest {
            gen: 1,
            session_id: "s",
            resume: false,
            launch: &l,
        })
        .unwrap_err();
    assert!(
        matches!(&err, SpawnError::Invalid(m) if m.contains("fake/off") && m.contains("switched off")),
        "{err:?}"
    );
    assert_eq!(r.h.launcher.launches(), 0, "no process for a refused model");
    // another model, and a variant of the same one, are judged by the slug alone
    l.settings.model = Some("fake/on".into());
    assert!(r
        .t
        .start(&StartRequest {
            gen: 2,
            session_id: "s",
            resume: false,
            launch: &l,
        })
        .is_ok());
}

#[test]
fn a_switched_off_model_is_refused_with_its_variant_too() {
    let policy = ModePolicy::new(super::events_tests::table())
        .with_disabled(Arc::new(|| vec!["fake/off".to_string()]));
    let off = ModelRef::parse("fake/off#high").unwrap();
    assert!(policy.refuse_model(&off).is_some());
    assert!(policy
        .refuse_model(&ModelRef::parse("fake/on#high").unwrap())
        .is_none());
}

/// A turn on a provider the user switched off would fail in the server with a bare code: the chat
/// is refused before it starts, with the reason.
#[test]
fn a_switched_off_provider_refuses_a_model_of_it_before_the_start() {
    let policy = ModePolicy::new(super::events_tests::table())
        .with_providers_off(Arc::new(|| vec!["fake-b".to_string()]));
    let why = policy
        .refuse_model(&ModelRef::parse("fake-b/any#high").unwrap())
        .expect("refused");
    assert!(
        why.contains("provider") && why.contains("fake-b/any"),
        "{why}"
    );
    assert!(policy
        .refuse_model(&ModelRef::parse("fake-a/any").unwrap())
        .is_none());
    // no switches: nothing is refused
    assert!(ModePolicy::new(super::events_tests::table())
        .refuse_model(&ModelRef::parse("fake-b/any").unwrap())
        .is_none());
}

#[test]
fn a_chat_on_a_stopped_server_is_gone_for_good_and_not_a_failed_start() {
    // the feature went off and on again: the chat still holds the old server, which never starts
    // again; the `Session` reads `Gone` as terminal and the next start asks for the backend anew
    let r = Rig::new("2.4.0");
    r.start(1, false, "s").unwrap();
    r.h.server.shutdown();
    let err = r.start(2, false, "s").unwrap_err();
    assert_eq!(err, SpawnError::Gone);
}

/// (a) A foreign agent whose first reload the server refuses: the process is stopped with the
/// card, and the next send, on a new process that reads the rewritten file, passes the gate.
#[test]
fn a_gate_reload_that_fails_stops_the_server_and_the_next_send_passes() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    let shared = Arc::clone(&r.fake().shared);
    let seen = Arc::clone(&shared);
    *shared.handler.lock() = Some(Box::new(move |q: &Req| {
        if q.path == "/api/location/reload" {
            return Some((500, json!({"_tag": "Boom"})));
        }
        if !(q.method == "GET" && q.path == "/api/agent") {
            return None;
        }
        let _ = &seen;
        Some((
            200,
            json!({"data": [
                {"id": "writer", "mode": "primary"},
                {"id": "g-prim", "mode": "primary"},
            ]}),
        ))
    }));
    send_first(&r);
    wait_for("the first process to stop", 10, || {
        r.h.launcher.current().exited().is_some()
    });
    assert!(r.fake().find("POST", "/prompt").is_empty());
    // the next start: a new process, whose file has the agent disabled
    r.start(2, false, "chat").unwrap();
    send_first(&r);
    wait_for("the prompt", 10, || {
        !r.fake().find("POST", "/prompt").is_empty()
    });
    assert_eq!(r.h.launcher.launches(), 2);
}

/// Any refusal that follows a rewrite stops the process, not only an MCP one.
#[test]
fn a_refusal_after_a_rewrite_stops_the_process() {
    let r = Rig::new("2.4.0");
    r.start(1, false, "chat").unwrap();
    // the foreign agent stays listed after the rewrite and its reload
    *r.fake().shared.handler.lock() = Some(agent_list(
        json!([{"id": "writer", "mode": "primary"}, {"id": "g-prim", "mode": "primary"}]),
    ));
    send_first(&r);
    r.until("the refusal", |l| refusals(l) == 1);
    wait_for("the process to stop", 10, || {
        r.h.launcher.current().exited().is_some()
    });
}
