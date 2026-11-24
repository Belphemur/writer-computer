//! [`OpencodeTransport`]: one chat's `Transport` over the window's [`OpencodeServer`] (spec
//! `SPECs/opencode-backend-spec.md` section 5).
//!
//! The contract with the `Session`: only `start` and `unqueue` may block. Everything else here
//! returns at once and queues a [`Cmd`] to the transport's worker, a task on the server's
//! runtime that runs them in order (a prompt and the interrupt that follows it stay in order). A
//! second task maps what the server says ([`MapState`], pure) and pushes it into the chat's
//! inbound channel, tagged with the generation of the start it belongs to.
//!
//! - **Session**: created at the first send (nothing is made for a chat that never speaks) or
//!   opened again on a resume; its id is OpenCode's own and travels in `SessionStarted`.
//! - **Messages**: a stable `msg_` id derived from the receipt, so the `Session`'s re-send after
//!   a crash is the same item (spec A8). Steer is a steering prompt plus `interrupt?resume=true`.
//! - **Permissions**: the mode's rules and agent come from a [`Policy`] (phase 3 gives the real
//!   one); a deny always carries a message, because without one the turn ends.
//! - **Failures**: an unreachable server ends the generation (the `Session` restarts it and the
//!   same message is sent again); an answer of 4xx is an error card.
//!
//! Never logged: text, ids of files, paths, error bodies.

use super::client::{ApiError, Client, LONG, SHORT};
use super::opencode_api::{self as api, *};
use super::opencode_events::MapState;
use super::server::{ChatInput, Connection, OpencodeServer, ServerError};
use crate::agent::events::*;
use crate::agent::files::{FileKind, FilePart};
use crate::agent::permission_update::{allow_rules, updated_permissions, AllowRule};
use crate::agent::transport::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

static PHRASES: Phrases = Phrases {
    not_found: "The opencode program was not found",
    exited_idle: "OpenCode stopped while idle; it restarts on the next message",
    connection_lost: "Connection to OpenCode lost, resuming",
    ended_in_turn: "OpenCode stopped during the turn",
    keeps_exiting: "OpenCode keeps stopping; send a message to try again",
    no_answer: "OpenCode did not answer",
};

/// What the permission modes mean to OpenCode (phase 3's builder implements it from Writer's
/// own rules; tests bring a fixed one).
pub trait Policy: Send + Sync {
    /// The session's rules in `mode`, always set on the session before a prompt (empty outside of
    /// Plan: an empty list is what clears the rules of the mode before).
    fn session_rules(&self, mode: AgentPermissionMode) -> Vec<Value>;
    /// The rules a sub-agent's session gets as soon as it exists (it inherits its parent's, which
    /// can allow more than its role may).
    fn child_rules(&self, mode: AgentPermissionMode) -> Option<Vec<Value>>;
    /// The agent that carries `mode`.
    fn agent(&self, mode: AgentPermissionMode) -> Option<String>;
    /// The agents that are Writer's: the server may run these and no other (the transport checks
    /// the server's list once the session exists). Empty: nothing is checked.
    fn known_agents(&self) -> Vec<String> {
        Vec::new()
    }
    /// Why the chat may not start on `model`, `None` when it may (a model the user switched off).
    /// A chat that names none runs on the server's own default: Writer resolves a blank model
    /// before the start (one resolver, the web's), never here.
    fn refuse_model(&self, _model: &ModelRef) -> Option<String> {
        None
    }
    /// Writer answers this request of the chat's own session `once` itself, no card (the mode
    /// accepts it: edits under accept-edits; the chat's own memory folder). Never for a
    /// sub-agent's session, and never as an OpenCode session rule: a session-level allow beats a
    /// role's own deny (spec 10.9).
    fn auto_allow(&self, ask: &Ask<'_>) -> bool;
    /// The text of Writer's OpenCode config file for this launch (spec section 8), `Ok(None)`
    /// when the policy does not own the file (the transport then leaves it as it is). Written
    /// before the server starts and again at every start: a change is a location reload. An
    /// error (a policy that cannot say what Writer's agents are) fails the start, at once.
    fn config(&self, _launch: &LaunchConfig) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// One request of the chat's own session, as a [`Policy`] decides on it.
pub struct Ask<'a> {
    pub mode: AgentPermissionMode,
    /// OpenCode's permission action (`edit`, `shell`, ...).
    pub action: &'a str,
    pub resources: &'a [String],
    /// The vault root (canonical).
    pub root: &'a Path,
    /// The session's working directory: a relative resource is relative to it, as far as known.
    pub cwd: &'a Path,
    /// The chat's memory folder (setting `agent.memory` = `vault`), absolute.
    pub memory: Option<&'a Path>,
}

/// OpenCode's own internal agents: hidden, never offered to the user, run by the server itself
/// (the context summary, its compaction). The contract (2.4.0) says only that an agent has a
/// `hidden` flag, not whether a model may launch a hidden sub-agent, so a hidden agent is trusted
/// by these names alone and any other one is as foreign as a visible one. (`title` is switched
/// off in Writer's config; it is listed in case a server shows it anyway.)
const SYSTEM_AGENTS: [&str; 3] = ["compaction", "summary", "title"];

/// The first agent of the server's list that Writer did not configure and that could run: enabled,
/// of a mode a model or the user can pick, and not one of OpenCode's own system agents.
pub(super) fn foreign_agent<'a>(agents: &'a [Value], ours: &[String]) -> Option<&'a str> {
    agents.iter().find_map(|a| {
        let id = a["id"].as_str()?;
        let runs = a["disabled"] != true
            && matches!(a["mode"].as_str(), Some("subagent" | "primary" | "all"));
        let ok =
            ours.iter().any(|o| o == id) || (a["hidden"] == true && SYSTEM_AGENTS.contains(&id));
        (runs && !ok).then_some(id)
    })
}

/// How long the server may take to put Writer's configuration in force (about a second in the
/// spike), in all: the agent list is looked at, a quarter of a second apart, until then.
const AGENT_DEADLINE: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 20_000 });
const AGENT_POLL: Duration = Duration::from_millis(if cfg!(test) { 10 } else { 250 });
/// The name of Writer's own instruction entry of a session.
pub const INSTRUCTION_KEY: &str = "writer";
/// What a skipped question tells the model.
const SKIPPED: &str = "The user skipped this question.";
/// What a declined request tells the model when the user wrote nothing.
const DECLINED: &str = "The user declined this request.";

enum Cmd {
    /// A resumed chat: check the session still exists and read back what the stream missed.
    Open {
        gen: u64,
    },
    Send(SendCmd),
    Interrupt {
        gen: u64,
    },
    Permission {
        id: String,
        decision: &'static str,
        message: Option<String>,
        /// Rules the user asked to keep for this session only.
        session_rules: Vec<AllowRule>,
        /// "Accept edits from now on": the chat's mode changes.
        accept_edits: bool,
    },
    Question {
        id: String,
        answers: Option<Vec<QuestionAnswer>>,
    },
    Model {
        gen: u64,
    },
    Mode {
        gen: u64,
    },
    Discard {
        receipt: String,
    },
    Reload {
        gen: u64,
    },
    Close {
        gen: u64,
        how: Close,
    },
    /// The transport is dropped: what was queued before has run, the worker ends.
    Stop,
}

struct SendCmd {
    gen: u64,
    /// The `Session`'s id of the message (OpenCode's own is `id`).
    receipt: String,
    text: String,
    files: Vec<Value>,
    delivery: Option<&'static str>,
    steer: bool,
    start: bool,
}

#[derive(Default)]
struct TState {
    gen: u64,
    /// The generation that already got its `Ended`.
    ended: Option<u64>,
    session: Option<String>,
    /// The id to open on the next resume start.
    resume: Option<String>,
    map: Option<MapState>,
    key: u64,
    mode: Option<AgentPermissionMode>,
    model: Option<ModelRef>,
    system_prompt: Option<String>,
    memory: Option<PathBuf>,
    /// What the user allowed for this chat only (`{action, resource}`): Writer answers a matching
    /// request of the chat's own session itself.
    kept: Vec<AllowRule>,
    /// Ids are global on the server: a message id another session holds is a 409. The receipt a
    /// message was re-sent under then (a fresh one), by the receipt it was first given.
    alias: HashMap<String, String>,
    /// The way back: a fresh receipt's original, for what the server says of the message.
    unalias: HashMap<String, String>,
    /// The generation a `SessionStarted` was sent for.
    announced: Option<u64>,
    /// The session's rules of the current mode are not known to be set (the last attempt failed,
    /// or the mode changed while the server was away): no prompt goes before they are.
    rules_pending: bool,
    /// Message ids the server already holds (inbox and message list), read when a chat is
    /// resumed: a re-send of one of them is not posted again (spec A8).
    held: Option<HashSet<String>>,
    /// Inbox ids the server delivered (a cancel of one of them is a no-op).
    delivered: HashSet<String>,
}

/// A caller of `unqueue` waiting for the server's word on one inbox item.
struct Waiter {
    receipt: String,
    tx: Sender<bool>,
}

struct TInner {
    server: Arc<OpencodeServer>,
    inbound: Sender<Inbound>,
    root: PathBuf,
    cwd: PathBuf,
    policy: Arc<dyn Policy>,
    cmd: UnboundedSender<Cmd>,
    st: Mutex<TState>,
    waiters: Mutex<HashMap<String, Waiter>>,
}

pub struct OpencodeTransport {
    inner: Arc<TInner>,
}

impl OpencodeTransport {
    pub fn new(init: TransportInit, server: Arc<OpencodeServer>, policy: Arc<dyn Policy>) -> Self {
        let (cmd, cmd_rx) = unbounded_channel();
        let (ev, ev_rx) = unbounded_channel();
        let sink: super::server::Sink = {
            let ev = ev;
            Arc::new(move |input| {
                let _ = ev.send(input);
            })
        };
        let key = server.register(sink);
        let inner = Arc::new(TInner {
            server: Arc::clone(&server),
            inbound: init.inbound,
            root: init.root,
            cwd: init.cwd,
            policy,
            cmd,
            st: Mutex::new(TState {
                key,
                ..TState::default()
            }),
            waiters: Mutex::default(),
        });
        let io = Arc::clone(server.io());
        // both tasks own the chat until their channel closes: the commands queued before a drop
        // still run (the worker ends on `Stop`, the events task when its sink is released)
        io.spawn(worker(Arc::clone(&inner), cmd_rx));
        io.spawn(events(Arc::clone(&inner), ev_rx));
        Self { inner }
    }

    fn queue(&self, cmd: Cmd) {
        let _ = self.inner.cmd.send(cmd);
    }

    fn gen(&self) -> u64 {
        self.inner.st.lock().gen
    }
}

impl Drop for OpencodeTransport {
    fn drop(&mut self) {
        let key = self.inner.st.lock().key;
        self.inner.server.release(key);
        let _ = self.inner.cmd.send(Cmd::Stop);
    }
}

fn file_value(f: &FilePart) -> Value {
    let kind = match f.kind {
        FileKind::Image => "image",
        FileKind::Document => "document",
    };
    json!({
        "uri": format!("data:{};base64,{}", f.media_type, f.data),
        "source": {"type": "inline"},
        "name": kind,
    })
}

/// The model a start asks for, `None` when the chat names none.
fn requested_model(req: &StartRequest<'_>) -> Option<ModelRef> {
    req.launch
        .settings
        .model
        .as_deref()
        .and_then(ModelRef::parse)
}

impl Transport for OpencodeTransport {
    fn phrases(&self) -> &'static Phrases {
        &PHRASES
    }

    fn start(&self, req: &StartRequest<'_>) -> Result<(), SpawnError> {
        let failed = |e: ServerError| match e {
            ServerError::NotFound => SpawnError::NotFound,
            ServerError::Closed => SpawnError::Gone,
            ServerError::Unsupported(_) => SpawnError::Failed {
                kind: AgentErrorKind::SpawnFailed,
                message: e.to_string(),
                retryable: false,
            },
            ServerError::Failed(m) => SpawnError::Failed {
                kind: AgentErrorKind::SpawnFailed,
                message: m,
                retryable: true,
            },
        };
        // the config file first: a server that starts reads it, one that is up reads it again
        // when it changed (a role, the MCP server, a new instruction file)
        let config =
            self.inner
                .policy
                .config(req.launch)
                .map_err(|message| SpawnError::Failed {
                    kind: AgentErrorKind::SpawnFailed,
                    message,
                    retryable: false,
                })?;
        if let Some(text) = config {
            self.inner.server.apply_config(&text).map_err(failed)?;
        }
        if let Some(why) = requested_model(req).and_then(|m| self.inner.policy.refuse_model(&m)) {
            return Err(SpawnError::Invalid(why));
        }
        let _conn: Connection = self.inner.server.ensure_started().map_err(failed)?;
        {
            let mut st = self.inner.st.lock();
            st.gen = req.gen;
            st.ended = None;
            let s = &req.launch.settings;
            st.mode = Some(s.permission_mode);
            st.system_prompt = req.launch.system_prompt.clone();
            st.memory = req.launch.memory_dir.clone();
            if let Some(m) = s.model.as_deref().and_then(ModelRef::parse) {
                st.model = Some(ModelRef {
                    variant: s
                        .effort
                        .map(|e| e.as_cli_arg().to_string())
                        .or(m.variant.clone()),
                    ..m
                });
            }
            st.resume = (req.resume && st.session.is_none()).then(|| req.session_id.to_string());
        }
        self.inner.push(req.gen, Message::Started { pid: None });
        if req.resume {
            self.queue(Cmd::Open { gen: req.gen });
        }
        Ok(())
    }

    fn send(&self, msg: &Outbound<'_>) -> Receipt {
        let (receipt, delivery, steer, start) = match msg.delivery {
            Delivery::Start { receipt } => (receipt.to_string(), None, false, true),
            Delivery::Steer { receipt } => (receipt.to_string(), Some("steer"), true, false),
            Delivery::Queued { receipt } => (receipt.to_string(), Some("queue"), false, false),
        };
        let id = self.inner.wire_id(&receipt);
        self.queue(Cmd::Send(SendCmd {
            gen: self.gen(),
            receipt: receipt.clone(),
            text: msg.text.to_string(),
            files: msg.files.iter().map(file_value).collect(),
            delivery,
            steer,
            start,
        }));
        Receipt {
            message_id: receipt,
            backend_id: id,
        }
    }

    fn unqueue(&self, receipt: &str, wait: Duration) -> Result<bool, Unanswered> {
        let (Some(session), Some(conn)) = (
            self.inner.st.lock().session.clone(),
            self.inner.server.connection(),
        ) else {
            // no session or no server: nothing waits anywhere
            return Ok(false);
        };
        let inbox = self.inner.wire_id(receipt);
        if self.inner.st.lock().delivered.contains(&inbox) {
            return Ok(false);
        }
        // the DELETE answers 204 whether or not it cancelled: the outcome is the first of
        // `inbox.cancelled` (gone) and `inbox.delivered` (taken), read by the events task, which
        // also says `Unqueued` in stream order, even for an answer that comes after this call
        // gave up
        let (tx, rx) = channel();
        self.inner.waiters.lock().insert(
            inbox.clone(),
            Waiter {
                receipt: receipt.to_string(),
                tx,
            },
        );
        // the event may have come between the check above and the waiter: nobody would answer it
        if self.inner.st.lock().delivered.contains(&inbox) {
            self.inner.waiters.lock().remove(&inbox);
            return Ok(false);
        }
        let started = Instant::now();
        let client = conn.client.clone();
        let id = inbox.clone();
        let sent = conn.client.io().call(
            async move {
                client
                    .request(
                        &api::INBOX_CANCEL,
                        &[("sessionID", &session), ("inboxID", &id)],
                        &[],
                        None,
                        SHORT,
                    )
                    .await
            },
            wait,
        );
        match sent {
            Some(Ok(_)) => {}
            // the server refused the call: nothing is waiting for it
            Some(Err(ApiError::Status { .. })) => {
                self.inner.waiters.lock().remove(&inbox);
                return Ok(false);
            }
            Some(Err(_)) | None => return Err(Unanswered),
        }
        rx.recv_timeout(wait.saturating_sub(started.elapsed()))
            .map_err(|_| Unanswered)
    }

    fn discard(&self, receipt: &str) {
        self.queue(Cmd::Discard {
            receipt: receipt.to_string(),
        });
    }

    fn interrupt(&self) {
        self.queue(Cmd::Interrupt { gen: self.gen() });
    }

    fn answer_permission(&self, request_id: &str, reply: PermissionReply<'_>) {
        let (decision, message, session_rules, accept_edits) = match reply {
            PermissionReply::Allow {
                persist,
                rules,
                suggestions,
                ..
            } => match persist {
                // for ever, for this project: OpenCode's saved rule
                Some(PermissionPersist::Project) => ("always", None, Vec::new(), false),
                // for this chat only: Writer's own rules (spec 10.9), the ticked ones of the
                // request's suggestions
                Some(PermissionPersist::Session) => {
                    ("once", None, kept_rules(suggestions, rules), false)
                }
                Some(PermissionPersist::AcceptEdits) => ("once", None, Vec::new(), true),
                None => ("once", None, Vec::new(), false),
            },
            PermissionReply::Deny { message } => (
                "reject",
                Some(
                    if message.trim().is_empty() {
                        DECLINED
                    } else {
                        message
                    }
                    .to_string(),
                ),
                Vec::new(),
                false,
            ),
        };
        self.queue(Cmd::Permission {
            id: request_id.to_string(),
            decision,
            message,
            session_rules,
            accept_edits,
        });
    }

    fn answer_question(&self, request_id: &str, answers: Option<&[QuestionAnswer]>) -> bool {
        let known = self
            .inner
            .st
            .lock()
            .map
            .as_ref()
            .is_some_and(|m| m.form_session(request_id).is_some());
        if known {
            self.queue(Cmd::Question {
                id: request_id.to_string(),
                answers: answers.map(<[QuestionAnswer]>::to_vec),
            });
        }
        known
    }

    fn set_model(&self, change: &ModelChange) -> LiveChange {
        {
            let mut st = self.inner.st.lock();
            if let Some(slug) = change.model.as_deref() {
                if let Some(m) = ModelRef::parse(slug) {
                    st.model = Some(m);
                }
            }
            if change.model_changed || change.effort_changed {
                if let Some(m) = st.model.as_mut() {
                    m.variant = change.effort.map(|e| e.as_cli_arg().to_string());
                }
            }
        }
        self.queue(Cmd::Model { gen: self.gen() });
        LiveChange::Applied
    }

    fn set_permission_mode(&self, mode: AgentPermissionMode) {
        {
            let mut st = self.inner.st.lock();
            st.mode = Some(mode);
            // set on the session before the next prompt, whoever gets there first
            st.rules_pending = true;
        }
        self.queue(Cmd::Mode { gen: self.gen() });
    }

    fn reload(&self) {
        self.queue(Cmd::Reload { gen: self.gen() });
    }

    fn close(&self, how: Close) {
        self.queue(Cmd::Close {
            gen: self.gen(),
            how,
        });
    }
}

/// The rules Writer keeps for a chat: what the card's "this chat" choice selects among the
/// request's own suggestions, read through the one conversion every backend shares
/// (`permission_update`), never from anything the card sends but the ticked rules.
pub(super) fn kept_rules(suggestions: &[Value], ticked: Option<&[String]>) -> Vec<AllowRule> {
    allow_rules(&updated_permissions(
        suggestions,
        Some(PermissionPersist::Session),
        ticked,
    ))
}

impl TInner {
    fn push(&self, gen: u64, message: Message) {
        let _ = self.inbound.send(Inbound { gen, message });
    }

    /// OpenCode's id of the message the `Session` knows by `receipt`.
    fn wire_id(&self, receipt: &str) -> String {
        let st = self.st.lock();
        message_id_for(st.alias.get(receipt).map_or(receipt, String::as_str))
    }

    /// The `Session`'s receipt for one the server named (the original of a re-sent message).
    fn original(&self, receipt: Option<String>) -> Option<String> {
        let r = receipt?;
        Some(self.st.lock().unalias.get(&r).cloned().unwrap_or(r))
    }

    fn push_mapped(&self, gen: u64, mut m: Mapped) {
        m.taken = self.original(m.taken.take());
        m.accepted = self.original(m.accepted.take());
        if m.events.is_empty() && m.tasks.is_empty() && m.taken.is_none() && m.accepted.is_none() {
            return;
        }
        self.push(gen, Message::Mapped(m));
    }

    fn events(&self, gen: u64, events: Vec<AgentEvent>) {
        self.push_mapped(
            gen,
            Mapped {
                events,
                ..Mapped::default()
            },
        );
    }

    /// The last message of a generation, once.
    fn end(&self, gen: u64, ended: Ended) {
        {
            let mut st = self.st.lock();
            if st.ended == Some(gen) || st.gen != gen {
                return;
            }
            st.ended = Some(gen);
        }
        self.push(gen, Message::Ended(ended));
    }

    fn gone(&self, gen: u64) {
        self.end(
            gen,
            Ended {
                code: None,
                signal: None,
                session_unknown: false,
            },
        );
    }

    /// A failed call on the live path.
    fn failed(&self, gen: u64, e: ApiError, finishes_turn: bool) {
        if e.is_down() || self.server.connection().is_none() {
            return self.gone(gen);
        }
        let kind = match &e {
            ApiError::Status { status: 401, .. } => AgentErrorKind::Auth,
            ApiError::Status { status: 429, .. } => AgentErrorKind::RateLimit,
            _ => AgentErrorKind::Api,
        };
        let mut events = vec![AgentEvent::Error {
            kind,
            message: e.to_string(),
            retryable: false,
        }];
        if finishes_turn {
            events.push(AgentEvent::TurnFinished {
                reason: TurnFinishReason::Error,
                duration_ms: 0,
                api_duration_ms: None,
                num_turns: None,
                is_error: true,
                result: None,
                session_id: self.st.lock().session.clone(),
                errors: vec![e.to_string()],
            });
        }
        self.events(gen, events);
    }

    fn client(&self) -> Option<Client> {
        self.server.connection().map(|c| c.client)
    }

    /// The generation is the live one: a command of an older start, or of one that ended, is
    /// dropped (the `Session` has moved on, and a send of a failed start must not make a session).
    fn current(&self, gen: u64) -> bool {
        let st = self.st.lock();
        st.gen == gen && st.ended != Some(gen)
    }

    async fn run(&self, cmd: Cmd) {
        let gated = match &cmd {
            Cmd::Open { gen }
            | Cmd::Interrupt { gen }
            | Cmd::Model { gen }
            | Cmd::Mode { gen }
            | Cmd::Reload { gen } => Some(*gen),
            Cmd::Send(s) => Some(s.gen),
            _ => None,
        };
        if gated.is_some_and(|g| !self.current(g)) {
            return;
        }
        match cmd {
            Cmd::Open { gen } => self.open(gen).await,
            Cmd::Send(s) => self.send(s).await,
            Cmd::Interrupt { gen } => {
                if let Some((client, session)) = self.live() {
                    if let Err(e) = interrupt(&client, &session, false).await {
                        self.failed(gen, e, false);
                    }
                }
            }
            Cmd::Permission {
                id,
                decision,
                message,
                session_rules,
                accept_edits,
            } => {
                self.permission(id, decision, message, session_rules, accept_edits)
                    .await
            }
            Cmd::Stop => {}
            Cmd::Question { id, answers } => self.question(id, answers).await,
            Cmd::Model { gen } => self.model(gen).await,
            Cmd::Mode { gen } => self.mode(gen).await,
            Cmd::Discard { receipt } => {
                if let Some((client, session)) = self.live() {
                    let id = self.wire_id(&receipt);
                    let _ = client
                        .request(
                            &api::INBOX_CANCEL,
                            &[("sessionID", &session), ("inboxID", &id)],
                            &[],
                            None,
                            SHORT,
                        )
                        .await;
                }
            }
            Cmd::Reload { gen } => {
                // read again at the server's idle moment (another chat may be mid-turn)
                if let Err(e) = self.server.reload_when_idle().await {
                    if e.is_down() {
                        return self.gone(gen);
                    }
                }
                // the chat starts again and opens its session: the server re-read its config
                self.end(
                    gen,
                    Ended {
                        code: Some(0),
                        signal: None,
                        session_unknown: false,
                    },
                );
            }
            Cmd::Close { gen, how } => {
                if how != Close::Graceful {
                    if let Some((client, session)) = self.live() {
                        let _ = interrupt(&client, &session, false).await;
                    }
                }
                self.end(
                    gen,
                    Ended {
                        code: Some(0),
                        signal: None,
                        session_unknown: false,
                    },
                );
            }
        }
    }

    fn live(&self) -> Option<(Client, String)> {
        let session = self.st.lock().session.clone()?;
        Some((self.client()?, session))
    }

    /// Sets the session's rules and agent of the current mode (no prompt may go before this
    /// worked: Plan must hold from the first prompt, also for a session resumed after a mode
    /// change made while the server was away).
    async fn apply_mode(&self, client: &Client, session: &str) -> Result<(), ApiError> {
        let mode = self.st.lock().mode.unwrap_or(AgentPermissionMode::Manual);
        self.st.lock().rules_pending = true;
        // the agent list is Writer's own before any session is given an agent of it
        self.ensure_agents(client).await?;
        client
            .request(
                &api::SESSION_PATCH,
                &[("sessionID", session)],
                &[],
                serde_json::to_value(PatchSessionBody {
                    permissions: self.policy.session_rules(mode),
                })
                .ok(),
                SHORT,
            )
            .await?;
        if let Some(agent) = self.policy.agent(mode) {
            client
                .send(
                    &api::AGENT_SET,
                    &[("sessionID", session)],
                    &SetAgentBody { agent },
                    SHORT,
                )
                .await?;
        }
        self.st.lock().rules_pending = false;
        Ok(())
    }

    /// The session exists: own it, start its mapper, set its rules, tell the pane. An error means
    /// the rules are not set or the agents are not Writer's: the caller refuses the turn
    /// (`rules_pending` stays, so a later send tries again before it prompts, and announces the
    /// session then; the agent check is made again too, it is a gate every prompt passes).
    async fn ready(&self, gen: u64, client: &Client, session: &str) -> Result<(), ApiError> {
        let key = {
            let mut st = self.st.lock();
            st.session = Some(session.to_string());
            if st.map.is_none() {
                st.map = Some(MapState::new(session));
            }
            st.key
        };
        self.server.own(key, session);
        self.apply_mode(client, session).await?;
        self.announce(gen, client, session).await;
        Ok(())
    }

    /// The server runs Writer's configuration and nothing else: once the location is up (the
    /// list is the built-in one until it boots, which takes a moment) its agents must be Writer's
    /// own, OpenCode's hidden system agents (`SYSTEM_AGENTS`) aside. Any other enabled agent
    /// would run with rules Writer did not write, so the start is refused. One deadline covers
    /// the whole wait, each request included.
    async fn ensure_agents(&self, client: &Client) -> Result<(), ApiError> {
        let Some(conn) = self.server.connection() else {
            return Err(ApiError::Refused("OpenCode is not running".into()));
        };
        // once per start of the server: a refusal leaves the gate shut for the next send
        if self.server.agents_verified(conn.epoch) {
            return Ok(());
        }
        self.check_agents(client).await?;
        self.server.verify_agents(conn.epoch);
        Ok(())
    }

    async fn check_agents(&self, client: &Client) -> Result<(), ApiError> {
        let ours = self.policy.known_agents();
        if ours.is_empty() {
            return Ok(());
        }
        let mode = self.st.lock().mode.unwrap_or(AgentPermissionMode::Manual);
        let sentinel = self.policy.agent(mode);
        let until = tokio::time::Instant::now() + AGENT_DEADLINE;
        while tokio::time::Instant::now() < until {
            let list = tokio::time::timeout_at(until, client.get(&api::AGENTS, &[]))
                .await
                .map_err(|_| ApiError::Timeout)??;
            let agents = list["data"].as_array().cloned().unwrap_or_default();
            let loaded = sentinel
                .as_deref()
                .is_none_or(|s| agents.iter().any(|a| a["id"] == s));
            if loaded {
                return if foreign_agent(&agents, &ours).is_some() {
                    Err(ApiError::Refused(
                        "OpenCode has agents Writer did not configure; Writer will not run a chat with them".into(),
                    ))
                } else {
                    Ok(())
                };
            }
            tokio::time::sleep(AGENT_POLL).await;
        }
        Err(ApiError::Refused(
            "OpenCode did not load Writer's configuration".into(),
        ))
    }

    /// Puts Writer's instructions on the session. `false`: the server is gone (the chat is told);
    /// any other failure is an error card and the chat goes on without them.
    async fn put_instructions(
        &self,
        gen: u64,
        client: &Client,
        session: &str,
        prompt: String,
    ) -> bool {
        let body = InstructionBody { value: prompt };
        let put = client
            .send(
                &api::INSTRUCTION_PUT,
                &[("sessionID", session), ("key", INSTRUCTION_KEY)],
                &body,
                SHORT,
            )
            .await;
        if let Err(e) = put {
            // the agent would run without Writer's instructions: say so
            if e.is_down() {
                self.gone(gen);
                return false;
            }
            self.events(
                gen,
                vec![AgentEvent::Error {
                    kind: AgentErrorKind::Api,
                    message: "Writer's instructions could not be set for this chat".into(),
                    retryable: false,
                }],
            );
        }
        true
    }

    /// Writer's instructions on the session, then `SessionStarted`: once per generation, as soon
    /// as the rules are in place (the first `ready`, or the send that retried them).
    async fn announce(&self, gen: u64, client: &Client, session: &str) {
        let prompt = {
            let mut st = self.st.lock();
            if st.announced == Some(gen) {
                return;
            }
            st.announced = Some(gen);
            st.system_prompt.clone()
        };
        if let Some(prompt) = prompt {
            if !self.put_instructions(gen, client, session, prompt).await {
                return;
            }
        }
        let limits = self.limits(client).await;
        let names = |v: Result<Value, ApiError>| -> Vec<String> {
            v.ok()
                .and_then(|v| v.get("data").cloned())
                .and_then(|d| d.as_array().cloned())
                .map(|a| {
                    a.iter()
                        .filter_map(|i| i["name"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        let skills = names(client.get(&api::SKILLS, &[]).await);
        let commands = names(client.get(&api::COMMANDS, &[]).await);
        let mcp: Vec<McpServerStatus> = client
            .get(&api::MCP, &[])
            .await
            .ok()
            .and_then(|v| serde_json::from_value::<Data<Vec<McpState>>>(v).ok())
            .map(|d| {
                d.data
                    .into_iter()
                    .map(|m| McpServerStatus {
                        name: m.name,
                        status: m.status.status,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (model, mode, version) = {
            let mut st = self.st.lock();
            if let Some(m) = st.map.as_mut() {
                m.set_limits(limits);
            }
            (
                st.model.as_ref().map(ModelRef::slug),
                st.mode,
                self.server.connection().map(|c| c.version),
            )
        };
        self.events(
            gen,
            vec![AgentEvent::SessionStarted {
                session_id: session.to_string(),
                model,
                cwd: self.cwd.to_string_lossy().into_owned(),
                permission_mode: mode.and_then(|m| {
                    serde_json::to_value(m)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from))
                }),
                tools: Vec::new(),
                slash_commands: commands,
                skills,
                mcp_servers: mcp,
                cli_version: version,
            }],
        );
    }

    /// The context window of every model (`model.updated` changes them).
    async fn limits(&self, client: &Client) -> HashMap<String, u64> {
        match client.get(&api::MODELS, &[]).await {
            Ok(v) => context_limits(&v),
            Err(_) => HashMap::new(),
        }
    }

    async fn open(&self, gen: u64) {
        let Some(client) = self.client() else {
            return self.gone(gen);
        };
        let Some(id) = ({
            let st = self.st.lock();
            st.session.clone().or_else(|| st.resume.clone())
        }) else {
            return;
        };
        match client.get(&api::SESSION_GET, &[("sessionID", &id)]).await {
            Ok(_) => {
                let fresh = self.st.lock().map.is_none();
                if let Err(e) = self.ready(gen, &client, &id).await {
                    // the session is ours but its rules are not set: nothing is prompted
                    return self.failed(gen, e, false);
                }
                self.read_held(&client, &id).await;
                if fresh {
                    // a new process of this app: the history is the chat note's, not re-sent
                    self.seed(gen, &client, &id).await;
                } else {
                    // what the stream could not say while the server was away
                    self.resync(gen).await;
                }
            }
            Err(e) if e.is_not_found() => {
                self.st.lock().resume = None;
                self.end(
                    gen,
                    Ended {
                        code: None,
                        signal: None,
                        session_unknown: true,
                    },
                );
            }
            Err(e) => self.failed(gen, e, false),
        }
    }

    /// The message ids the server holds (waiting in the inbox, or in the transcript): the
    /// `Session`'s re-send of one of them after a restart is not posted again.
    async fn read_held(&self, client: &Client, session: &str) {
        let mut held = HashSet::new();
        for route in [&api::INBOX, &api::MESSAGES] {
            if let Ok(v) = client.get(route, &[("sessionID", session)]).await {
                for item in v["data"].as_array().into_iter().flatten() {
                    if let Some(id) = item["id"].as_str() {
                        held.insert(id.to_string());
                    }
                }
            }
        }
        self.st.lock().held = Some(held);
    }

    /// A chat resumed in a fresh transport: mark the history, show the running turn.
    async fn seed(&self, gen: u64, client: &Client, session: &str) {
        match client.get(&api::MESSAGES, &[("sessionID", session)]).await {
            Ok(v) => {
                let m = self.st.lock().map.as_mut().map(|m| m.seed(&v));
                if let Some(m) = m {
                    self.push_mapped(gen, m);
                }
            }
            Err(e) => return self.failed(gen, e, false),
        }
        self.pending(gen, client, session).await;
    }

    /// Creates the session of a chat that has none.
    async fn create(&self, gen: u64, client: &Client) -> Result<String, ApiError> {
        let (model, mode) = {
            let st = self.st.lock();
            (
                st.model.clone(),
                st.mode.unwrap_or(AgentPermissionMode::Manual),
            )
        };
        let body = CreateSessionBody {
            location: Location {
                directory: self.cwd.to_string_lossy().into_owned(),
            },
            model,
            agent: self.policy.agent(mode),
            permissions: Some(self.policy.session_rules(mode)).filter(|r| !r.is_empty()),
            parentID: None,
        };
        let v = client.send(&api::SESSION_CREATE, &[], &body, SHORT).await?;
        let created: Data<SessionInfo> = serde_json::from_value(v)
            .map_err(|_| ApiError::Transport("unreadable reply".into()))?;
        let id = created.data.id;
        self.ready(gen, client, &id).await?;
        Ok(id)
    }

    /// A send the server did not take. A start ends its turn; a queued or steered line is
    /// forgotten by the `Session` (it is told so, and its chip with it), or it would wait for an
    /// echo that never comes.
    fn refuse(&self, s: &SendCmd, e: ApiError) {
        let gen = s.gen;
        let down = e.is_down() || self.server.connection().is_none();
        self.failed(gen, e, s.start);
        if !s.start && !down {
            self.events(
                gen,
                vec![AgentEvent::SteerUndelivered {
                    message_id: s.receipt.clone(),
                }],
            );
            self.push(
                gen,
                Message::Unqueued {
                    receipt: s.receipt.clone(),
                },
            );
        }
    }

    async fn send(&self, s: SendCmd) {
        let gen = s.gen;
        let Some(client) = self.client() else {
            return self.gone(gen);
        };
        let known = self.st.lock().session.clone();
        let session = match known {
            Some(id) => id,
            None => match self.create(gen, &client).await {
                Ok(id) => id,
                Err(e) => return self.refuse(&s, e),
            },
        };
        // Plan (or any mode) is on the session before the first prompt, or the turn is refused
        let pending = self.st.lock().rules_pending;
        if pending {
            if let Err(e) = self.apply_mode(&client, &session).await {
                return self.refuse(&s, e);
            }
            self.announce(gen, &client, &session).await;
        }
        // the id as of now: an earlier send of this receipt may have been given a fresh one
        let wire = self.wire_id(&s.receipt);
        // the server holds it already (a re-send after a restart): one delivery
        if self
            .st
            .lock()
            .held
            .as_mut()
            .is_some_and(|h| h.remove(&wire))
        {
            return;
        }
        let mut body = PromptBody {
            id: Some(wire),
            text: s.text.clone(),
            files: s.files.clone(),
            delivery: s.delivery.map(String::from),
        };
        let mut sent = client
            .send(&api::PROMPT, &[("sessionID", &session)], &body, LONG)
            .await;
        // ids are global on the server: one that another session holds (the chat's earlier session
        // was lost and this is a new one) is this message under a fresh id, tracked back to the
        // receipt the `Session` knows it by
        if matches!(&sent, Err(e) if e.is_conflict()) {
            let fresh = uuid::Uuid::new_v4().to_string();
            {
                let mut st = self.st.lock();
                let original = st
                    .unalias
                    .get(&s.receipt)
                    .cloned()
                    .unwrap_or(s.receipt.clone());
                st.alias.insert(s.receipt.clone(), fresh.clone());
                st.unalias.insert(fresh.clone(), original);
            }
            body.id = Some(message_id_for(&fresh));
            sent = client
                .send(&api::PROMPT, &[("sessionID", &session)], &body, LONG)
                .await;
        }
        if let Err(e) = sent {
            return self.refuse(&s, e);
        }
        if s.steer {
            // the steering input waits for the running step to be cut
            if let Err(e) = interrupt(&client, &session, true).await {
                self.failed(gen, e, false);
            }
        }
    }

    async fn permission(
        &self,
        id: String,
        decision: &'static str,
        message: Option<String>,
        session_rules: Vec<AllowRule>,
        accept_edits: bool,
    ) {
        let (session, gen) = {
            let st = self.st.lock();
            (
                st.map
                    .as_ref()
                    .and_then(|m| m.permission_session(&id))
                    .map(String::from)
                    .or_else(|| st.session.clone()),
                st.gen,
            )
        };
        let (Some(client), Some(session)) = (self.client(), session) else {
            return;
        };
        if !session_rules.is_empty() {
            self.st.lock().kept.extend(session_rules);
        }
        if accept_edits {
            self.st.lock().mode = Some(AgentPermissionMode::AcceptEdits);
            self.mode(gen).await;
        }
        let body = PermissionReplyBody {
            decision: decision.to_string(),
            message,
        };
        match client
            .send(
                &api::PERMISSION_REPLY,
                &[("sessionID", &session), ("requestID", &id)],
                &body,
                SHORT,
            )
            .await
        {
            Ok(_) => {}
            // a reject with a message settled its siblings too: they are gone already
            Err(e) if e.is_not_found() => {}
            Err(e) => self.failed(gen, e, false),
        }
    }

    async fn question(&self, id: String, answers: Option<Vec<QuestionAnswer>>) {
        let (target, gen) = {
            let st = self.st.lock();
            (
                st.map.as_ref().and_then(|m| match &answers {
                    Some(a) => m.answer_body(&id, a),
                    None => m.form_session(&id).map(|s| (s.to_string(), Value::Null)),
                }),
                st.gen,
            )
        };
        let (Some(client), Some((session, body))) = (self.client(), target) else {
            return;
        };
        let args = [("sessionID", session.as_str()), ("formID", id.as_str())];
        let done = match answers {
            Some(_) => {
                client
                    .send(
                        &api::FORM_REPLY,
                        &args,
                        &FormReplyBody { answer: body },
                        SHORT,
                    )
                    .await
            }
            None => {
                // the asker is told, and the turn goes on
                client
                    .request(
                        &api::FORM_CANCEL,
                        &args,
                        &[("message", SKIPPED)],
                        None,
                        SHORT,
                    )
                    .await
            }
        };
        match done {
            Ok(_) => {}
            Err(e) if e.is_not_found() => {}
            Err(e) => self.failed(gen, e, false),
        }
    }

    async fn model(&self, gen: u64) {
        let Some((client, session)) = self.live() else {
            // no session yet: the create uses it
            return;
        };
        let Some(model) = self.st.lock().model.clone() else {
            return;
        };
        let refused = client
            .send(
                &api::MODEL_SET,
                &[("sessionID", &session)],
                &SetModelBody { model },
                SHORT,
            )
            .await;
        if let Err(e) = refused {
            if e.is_down() {
                return self.gone(gen);
            }
            self.push(gen, Message::Refused);
        }
    }

    async fn mode(&self, gen: u64) {
        // no session or no server: the change stays pending, and `ready` of the next start
        // (resumed or new) sets it before any prompt
        let Some((client, session)) = self.live() else {
            return;
        };
        if let Err(e) = self.apply_mode(&client, &session).await {
            if e.is_down() {
                return self.gone(gen);
            }
            return self.push(gen, Message::Refused);
        }
        // every sub-agent already running follows the mode too
        let children: Vec<String> = self
            .st
            .lock()
            .map
            .as_ref()
            .map(|m| m.children().map(String::from).collect())
            .unwrap_or_default();
        for child in children {
            self.child_rules(gen, &client, &child).await;
        }
    }

    /// The strict rules of a sub-agent's session. When they cannot be set the child must not run
    /// on what it inherited: it is interrupted, and the chat says why.
    async fn child_rules(&self, gen: u64, client: &Client, child: &str) {
        let mode = self.st.lock().mode.unwrap_or(AgentPermissionMode::Manual);
        let Some(rules) = self.policy.child_rules(mode) else {
            return;
        };
        let patch = client
            .request(
                &api::SESSION_PATCH,
                &[("sessionID", child)],
                &[],
                serde_json::to_value(PatchSessionBody { permissions: rules }).ok(),
                SHORT,
            )
            .await;
        if let Err(e) = patch {
            if e.is_down() {
                return;
            }
            let _ = interrupt(client, child, false).await;
            self.events(
                gen,
                vec![AgentEvent::Error {
                    kind: AgentErrorKind::Api,
                    message: "A sub-agent was stopped: its permissions could not be set".into(),
                    retryable: false,
                }],
            );
        }
    }

    /// Reads back what the stream missed: the message lists of the chat and of every sub-agent,
    /// and the requests still waiting.
    async fn resync(&self, gen: u64) {
        let Some((client, session)) = self.live() else {
            return self.gone(gen);
        };
        match client.get(&api::MESSAGES, &[("sessionID", &session)]).await {
            Ok(v) => {
                let m = self.st.lock().map.as_mut().map(|m| m.resync(&v));
                if let Some(m) = m {
                    self.push_mapped(gen, m);
                }
            }
            Err(e) => return self.failed(gen, e, false),
        }
        // the launch blocks of that list linked the children: their own lists come next
        let children: Vec<String> = self
            .st
            .lock()
            .map
            .as_ref()
            .map(|m| m.children().map(String::from).collect())
            .unwrap_or_default();
        let key = self.st.lock().key;
        for child in &children {
            // a child created while the stream was down never said `session.created`: its later
            // events belong to this chat, and it gets the rules of the mode
            self.server.own(key, child);
            self.child_rules(gen, &client, child).await;
            if let Ok(v) = client.get(&api::MESSAGES, &[("sessionID", child)]).await {
                let m = self
                    .st
                    .lock()
                    .map
                    .as_mut()
                    .map(|m| m.resync_child(child, &v));
                if let Some(m) = m {
                    self.push_mapped(gen, m);
                }
            }
        }
        self.pending(gen, &client, &session).await;
        for child in &children {
            self.pending(gen, &client, child).await;
        }
    }

    /// The permission requests and questions still open in `session`, as the events that would
    /// have shown them.
    async fn pending(&self, gen: u64, client: &Client, session: &str) {
        for (route, kind, wrap) in [
            (&api::PERMISSIONS, "permission.asked", false),
            (&api::FORMS, "form.created", true),
        ] {
            let Ok(v) = client.get(route, &[("sessionID", session)]).await else {
                continue;
            };
            for item in v["data"].as_array().into_iter().flatten() {
                let id = item["id"].as_str().unwrap_or_default();
                let known = {
                    let st = self.st.lock();
                    st.map.as_ref().is_some_and(|m| {
                        m.permission_session(id).is_some() || m.form_session(id).is_some()
                    })
                };
                if known {
                    continue;
                }
                let data = if wrap {
                    json!({"form": item})
                } else {
                    item.clone()
                };
                let ev = WireEvent {
                    id: String::new(),
                    created: 0.0,
                    kind: kind.to_string(),
                    data,
                };
                let m = self.st.lock().map.as_mut().map(|m| m.map(&ev));
                if let Some(m) = m {
                    self.push_mapped(gen, m);
                }
            }
        }
    }

    /// The id of a request of the chat's own session that Writer answers `once` itself.
    fn auto_reply(&self, ev: &WireEvent) -> Option<String> {
        let d = &ev.data;
        let (id, action) = (d["id"].as_str()?, d["action"].as_str()?);
        let resources: Vec<String> = d["resources"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|r| r.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let st = self.st.lock();
        if d["sessionID"].as_str()? != st.session.as_deref()? {
            return None;
        }
        let kept = st.kept.iter().any(|r| {
            r.action == action
                && !resources.is_empty()
                && resources.iter().all(|x| glob(&r.resource, x))
        });
        let mode = st.mode.unwrap_or(AgentPermissionMode::Manual);
        let ask = Ask {
            mode,
            action,
            resources: &resources,
            root: &self.root,
            cwd: &self.cwd,
            memory: st.memory.as_deref(),
        };
        (kept || self.policy.auto_allow(&ask)).then(|| id.to_string())
    }

    /// One thing the server said, for this chat.
    async fn event(&self, ev: WireEvent) {
        if ev.kind == "model.updated" {
            if let Some(client) = self.client() {
                let limits = self.limits(&client).await;
                if let Some(m) = self.st.lock().map.as_mut() {
                    m.set_limits(limits);
                }
            }
            return;
        }
        // a request the mode or the user's "for this chat" already answered: no card
        if ev.kind == "permission.asked" {
            if let Some(id) = self.auto_reply(&ev) {
                let _ = self.cmd.send(Cmd::Permission {
                    id,
                    decision: "once",
                    message: None,
                    session_rules: Vec::new(),
                    accept_edits: false,
                });
                return;
            }
        }
        // the answer of an `unqueue`, in stream order
        if let Some(inbox) = ev.data["inboxID"].as_str() {
            match ev.kind.as_str() {
                "session.inbox.cancelled" => {
                    let waiter = self.waiters.lock().remove(inbox);
                    if let Some(w) = waiter {
                        let gen = self.st.lock().gen;
                        self.push(
                            gen,
                            Message::Unqueued {
                                receipt: w.receipt.clone(),
                            },
                        );
                        let _ = w.tx.send(true);
                    }
                }
                "session.inbox.delivered" => {
                    self.st.lock().delivered.insert(inbox.to_string());
                    if let Some(w) = self.waiters.lock().remove(inbox) {
                        let _ = w.tx.send(false);
                    }
                }
                _ => {}
            }
        }
        let (gen, mapped) = {
            let mut st = self.st.lock();
            let gen = st.gen;
            (gen, st.map.as_mut().map(|m| m.map(&ev)))
        };
        if let Some(m) = mapped {
            // a sub-agent first named by its launch block (nobody saw it created) is the chat's
            let key = self.st.lock().key;
            for t in &m.tasks {
                if let TaskSignal::Started { task, .. } = t {
                    self.server.own(key, task);
                }
            }
            self.push_mapped(gen, m);
        }
        // a sub-agent's session inherits its parent's rules, which can allow more than its role
        // may: the strict ones are set as soon as it exists
        if ev.kind == "session.created" {
            if let (Some(child), Some(_), Some(client)) = (
                ev.data["sessionID"].as_str(),
                ev.data["parentID"].as_str(),
                self.client(),
            ) {
                self.child_rules(gen, &client, child).await;
            }
        }
    }
}

/// `*` matches any run of characters; everything else is literal.
pub(super) fn glob(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((head, tail)) => text.strip_prefix(head).is_some_and(|rest| {
            (0..=rest.len())
                .filter(|i| rest.is_char_boundary(*i))
                .any(|i| glob(tail, &rest[i..]))
        }),
    }
}

async fn interrupt(client: &Client, session: &str, resume: bool) -> Result<Value, ApiError> {
    let query: &[(&str, &str)] = if resume { &[("resume", "true")] } else { &[] };
    client
        .request(
            &api::INTERRUPT,
            &[("sessionID", session)],
            query,
            None,
            SHORT,
        )
        .await
}

/// `provider/model` -> context window, out of `GET /api/model`.
fn context_limits(v: &Value) -> HashMap<String, u64> {
    serde_json::from_value::<Data<Vec<ModelInfo>>>(v.clone())
        .map(|d| {
            d.data
                .into_iter()
                .filter(|m| m.limit.context > 0)
                .map(|m| (format!("{}/{}", m.providerID, m.id), m.limit.context))
                .collect()
        })
        .unwrap_or_default()
}

/// Runs the chat's commands in order, to the `Stop` the drop of the transport queues.
async fn worker(inner: Arc<TInner>, mut rx: UnboundedReceiver<Cmd>) {
    while let Some(cmd) = rx.recv().await {
        if matches!(cmd, Cmd::Stop) {
            return;
        }
        inner.run(cmd).await;
    }
}

/// Maps what the server says of this chat's sessions, until the server forgets the chat's sink.
async fn events(inner: Arc<TInner>, mut rx: UnboundedReceiver<ChatInput>) {
    while let Some(input) = rx.recv().await {
        match input {
            ChatInput::Event(ev) => inner.event(ev).await,
            ChatInput::Resync => {
                let gen = inner.st.lock().gen;
                inner.resync(gen).await;
            }
            // the server read its config again: what lives in the session's instruction entries
            // is put back, whatever the reload did to it
            ChatInput::Reloaded => {
                let (gen, session, prompt) = {
                    let st = inner.st.lock();
                    (st.gen, st.session.clone(), st.system_prompt.clone())
                };
                if let (Some(session), Some(prompt), Some(client)) =
                    (session, prompt, inner.client())
                {
                    inner.put_instructions(gen, &client, &session, prompt).await;
                }
            }
            ChatInput::Down(exit) => {
                let gen = inner.st.lock().gen;
                inner.end(
                    gen,
                    Ended {
                        code: exit.code,
                        signal: exit.signal,
                        session_unknown: false,
                    },
                );
            }
        }
    }
}
