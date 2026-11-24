//! The `Session` state machine against a fake in-memory [`Transport`]: no process, no pipes, no
//! `claude`. It proves the seam of spec `SPECs/opencode-backend-spec.md` section 5: send, steer,
//! queue, unqueue with its answer, interrupt, permission, question and the end of the connection
//! are decided by the `Session` from what the transport says, and the words of a failure are the
//! transport's. The fake follows the real contract (generation-tagged inbound messages, one
//! channel, a final `Ended`); the real transport is tested against the fake `claude` in
//! `runner_tests.rs`.

use super::events::*;
use super::files::Outgoing;
use super::permission_update::updated_permissions;
use super::runner::Session;
use super::session::{AgentSessions, Sink, Timing};
use super::transport::{
    Close, Delivery, Ended, Inbound, LiveChange, Mapped, Message, ModelChange, Outbound,
    PermissionReply, Phrases, Receipt, SpawnError, StartRequest, Transport, TransportInit,
    Unanswered,
};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

static FAKE_PHRASES: Phrases = Phrases {
    not_found: "fake: not found",
    exited_idle: "fake: ended while idle",
    connection_lost: "fake: connection lost",
    ended_in_turn: "fake: ended in the turn",
    keeps_exiting: "fake: keeps ending",
    no_answer: "fake: no answer",
};

/// What the `Session` asked of the transport.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    Start {
        resume: bool,
        session: String,
    },
    Send {
        text: String,
        delivery: String,
    },
    Unqueue(String),
    Discard(String),
    Interrupt,
    Permission {
        id: String,
        allow: bool,
        text: String,
    },
    Question {
        id: String,
        answered: bool,
    },
    Model(Option<String>),
    Mode(AgentPermissionMode),
    Close(Close),
}

struct Fake {
    calls: Mutex<Vec<Call>>,
    inbound: Sender<Inbound>,
    gen: AtomicU64,
    /// What `unqueue` answers.
    unqueue: Mutex<Result<bool, Unanswered>>,
    /// Whether `answer_question` knows the question.
    knows_question: Mutex<bool>,
    /// What `set_model` answers.
    model: Mutex<LiveChange>,
    /// The chat the fake serves, to check the locking contract of the trait.
    session: Mutex<Weak<Session>>,
    /// Makes the next `start` announce itself (first channel) and wait to be released (second).
    hold_start: Mutex<Option<(Sender<()>, Receiver<()>)>>,
    /// Makes the next `start` fail.
    fail_start: Mutex<Option<SpawnError>>,
    /// A connection exists (`start` returned `Ok`): `close` has something to signal.
    up: AtomicBool,
}

impl Fake {
    fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }

    fn count(&self, pred: impl Fn(&Call) -> bool) -> usize {
        self.calls.lock().iter().filter(|c| pred(c)).count()
    }

    /// The backend says something, in the generation of the last start.
    fn say(&self, message: Message) {
        let gen = self.gen.load(Ordering::SeqCst);
        self.inbound.send(Inbound { gen, message }).unwrap();
    }

    fn events(&self, events: Vec<AgentEvent>) {
        self.say(Message::Mapped(Mapped {
            events,
            ..Mapped::default()
        }));
    }

    fn taken(&self, receipt: &str) {
        self.say(Message::Mapped(Mapped {
            taken: Some(receipt.into()),
            ..Mapped::default()
        }));
    }

    fn ended(&self, code: i32) {
        self.say(Message::Ended(Ended {
            code: Some(code),
            signal: None,
            session_unknown: false,
        }));
    }

    fn record(&self, call: Call) {
        self.calls.lock().push(call);
    }

    /// `start` and `unqueue` may block, so the `Session` must call them without its lock.
    fn assert_session_unlocked(&self, method: &str) {
        if let Some(s) = self.session.lock().upgrade() {
            assert!(!s.lock_is_held(), "{method} was called with the lock held");
        }
    }
}

impl Transport for Fake {
    fn phrases(&self) -> &'static Phrases {
        &FAKE_PHRASES
    }

    fn start(&self, req: &StartRequest<'_>) -> Result<(), SpawnError> {
        self.assert_session_unlocked("start");
        self.gen.store(req.gen, Ordering::SeqCst);
        self.up.store(false, Ordering::SeqCst);
        self.record(Call::Start {
            resume: req.resume,
            session: req.session_id.into(),
        });
        if let Some(e) = self.fail_start.lock().take() {
            return Err(e);
        }
        let hold = self.hold_start.lock().take();
        if let Some((entered, release)) = hold {
            entered.send(()).unwrap();
            release.recv().unwrap();
        }
        self.up.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn send(&self, msg: &Outbound<'_>) -> Receipt {
        let (delivery, id) = match msg.delivery {
            Delivery::Start { .. } => ("start".to_string(), String::new()),
            Delivery::Steer { receipt } => ("steer".to_string(), receipt.to_string()),
            Delivery::Queued { receipt } => ("queued".to_string(), receipt.to_string()),
        };
        self.record(Call::Send {
            text: msg.text.into(),
            delivery,
        });
        Receipt {
            message_id: id.clone(),
            backend_id: id,
        }
    }

    fn unqueue(&self, receipt: &str, _wait: Duration) -> Result<bool, Unanswered> {
        self.assert_session_unlocked("unqueue");
        self.record(Call::Unqueue(receipt.into()));
        let answer = self.unqueue.lock().clone();
        if answer == Ok(true) {
            // the contract: a confirmation is also said in order with the rest
            self.say(Message::Unqueued {
                receipt: receipt.into(),
            });
        }
        answer
    }

    fn discard(&self, receipt: &str) {
        self.record(Call::Discard(receipt.into()));
    }

    fn interrupt(&self) {
        self.record(Call::Interrupt);
    }

    fn answer_permission(&self, request_id: &str, reply: PermissionReply<'_>) {
        let (allow, text) = match reply {
            PermissionReply::Allow {
                persist,
                suggestions,
                ..
            } => (
                true,
                format!(
                    "{} updates",
                    updated_permissions(suggestions, persist, None).len()
                ),
            ),
            PermissionReply::Deny { message } => (false, message.to_string()),
        };
        self.record(Call::Permission {
            id: request_id.into(),
            allow,
            text,
        });
    }

    fn answer_question(&self, request_id: &str, answers: Option<&[QuestionAnswer]>) -> bool {
        let known = *self.knows_question.lock();
        if known {
            self.record(Call::Question {
                id: request_id.into(),
                answered: answers.is_some(),
            });
        }
        known
    }

    fn set_model(&self, change: &ModelChange) -> LiveChange {
        self.record(Call::Model(change.model.clone()));
        *self.model.lock()
    }

    fn set_permission_mode(&self, mode: AgentPermissionMode) {
        self.record(Call::Mode(mode));
    }

    fn close(&self, how: Close) {
        // like a real connection: nothing to signal before `start` returned
        if self.up.load(Ordering::SeqCst) {
            self.record(Call::Close(how));
        }
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    _sessions: AgentSessions,
    session: Arc<Session>,
    fake: Arc<Fake>,
    _rx: Receiver<AgentEventEnvelope>,
}

fn timing() -> Timing {
    Timing {
        cancel_grace: Duration::from_millis(500),
        close_grace: Duration::from_secs(60),
        term_to_kill: Duration::from_secs(60),
        idle_after: Duration::from_secs(1800),
        reaper_every: Duration::from_secs(60),
        config_debounce: Duration::from_millis(150),
        mcp_backoff: [Duration::from_millis(200); 3],
        mcp_probe_timeout: Duration::from_secs(5),
        steer_ack: Duration::from_millis(400),
        unqueue_ack: Duration::from_millis(1500),
    }
}

const CHAT: &str = "11111111-1111-4111-8111-111111111111";

fn settings() -> AgentSettings {
    AgentSettings {
        binary_path: None,
        model: None,
        effort: None,
        permission_mode: AgentPermissionMode::Manual,
        allowed_tools: vec![],
        disallowed_tools: vec![],
        orchestrate: false,
        show_thinking: false,
        auto_reload: true,
        memory: AgentMemory::Default,
        tier_models: Default::default(),
    }
}

impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let sessions = AgentSessions::with_timing(timing());
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.lock().send(e);
        });
        let slot: Arc<Mutex<Option<Arc<Fake>>>> = Arc::default();
        let keep = Arc::clone(&slot);
        let session = sessions
            .open_on(
                "w",
                &root,
                CHAT,
                sink,
                settings(),
                move |init: TransportInit| {
                    let fake = Arc::new(Fake {
                        calls: Mutex::new(Vec::new()),
                        inbound: init.inbound,
                        gen: AtomicU64::new(0),
                        unqueue: Mutex::new(Ok(true)),
                        knows_question: Mutex::new(true),
                        model: Mutex::new(LiveChange::Applied),
                        session: Mutex::new(Weak::new()),
                        hold_start: Mutex::new(None),
                        fail_start: Mutex::new(None),
                        up: AtomicBool::new(false),
                    });
                    *keep.lock() = Some(Arc::clone(&fake));
                    Ok(fake as Arc<dyn Transport>)
                },
            )
            .unwrap();
        let fake = slot.lock().take().unwrap();
        *fake.session.lock() = Arc::downgrade(&session);
        Rig {
            _dir: dir,
            _sessions: sessions,
            session,
            fake,
            _rx: rx,
        }
    }

    fn send(&self, text: &str) {
        self.session.send(Outgoing::text(text)).unwrap();
    }

    /// The chat's state and events, polled until `pred` holds.
    fn until(
        &self,
        what: &str,
        pred: impl Fn(AgentSessionState, &[AgentEvent]) -> bool,
    ) -> Vec<AgentEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let (state, envelopes) = self.session.snapshot(0);
            let events: Vec<AgentEvent> = envelopes.into_iter().map(|e| e.event).collect();
            if pred(state, &events) {
                return events;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {state:?} {events:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn idle(&self) {
        self.until("idle", |s, _| s == AgentSessionState::Idle);
    }
}

fn started() -> AgentEvent {
    AgentEvent::SessionStarted {
        session_id: CHAT.into(),
        model: Some("m".into()),
        cwd: "/v".into(),
        permission_mode: None,
        tools: vec![],
        slash_commands: vec![],
        skills: vec![],
        mcp_servers: vec![],
        cli_version: None,
    }
}

fn finished(reason: TurnFinishReason) -> AgentEvent {
    AgentEvent::TurnFinished {
        reason,
        duration_ms: 1,
        api_duration_ms: None,
        num_turns: Some(1),
        is_error: reason == TurnFinishReason::Error,
        result: None,
        session_id: Some(CHAT.into()),
        errors: vec![],
    }
}

fn text(t: &str) -> AgentEvent {
    AgentEvent::Text {
        message_id: "m1".into(),
        block_index: 0,
        text: t.into(),
    }
}

fn permission(id: &str) -> AgentEvent {
    AgentEvent::PermissionRequest {
        request_id: id.into(),
        tool_call_id: Some("call1".into()),
        tool: "any".into(),
        display_name: None,
        input: json!({"x": 1}),
        description: None,
        decision_reason: None,
        suggestions: vec![
            json!({"type":"addRules","behavior":"allow","rules":[{"toolName":"any","ruleContent":"x"}]}),
        ],
        by: None,
    }
}

fn question(id: &str) -> AgentEvent {
    AgentEvent::QuestionRequest {
        request_id: id.into(),
        tool_call_id: Some("call2".into()),
        questions: vec![Question {
            question: "Which?".into(),
            header: "Pick".into(),
            multi_select: false,
            options: vec![QuestionOption {
                label: "A".into(),
                description: String::new(),
                preview: None,
            }],
        }],
        by: None,
    }
}

fn send_call(text: &str, delivery: &str) -> Call {
    Call::Send {
        text: text.into(),
        delivery: delivery.into(),
    }
}

#[test]
fn a_send_starts_the_transport_hands_the_message_over_and_the_turn_ends_idle() {
    let r = Rig::new();
    r.send("hello");
    assert_eq!(
        r.fake.calls(),
        vec![
            Call::Start {
                resume: false,
                session: CHAT.into()
            },
            send_call("hello", "start"),
        ]
    );
    // the first event of the backend says it is working
    assert_eq!(r.session.state(), AgentSessionState::Starting);
    r.fake.events(vec![started(), text("hi")]);
    r.fake.events(vec![finished(TurnFinishReason::Completed)]);
    let events = r.until("the turn's end", |s, _| s == AgentSessionState::Idle);
    assert!(events.contains(&text("hi")));
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::TurnFinished { .. })));
}

#[test]
fn a_message_sent_during_a_turn_waits_in_the_queue_and_goes_when_the_turn_ends() {
    let r = Rig::new();
    r.send("one");
    r.send("two");
    assert_eq!(r.fake.count(|c| matches!(c, Call::Send { .. })), 1);
    r.fake
        .events(vec![started(), finished(TurnFinishReason::Completed)]);
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| matches!(c, Call::Send { .. })) < 2 {
        assert!(Instant::now() < deadline, "the queued message never went");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(r.fake.calls().last(), Some(&send_call("two", "start")));
}

#[test]
fn a_steer_goes_at_once_and_the_backend_taking_it_settles_it() {
    let r = Rig::new();
    r.send("work");
    r.session
        .steer(
            Outgoing::text("change course"),
            "22222222-2222-4222-8222-222222222222",
        )
        .unwrap();
    assert_eq!(
        r.fake.calls().last(),
        Some(&send_call("change course", "steer"))
    );
    r.fake.taken("22222222-2222-4222-8222-222222222222");
    // past the receipt time: nothing is reported undelivered
    std::thread::sleep(timing().steer_ack * 2);
    let (_, envelopes) = r.session.snapshot(0);
    assert!(!envelopes
        .iter()
        .any(|e| matches!(e.event, AgentEvent::SteerUndelivered { .. })));
}

#[test]
fn a_steer_the_backend_never_takes_is_reported_undelivered() {
    let r = Rig::new();
    r.send("work");
    let id = "22222222-2222-4222-8222-222222222222";
    r.session
        .steer(Outgoing::text("change course"), id)
        .unwrap();
    let events = r.until("the report", |_, ev| {
        ev.iter()
            .any(|e| matches!(e, AgentEvent::SteerUndelivered { .. }))
    });
    assert!(events.contains(&AgentEvent::SteerUndelivered {
        message_id: id.into()
    }));
}

#[test]
fn a_queued_message_is_received_when_the_backend_takes_it() {
    let r = Rig::new();
    r.send("work");
    let id = "33333333-3333-4333-8333-333333333333";
    r.session
        .queue_line(Outgoing::text("also this"), id)
        .unwrap();
    assert_eq!(
        r.fake.calls().last(),
        Some(&send_call("also this", "queued"))
    );
    r.fake.taken(id);
    r.until("the receipt", |_, ev| {
        ev.contains(&AgentEvent::MessageReceived {
            message_id: id.into(),
        })
    });
}

#[test]
fn unqueueing_waits_for_the_backends_answer_and_never_invents_one() {
    let r = Rig::new();
    r.send("work");
    let id = "33333333-3333-4333-8333-333333333333";
    r.session
        .queue_line(Outgoing::text("also this"), id)
        .unwrap();
    // the backend took it first: not cancelled, still tracked
    *r.fake.unqueue.lock() = Ok(false);
    assert!(!r.session.unqueue(id).unwrap());
    // no answer: an error in the transport's words, the line stays tracked
    *r.fake.unqueue.lock() = Err(Unanswered);
    match r.session.unqueue(id) {
        Err(SpawnError::Invalid(m)) => assert_eq!(m, "fake: no answer"),
        other => panic!("{other:?}"),
    }
    // the backend confirms: gone, and the turn no longer waits for it
    *r.fake.unqueue.lock() = Ok(true);
    assert!(r.session.unqueue(id).unwrap());
    r.fake
        .events(vec![started(), finished(TurnFinishReason::Completed)]);
    r.idle();
    assert_eq!(r.fake.count(|c| matches!(c, Call::Unqueue(_))), 3);
}

#[test]
fn an_interrupt_asks_the_transport_and_the_interrupted_turn_ends_idle() {
    let r = Rig::new();
    r.send("long work");
    r.fake.events(vec![started()]);
    r.session.cancel();
    assert_eq!(r.fake.count(|c| *c == Call::Interrupt), 1);
    assert_eq!(r.session.state(), AgentSessionState::Cancelling);
    r.fake.events(vec![finished(TurnFinishReason::Interrupted)]);
    r.idle();
    // the backend ended it: the watchdog finds nothing to kill, even past its grace
    std::thread::sleep(timing().cancel_grace * 2);
    assert_eq!(r.fake.count(|c| matches!(c, Call::Close(_))), 0);
}

#[test]
fn an_interrupt_the_backend_ignores_is_escalated_to_a_kill_after_the_grace() {
    let r = Rig::new();
    r.send("long work");
    r.fake.events(vec![started()]);
    r.until("init seen", |s, _| s == AgentSessionState::Running);
    r.session.cancel();
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| *c == Call::Close(Close::Kill)) < 1 {
        assert!(Instant::now() < deadline, "the watchdog never killed it");
        std::thread::sleep(Duration::from_millis(10));
    }
    r.fake.ended(137);
    let events = r.until("the end of the process", |_, ev| {
        ev.iter()
            .any(|e| matches!(e, AgentEvent::SessionEnded { .. }))
    });
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::SessionEnded {
            reason: SessionEndReason::Killed,
            ..
        }
    )));
    assert_eq!(r.session.state(), AgentSessionState::Idle);
}

#[test]
fn a_stop_that_lands_during_a_slow_start_is_applied_when_start_returns() {
    let r = Rig::new();
    let (entered_tx, entered_rx) = channel();
    let (release_tx, release_rx) = channel();
    *r.fake.hold_start.lock() = Some((entered_tx, release_rx));
    let session = Arc::clone(&r.session);
    let sending = std::thread::spawn(move || session.send(Outgoing::text("work")));
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    // the connection does not exist yet: the stop has nothing to signal
    r.session.shutdown();
    assert_eq!(r.fake.count(|c| matches!(c, Call::Close(_))), 0);
    release_tx.send(()).unwrap();
    sending.join().unwrap().unwrap();
    assert_eq!(
        r.fake
            .calls()
            .iter()
            .filter(|c| matches!(c, Call::Close(Close::Kill)))
            .count(),
        1
    );
    // the connection ends, and the chat ends with it
    r.fake.ended(137);
    let events = r.until("the end", |s, _| s == AgentSessionState::Ended);
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::SessionEnded {
            reason: SessionEndReason::VaultSwitched,
            ..
        }
    )));
}

#[test]
fn a_start_that_fails_to_run_the_program_is_an_error_and_nothing_is_sent() {
    let r = Rig::new();
    *r.fake.fail_start.lock() = Some(SpawnError::Failed {
        kind: AgentErrorKind::SpawnFailed,
        message: "fake: permission denied".into(),
        retryable: true,
    });
    r.send("work");
    let events = r.until("the error", |s, _| s == AgentSessionState::Error);
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::Error { kind: AgentErrorKind::SpawnFailed, message, retryable: true }
            if message == "fake: permission denied"
    )));
    assert_eq!(r.fake.count(|c| matches!(c, Call::Send { .. })), 0);
}

#[test]
fn a_confirmed_unqueue_ordered_before_the_turns_end_does_not_hold_the_turn() {
    let r = Rig::new();
    r.send("work");
    let id = "33333333-3333-4333-8333-333333333333";
    r.session
        .queue_line(Outgoing::text("also this"), id)
        .unwrap();
    r.fake.events(vec![started()]);
    // the order the real transport guarantees: the confirmation, then the result right behind it
    assert!(r.session.unqueue(id).unwrap());
    r.fake.events(vec![finished(TurnFinishReason::Completed)]);
    r.idle();
}

#[test]
fn a_permission_is_answered_through_the_transport() {
    let r = Rig::new();
    r.send("work");
    r.fake.events(vec![started(), permission("p1")]);
    r.until("the card", |s, _| {
        s == AgentSessionState::AwaitingPermission
    });
    r.session
        .permission(
            "p1",
            PermissionDecision::Allow,
            Some(PermissionPersist::Project),
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        r.fake.calls().last(),
        Some(&Call::Permission {
            id: "p1".into(),
            allow: true,
            text: "1 updates".into()
        })
    );
    assert_eq!(r.session.state(), AgentSessionState::Running);
    // a deny carries the user's reason, else the default words
    r.fake.events(vec![permission("p2")]);
    r.until("the second card", |s, _| {
        s == AgentSessionState::AwaitingPermission
    });
    r.session
        .permission(
            "p2",
            PermissionDecision::Deny,
            None,
            None,
            Some("  not now ".into()),
        )
        .unwrap();
    assert_eq!(
        r.fake.calls().last(),
        Some(&Call::Permission {
            id: "p2".into(),
            allow: false,
            text: "not now".into()
        })
    );
    assert!(r
        .session
        .permission("p2", PermissionDecision::Allow, None, None, None)
        .is_err());
}

#[test]
fn a_question_is_answered_through_the_transport_and_an_unknown_one_is_refused() {
    let r = Rig::new();
    r.send("work");
    r.fake.events(vec![started(), question("q1")]);
    r.until("the card", |s, _| {
        s == AgentSessionState::AwaitingPermission
    });
    // the transport does not know it: the card stays open
    *r.fake.knows_question.lock() = false;
    assert!(r.session.answer_question("q1", None).is_err());
    *r.fake.knows_question.lock() = true;
    r.session
        .answer_question(
            "q1",
            Some(vec![QuestionAnswer {
                question: "Which?".into(),
                answers: vec!["A".into()],
            }]),
        )
        .unwrap();
    assert_eq!(
        r.fake.calls().last(),
        Some(&Call::Question {
            id: "q1".into(),
            answered: true
        })
    );
    let events = r.until("resolved", |_, ev| {
        ev.iter()
            .any(|e| matches!(e, AgentEvent::QuestionResolved { .. }))
    });
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::QuestionResolved {
            resolution: QuestionResolution::Answered,
            ..
        }
    )));
}

#[test]
fn a_connection_that_ends_during_a_turn_is_resumed_in_the_transports_words() {
    let r = Rig::new();
    r.send("work");
    r.fake.events(vec![started()]);
    r.until("init seen", |s, _| s == AgentSessionState::Running);
    r.fake.ended(1);
    let events = r.until("the notice", |_, ev| {
        ev.iter().any(|e| {
            matches!(e, AgentEvent::Error { message, .. } if message == "fake: connection lost")
        })
    });
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::TurnFinished { errors, .. } if errors == &vec!["fake: ended in the turn".to_string()]
    )));
    // the Session starts the transport again, resuming the session
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| matches!(c, Call::Start { .. })) < 2 {
        assert!(Instant::now() < deadline, "no second start");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        r.fake
            .calls()
            .into_iter()
            .rfind(|c| matches!(c, Call::Start { .. })),
        Some(Call::Start {
            resume: true,
            session: CHAT.into()
        })
    );
}

#[test]
fn a_message_the_connection_lost_before_it_was_taken_is_not_lost() {
    let r = Rig::new();
    r.send("work");
    // ended before any init: the message goes again to the next start
    r.fake.ended(1);
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| matches!(c, Call::Send { .. })) < 2 {
        assert!(Instant::now() < deadline, "the message was not sent again");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(r.fake.calls().last(), Some(&send_call("work", "start")));
}

#[test]
fn closing_asks_the_transport_gracefully_and_its_end_ends_the_chat() {
    let r = Rig::new();
    r.send("work");
    r.fake
        .events(vec![started(), finished(TurnFinishReason::Completed)]);
    r.idle();
    r.session.close();
    assert_eq!(r.fake.calls().last(), Some(&Call::Close(Close::Graceful)));
    r.fake.ended(0);
    let events = r.until("the end", |s, _| s == AgentSessionState::Ended);
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::SessionEnded {
            reason: SessionEndReason::Closed,
            ..
        }
    )));
    assert!(r.session.is_terminal());
}

#[test]
fn what_only_a_restart_can_apply_restarts_the_connection_when_idle() {
    let r = Rig::new();
    r.send("work");
    r.fake
        .events(vec![started(), finished(TurnFinishReason::Completed)]);
    r.idle();
    // a model switch the transport can only apply by restarting
    *r.fake.model.lock() = LiveChange::Restart;
    r.session.set_model(Some("other".into()), None);
    assert!(r.fake.calls().contains(&Call::Model(Some("other".into()))));
    assert_eq!(r.fake.calls().last(), Some(&Call::Close(Close::Terminate)));
    // a live change the backend then refused restarts too (nothing running now: at once)
    let r = Rig::new();
    r.send("work");
    r.fake
        .events(vec![started(), finished(TurnFinishReason::Completed)]);
    r.idle();
    r.session
        .set_permission_mode(AgentPermissionMode::AcceptEdits);
    assert_eq!(
        r.fake.calls().last(),
        Some(&Call::Mode(AgentPermissionMode::AcceptEdits))
    );
    r.fake.say(Message::Refused);
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| *c == Call::Close(Close::Terminate)) < 1 {
        assert!(Instant::now() < deadline, "no restart");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_message_of_a_replaced_connection_is_dropped() {
    let r = Rig::new();
    r.send("work");
    r.fake.events(vec![started()]);
    r.until("init seen", |s, _| s == AgentSessionState::Running);
    // the connection ends mid-turn and the Session starts the next one (a new generation)
    r.fake.ended(1);
    let deadline = Instant::now() + Duration::from_secs(10);
    while r.fake.count(|c| matches!(c, Call::Start { .. })) < 2 {
        assert!(Instant::now() < deadline, "no second start");
        std::thread::sleep(Duration::from_millis(10));
    }
    let current = r.fake.gen.load(Ordering::SeqCst);
    // the replaced connection's messages arrive late: dropped
    r.fake
        .inbound
        .send(Inbound {
            gen: current - 1,
            message: Message::Mapped(Mapped {
                events: vec![text("ghost")],
                ..Mapped::default()
            }),
        })
        .unwrap();
    r.fake.events(vec![text("real")]);
    let events = r.until("the real text", |_, ev| ev.contains(&text("real")));
    assert!(!events.contains(&text("ghost")));
}

#[test]
fn a_backend_that_is_gone_ends_the_session_for_good_with_one_error() {
    let r = Rig::new();
    *r.fake.fail_start.lock() = Some(SpawnError::Gone);
    r.send("work");
    let events = r.until("the end", |s, _| s == AgentSessionState::Ended);
    assert!(r.session.is_terminal(), "a gone backend is terminal");
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Error { .. }))
            .count(),
        1,
        "{events:?}"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::SessionEnded { .. })));
    assert_eq!(r.fake.count(|c| matches!(c, Call::Send { .. })), 0);
}
