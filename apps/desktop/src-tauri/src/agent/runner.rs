//! One chat's state machine: the queue, steer and cancel, busy, restarts, sub-agents, changes and
//! the title, the permission round trip, crash handling and resume. Spec:
//! `SPECs/native-agent-spec.md` sections 2, 6, 8, 11, 13 (lane 1).
//!
//! The backend it runs on is a [`Transport`] (`transport.rs`; Claude: `stdio_transport.rs`, the
//! spawn, the pipes, the stream-json protocol): the `Session` calls it and reads what it says from
//! one inbound channel in a single event loop thread, so everything that mutates a chat goes
//! through `Session::inner` (one lock) in the order the backend said it. Events go to the
//! [`EventLog`], which numbers, rings and emits them. No lock of `inner` is ever held across a
//! call into a port, the login shell or `Transport::start`.
//!
//! Never logged: user text, assistant text, tool input/output, note paths, the system prompt,
//! environment values (spec section 8).

use super::api;
use super::backend::Backend;
use super::changes::{ChangeStore, ClosedTurn};
use super::chat_store;
use super::config_sync::{self, Decision, McpWatch, Msg, ProbeTarget, Reason, StaleView};
use super::env;
use super::events::*;
use super::files::Outgoing;
use super::permission_update::updated_permissions;
use super::ports::{AgentPorts, ChatSessionInfo};
use super::session::{EventLog, Shared, Sink, Timing};
use super::sub_tracker::{Author, Decided, SubTracker};
use super::subagents::resolve_launch;
use super::transport::{
    Close, Delivery, Ended, Inbound, LaunchConfig, LiveChange, Mapped, Message, ModelChange,
    Outbound, PermissionReply, Phrases, SpawnError, StartRequest, Transport, TransportInit,
};
use crate::features::points::Points;
use crate::features::scope::{CancelToken, Spawner};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

/// Live agent processes per window (spec 8). The plugin host's cap of 8 is separate.
pub const MAX_LIVE_PER_WINDOW: usize = 4;
/// Respawns after an unexpected exit, reset by the next finished turn.
const MAX_RESPAWNS: u8 = 2;
const DENY_MESSAGE: &str = "The user denied this action";

impl SpawnError {
    /// The `error` event a failed start becomes, in the words of the chat's transport.
    pub fn to_event(&self, phrases: &Phrases) -> AgentEvent {
        let (kind, message, retryable) = match self {
            Self::NotFound => (
                AgentErrorKind::BinaryNotFound,
                phrases.not_found.to_string(),
                false,
            ),
            Self::Busy => (
                AgentErrorKind::SpawnFailed,
                format!(
                    "{MAX_LIVE_PER_WINDOW} agent processes are already running in this window: close a chat tab first"
                ),
                true,
            ),
            Self::Invalid(m) => (AgentErrorKind::SpawnFailed, m.clone(), false),
            Self::Failed {
                kind,
                message,
                retryable,
            } => (*kind, message.clone(), *retryable),
            Self::Ended => (
                AgentErrorKind::Unknown,
                "This chat was closed".to_string(),
                false,
            ),
        };
        AgentEvent::Error {
            kind,
            message,
            retryable,
        }
    }
}

pub(crate) struct SessionInit {
    pub chat_id: String,
    pub label: String,
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub project_path: Option<String>,
    pub session_id: String,
    /// The first spawn resumes `session_id` instead of creating it.
    pub resume: bool,
    pub shared: Weak<Shared>,
    pub sink: Sink,
    /// The agent this chat runs on.
    pub backend: &'static Backend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Closing {
    /// The user closed the chat (graceful close).
    Closed,
    /// Window closed, vault switched, trust revoked, app exit.
    Shutdown,
    /// The cancel watchdog killed a process that ignored the interrupt.
    Killed,
    /// Writer restarts the process itself (permission-mode fallback): silent.
    Restart,
    /// Idle for too long: silent, resumed by the next message.
    Idle,
}

/// Why the next restart happens (`Inner::reload_pending`).
enum ReloadWhy {
    /// The user's "Reload session".
    Manual,
    /// A watched file changed or an MCP server came back (`Reason::describe`).
    Config(String),
}

impl ReloadWhy {
    fn text(self) -> Option<String> {
        match self {
            Self::Manual => None,
            Self::Config(t) => Some(t),
        }
    }
}

/// How a message was written while a turn runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineKind {
    /// `priority:"now"`: the CLI aborts the running step and starts this message's turn (3.13).
    Steer,
    /// A plain line: the CLI injects it after the next tool result, or runs it after the turn.
    Queued,
}

/// A message written to the running process: its receipt id and the message, kept until the CLI
/// echoes it (`MapOutput::user_echo`).
struct Unechoed {
    uuid: String,
    out: Outgoing,
    kind: LineKind,
    /// The receipt watchdog runs (`Session::watch_receipt`). A steer's starts at the write; a
    /// queued line's when the turn ended without taking it (it may wait as long as a tool runs).
    watching: bool,
    /// The CLI said it accepted the line (`MapOutput::command_queued`). It will run it, but a
    /// steer waits for the running sub-agents' tool calls to end, so the echo can be far later
    /// than `Timing::steer_ack`: an accepted line is never reported undelivered by the watchdog.
    accepted: bool,
}

/// The receipt id of a message: its id when that is a uuid (the id the UI keys the card by), else
/// a fresh one.
fn receipt_id(message_id: &str) -> String {
    if uuid::Uuid::parse_str(message_id).is_ok() {
        message_id.to_string()
    } else {
        uuid::Uuid::new_v4().to_string()
    }
}

/// The models a turn's sub-agents ran on, in launch order, one per run: the model the run
/// reported on its own messages (`subagent-model`, what really ran), else the tier's model it was
/// launched with. The one list `agent.turn-finished` (the Git history's `Writer-Model` trailer)
/// reads.
#[derive(Default)]
struct SubModels {
    runs: Vec<(String, Option<String>, Option<String>)>,
}

impl SubModels {
    fn run(&mut self, call: &str) -> &mut (String, Option<String>, Option<String>) {
        if let Some(i) = self.runs.iter().position(|r| r.0 == call) {
            return &mut self.runs[i];
        }
        self.runs.push((call.to_string(), None, None));
        self.runs.last_mut().unwrap()
    }

    /// The tier's model, the fallback.
    fn tier(&mut self, call: &str, model: &str) {
        self.run(call).1 = Some(model.to_string());
    }

    /// The model the run reported (the latest one after a resume).
    fn reported(&mut self, call: &str, model: &str) {
        self.run(call).2 = Some(model.to_string());
    }

    /// One model per run, distinct, first run first.
    fn models(self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (_, tier, reported) in self.runs {
            if let Some(m) = reported.or(tier) {
                if !out.contains(&m) {
                    out.push(m);
                }
            }
        }
        out
    }
}

struct PendingPerm {
    input: Value,
    suggestions: Vec<Value>,
    /// A `Bash` call waiting for approval: it is not running yet, so its command window
    /// (`command_windows.rs`) is shut until the user allows it.
    command_call: Option<String>,
    /// An open question card (`AskUserQuestion`): the call it belongs to. It is answered by
    /// [`Session::answer_question`], never by a permission decision, and is as busy as a card.
    question: Option<QuestionPending>,
}

struct QuestionPending {
    tool_call_id: Option<String>,
}

struct Inner {
    /// What the next start is given, refreshed by `configure`.
    launch: LaunchConfig,
    /// A file the running process read at start changed (first cause kept); cleared when the next
    /// process starts. See `config_sync.rs`.
    stale: Option<Reason>,
    /// MCP servers the latest `init` reported as not connected, and the ones that already caused
    /// an automatic restart (each at most once per chat: a server that connects for the probe but
    /// fails inside the session must not loop).
    mcp_failing: BTreeSet<String>,
    mcp_restarted: BTreeSet<String>,

    session_id: String,
    /// A later spawn must `--resume` (init seen, or the request asked to resume).
    resume_next: bool,
    terminal: bool,
    closing: Option<Closing>,

    // one process generation
    gen: u64,
    live_gen: Option<u64>,
    /// `live_gen` is set and the process id is stored: lines may be written.
    ready: bool,
    spawning: bool,
    used_resume: bool,
    init_seen: bool,
    pid: Option<u32>,

    state: AgentSessionState,
    /// Tool name by call id for the current turn: `tool-call-input` carries only the id.
    tool_names: HashMap<String, String>,
    /// Who made each call and which sub-agents are still working (see `sub_tracker.rs`).
    subs: SubTracker,
    /// The tier model settings the running process was started with (what its `--agents` JSON
    /// holds), and the model its `init` reported: what the `subagent-started` event resolves a
    /// launch's model from.
    agent_tiers: BTreeMap<String, Option<String>>,
    session_model: Option<String>,
    /// The first `turn-finished` came while a sub-agent still worked (a background task is a
    /// child of the CLI process, woken later by its `task_notification`): the Changes card stays
    /// open (late sub-agent edits join it) until a later `turn-finished` finds none working, or
    /// the process ends. Also part of [`Session::is_busy`], the one "busy" fact of every planned
    /// restart: the process must not be replaced while it holds a running sub-agent or the turn
    /// that reports it.
    background_open: bool,
    /// The last `session-changes` event sent, so an unchanged list is not sent again.
    last_session: Option<SessionChangesSummary>,
    pending: HashMap<String, PendingPerm>,
    turn_active: bool,
    /// The model the last usage report named for this turn (handed to `agent.turn-finished`).
    turn_model: Option<String>,
    /// The models the turn's sub-agents run on, handed to `agent.turn-finished` after the main
    /// model.
    sub_models: SubModels,
    /// This chat is between "an idle send decided to start a turn" and "its message is queued":
    /// a second concurrent send sees it and does not announce the same turn again.
    turn_starting: bool,
    /// The chat's turn sequence: advanced every time a message starts a turn of the CLI
    /// (`flush_queue`), also one that no `agent.turn-started` announces (a message queued during a
    /// turn). A contributor of `agent.turn-baseline` answers only for the turn it recorded.
    turn_seq: u64,
    queue: VecDeque<Outgoing>,
    inflight: Vec<Outgoing>,
    /// Messages written mid-turn (steers and queued lines) that the CLI has not acknowledged yet:
    /// it echoes a user message back (`MapOutput::user_echo`) when it takes it, at a tool boundary
    /// inside the running turn or as the start of the next one. While any is unacknowledged, a
    /// normal end of turn is not the end of the work: the CLI starts that message's turn by itself.
    /// Each keeps its message: a planned restart (reload, resume) that kills the process before
    /// the receipt arrives re-sends it to the new process (`on_exit`), so a reload never loses it.
    unechoed: Vec<Unechoed>,
    /// The first turn ended while a message was unacknowledged: `turn_active` is held for it.
    echo_hold: bool,
    seed: Option<String>,
    respawns: u8,
    fallback_used: bool,
    cancel_token: u64,
    restart_after_turn: bool,
    /// The process is being stopped to be replaced: the restart that follows respawns although no
    /// message waits, then reports `session-reloaded`.
    reload_pending: Option<ReloadWhy>,
    last_activity: Instant,
}

/// The chat's state lock. Test builds also count, per thread, the guards the thread holds
/// (`Session::lock_is_held`).
struct StateLock(Mutex<Inner>);

struct StateGuard<'a>(parking_lot::MutexGuard<'a, Inner>);

#[cfg(test)]
thread_local! {
    static HELD: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

impl StateLock {
    fn new(inner: Inner) -> Self {
        Self(Mutex::new(inner))
    }

    fn lock(&self) -> StateGuard<'_> {
        let guard = self.0.lock();
        #[cfg(test)]
        HELD.with(|h| h.set(h.get() + 1));
        StateGuard(guard)
    }
}

impl std::ops::Deref for StateGuard<'_> {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl std::ops::DerefMut for StateGuard<'_> {
    fn deref_mut(&mut self) -> &mut Inner {
        &mut self.0
    }
}

#[cfg(test)]
impl Drop for StateGuard<'_> {
    fn drop(&mut self) {
        HELD.with(|h| h.set(h.get() - 1));
    }
}

pub struct Session {
    pub(crate) chat_id: String,
    pub(crate) label: String,
    pub(crate) root: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) project_path: Option<String>,
    me: Weak<Session>,
    shared: Weak<Shared>,
    /// The agent this chat runs on: its tool table, adapters and transport.
    backend: &'static Backend,
    /// How the backend carries the chat (`transport.rs`): called outside `inner`'s critical
    /// sections where it can block, and the only way anything reaches the backend.
    transport: Arc<dyn Transport>,
    /// The host's threads: the helper threads below run on it and end with it.
    spawner: Spawner,
    ports: Arc<AgentPorts>,
    changes: Arc<ChangeStore>,
    /// The agent's owned points (`api.rs`): `turn-started` and `turn-finished` go through it.
    points: Points,
    timing: Timing,
    pub(crate) log: Arc<EventLog>,
    /// Counted toward the per-window cap (set under `Shared::gate`).
    live: AtomicBool,
    inner: StateLock,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.log.close();
    }
}

/// The chat's single event loop: what the transport says, one message at a time, in order. Ends
/// with the host, the chat or the transport.
fn inbound_loop(rx: Receiver<Inbound>, session: Weak<Session>, token: CancelToken) {
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => {
                let Some(s) = session.upgrade() else {
                    return;
                };
                s.on_inbound(message);
            }
            Err(RecvTimeoutError::Timeout) if !token.is_cancelled() => {
                if session.strong_count() == 0 {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

impl Session {
    /// An `Err` is a thread the host refused (the feature is stopping): the chat is not created.
    pub(crate) fn new(init: SessionInit, config: LaunchConfig) -> Result<Arc<Session>, String> {
        let backend = init.backend;
        Self::with_transport(init, config, |t| backend.connect(t))
    }

    /// [`Session::new`] on the transport `make` builds (tests bring their own).
    pub(crate) fn with_transport(
        init: SessionInit,
        config: LaunchConfig,
        make: impl FnOnce(TransportInit) -> Result<Arc<dyn Transport>, String>,
    ) -> Result<Arc<Session>, String> {
        let shared = init.shared.upgrade().ok_or("the agent has stopped")?;
        let spawner = shared.spawn.clone();
        let (inbound_tx, inbound_rx) = channel();
        let transport = make(TransportInit {
            procs: Arc::clone(&shared.procs),
            label: init.label.clone(),
            root: init.root.clone(),
            cwd: init.cwd.clone(),
            project_path: init.project_path.clone(),
            spawner: spawner.clone(),
            inbound: inbound_tx,
        })?;
        let log =
            EventLog::new(init.chat_id.clone(), init.sink, &spawner).map_err(|e| e.to_string())?;
        let session = Arc::new_cyclic(|me| Session {
            me: me.clone(),
            chat_id: init.chat_id,
            label: init.label,
            root: init.root,
            cwd: init.cwd,
            project_path: init.project_path,
            shared: init.shared,
            backend: init.backend,
            transport,
            spawner: spawner.clone(),
            ports: Arc::clone(&shared.ports),
            changes: Arc::clone(&shared.changes),
            points: shared.points.clone(),
            timing: shared.timing,
            log,
            live: AtomicBool::new(false),
            inner: StateLock::new(Inner {
                launch: config,
                agent_tiers: BTreeMap::new(),
                session_model: None,
                stale: None,
                mcp_failing: BTreeSet::new(),
                mcp_restarted: BTreeSet::new(),
                session_id: init.session_id,
                resume_next: init.resume,
                terminal: false,
                closing: None,
                gen: 0,
                live_gen: None,
                ready: false,
                spawning: false,
                used_resume: false,
                init_seen: false,
                pid: None,
                state: AgentSessionState::Idle,
                tool_names: HashMap::new(),
                subs: SubTracker::new(init.backend.tools()),
                background_open: false,
                last_session: None,
                pending: HashMap::new(),
                turn_active: false,
                turn_model: None,
                sub_models: SubModels::default(),
                turn_starting: false,
                turn_seq: 0,
                queue: VecDeque::new(),
                inflight: Vec::new(),
                unechoed: Vec::new(),
                echo_hold: false,
                seed: None,
                respawns: 0,
                fallback_used: false,
                cancel_token: 0,
                restart_after_turn: false,
                reload_pending: None,
                last_activity: Instant::now(),
            }),
        });
        let weak = Arc::downgrade(&session);
        spawner
            .spawn("agent-inbound", move |token| {
                inbound_loop(inbound_rx, weak, token)
            })
            .map_err(|e| e.to_string())?;
        Ok(session)
    }

    /// A helper thread of this chat (a watchdog, the respawn) on the host's scope: it gets the
    /// spawner to sleep on (a stopped host wakes it) and is refused once the host has stopped.
    fn spawn_helper(&self, name: &'static str, f: impl FnOnce(&Spawner) + Send + 'static) {
        let sp = self.spawner.clone();
        if let Err(e) = self.spawner.spawn(name, move |_| f(&sp)) {
            log::warn!(target: "agent", "agent: no {name} thread: {e}");
        }
    }

    // ---------------------------------------------------------------- queries

    pub(crate) fn backend(&self) -> &'static Backend {
        self.backend
    }

    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    pub fn state(&self) -> AgentSessionState {
        self.inner.lock().state
    }

    pub fn session_id(&self) -> String {
        self.inner.lock().session_id.clone()
    }

    /// Whether the calling thread holds a chat's state lock; `transport_tests` uses it to prove
    /// the `Session` calls `start` and `unqueue` without the lock (another thread holding it, the
    /// reaper or the inbound loop, is no business of the transport).
    #[cfg(test)]
    pub(crate) fn lock_is_held(&self) -> bool {
        HELD.with(|h| h.get() > 0)
    }

    pub fn is_terminal(&self) -> bool {
        self.inner.lock().terminal
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.lock().pid
    }

    /// What a one-shot helper call (the chat title) may run: the program and the confined cwd of
    /// a chat that has one. `None` before that, or once ended.
    pub fn helper_target(&self) -> Option<(PathBuf, PathBuf)> {
        let g = self.inner.lock();
        if g.terminal {
            return None;
        }
        Some((g.launch.program.clone()?, self.cwd.clone()))
    }

    // ---------------------------------------------------------------- start

    /// Refresh the next spawn's configuration. A running process keeps its own.
    pub(crate) fn configure(&self, config: LaunchConfig) {
        let mut g = self.inner.lock();
        // read live by the config watch: a running chat follows the setting too
        g.launch.settings.auto_reload = config.settings.auto_reload;
        g.launch.restart_on_config_change = config.restart_on_config_change;
        if g.live_gen.is_some() || g.spawning {
            return;
        }
        g.launch = config;
    }

    /// Report a failure that happened before any process existed.
    pub(crate) fn fail(&self, err: &SpawnError) {
        let mut g = self.inner.lock();
        if !g.terminal {
            g.state = AgentSessionState::Error;
        }
        self.log.push(err.to_event(self.transport.phrases()));
    }

    /// Make sure a process is running. Starting `claude` needs no per-vault question: turning the
    /// agent feature on is the approval (ADR 2026-11-17); what the agent may DO is the CLI's
    /// permission card.
    pub(crate) fn ensure_process(self: &Arc<Self>) -> Result<(), SpawnError> {
        let result = self.ensure_inner();
        if result.is_err() {
            let mut g = self.inner.lock();
            g.spawning = false;
        }
        result
    }

    fn ensure_inner(self: &Arc<Self>) -> Result<(), SpawnError> {
        let (launch, session_id, used_resume) = {
            let mut g = self.inner.lock();
            if g.terminal {
                return Err(SpawnError::Ended);
            }
            if g.live_gen.is_some() || g.spawning {
                return Ok(());
            }
            g.agent_tiers = g.launch.settings.tier_models.clone();
            g.spawning = true;
            if g.state != AgentSessionState::Reconnecting {
                g.state = AgentSessionState::Starting;
            }
            (g.launch.clone(), g.session_id.clone(), g.resume_next)
        };
        self.launch(&launch, &session_id, used_resume)
    }

    fn launch(
        self: &Arc<Self>,
        launch: &LaunchConfig,
        session_id: &str,
        used_resume: bool,
    ) -> Result<(), SpawnError> {
        let shared = self.shared.upgrade().ok_or(SpawnError::Ended)?;
        // the cap is counted and taken in one step
        {
            let _gate = shared.gate.lock();
            if shared.live_in_window(&self.label) >= MAX_LIVE_PER_WINDOW {
                return Err(SpawnError::Busy);
            }
            self.live.store(true, Ordering::SeqCst);
        }
        let gen = {
            let mut g = self.inner.lock();
            if g.terminal {
                self.live.store(false, Ordering::SeqCst);
                return Err(SpawnError::Ended);
            }
            g.gen += 1;
            let gen = g.gen;
            g.live_gen = Some(gen);
            g.ready = false;
            g.used_resume = used_resume;
            g.init_seen = false;
            g.pid = None;
            g.last_activity = Instant::now();
            // the new process reads everything fresh
            g.stale = None;
            gen
        };
        let res = self.transport.start(&StartRequest {
            gen,
            session_id,
            resume: used_resume,
            launch,
        });
        let mut g = self.inner.lock();
        match res {
            Ok(()) => {
                // a failure to run the program is `Err`; `Ok` means a process (or connection) is
                // there, or that a later `StartFailed` will say it is not
                g.spawning = false;
                if g.live_gen != Some(gen) {
                    return Ok(());
                }
                if let Some(closing) = g.closing {
                    // a stop that landed while `start` ran found nothing to signal: apply it now
                    match closing {
                        Closing::Shutdown | Closing::Killed => self.signal(&g, Close::Kill),
                        Closing::Restart | Closing::Idle => self.terminate(&g),
                        Closing::Closed => self.signal(&g, Close::Graceful),
                    }
                } else {
                    g.ready = true;
                    self.flush_queue(&mut g);
                }
                Ok(())
            }
            Err(e) => {
                g.live_gen = None;
                g.spawning = false;
                self.live.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    // ------------------------------------------------------------ inbound

    /// One thing the transport said, on the chat's event loop.
    fn on_inbound(self: &Arc<Self>, inbound: Inbound) {
        let gen = inbound.gen;
        match inbound.message {
            Message::Started { pid } => self.on_spawn(gen, pid),
            Message::Mapped(out) => self.on_mapped(gen, out),
            Message::Refused => {
                let mut g = self.inner.lock();
                if g.live_gen == Some(gen) {
                    self.restart_when_idle(&mut g);
                }
            }
            Message::Unqueued { receipt } => {
                let mut g = self.inner.lock();
                if g.live_gen == Some(gen) {
                    g.unechoed.retain(|u| u.uuid != receipt);
                    g.inflight
                        .retain(|o| o.receipt.as_deref() != Some(receipt.as_str()));
                    self.release_hold(&mut g);
                }
            }
            Message::StartFailed {
                kind,
                message,
                retryable,
            } => self.on_spawn_error(gen, kind, message, retryable),
            Message::Ended(ended) => self.on_exit(gen, ended),
        }
    }

    fn on_spawn(&self, gen: u64, pid: Option<u32>) {
        let mut g = self.inner.lock();
        if g.live_gen == Some(gen) {
            g.pid = pid;
            if let Some(pid) = pid {
                log::info!(target: "agent", "agent: started pid {pid}");
            }
        }
    }

    fn on_spawn_error(&self, gen: u64, kind: AgentErrorKind, message: String, retryable: bool) {
        let mut g = self.inner.lock();
        if g.live_gen != Some(gen) {
            return;
        }
        g.live_gen = None;
        g.ready = false;
        g.spawning = false;
        g.turn_active = false;
        g.queue.clear();
        g.inflight.clear();
        self.live.store(false, Ordering::SeqCst);
        g.state = AgentSessionState::Error;
        log::warn!(target: "agent", "agent: could not start the program");
        self.log.push(AgentEvent::Error {
            kind,
            message,
            retryable,
        });
    }

    fn on_mapped(self: &Arc<Self>, gen: u64, out: Mapped) {
        let tools = self.backend.tools();
        let mut started: Option<ChatSessionInfo> = None;
        // snapshots to take and the turn to finish happen after the lock is released (file IO)
        let mut captures: Vec<(String, Value, Option<Author>)> = Vec::new();
        let mut closed: Option<ClosedTurn> = None;
        // a turn ended on this line (the model of its usage report, if any): `agent.turn-finished`
        let mut turn_over: Option<Vec<String>> = None;
        // an edit call ended: the session's counts may have changed
        let mut edit_ended = false;
        {
            let mut g = self.inner.lock();
            if g.live_gen != Some(gen) {
                return;
            }
            g.last_activity = Instant::now();
            if let Some(uuid) = &out.accepted {
                if let Some(u) = g.unechoed.iter_mut().find(|u| u.uuid == *uuid) {
                    u.accepted = true;
                }
            }
            if let Some(uuid) = &out.taken {
                // the receipt: the CLI took the message (at a tool boundary or as its next turn)
                if let Some(i) = g.unechoed.iter().position(|u| u.uuid == *uuid) {
                    if g.unechoed.remove(i).kind == LineKind::Queued {
                        self.log.push(AgentEvent::MessageReceived {
                            message_id: uuid.clone(),
                        });
                    }
                }
            }
            // the lifecycle of the sub-agents, decided by the tracker alone
            let task_events: Vec<AgentEvent> =
                out.tasks.iter().flat_map(|s| g.subs.on_task(s)).collect();
            for mut ev in task_events.into_iter().chain(out.events) {
                // runner-originated events that follow `ev`
                let Decided {
                    before: resumes,
                    after: mut extra,
                } = g.subs.observe(&ev);
                match &ev {
                    AgentEvent::ToolCallStarted {
                        tool_call_id, tool, ..
                    } => {
                        g.tool_names.insert(tool_call_id.clone(), tool.clone());
                        // the permission request can come first: then it waits for the user
                        let waiting = g
                            .pending
                            .values()
                            .any(|p| p.command_call.as_deref() == Some(tool_call_id));
                        if tools.is_shell(tool) && !waiting {
                            let by = g.subs.author_of(Some(tool_call_id));
                            self.changes.command_started(
                                &self.chat_id,
                                tool_call_id,
                                by.as_ref(),
                                Instant::now(),
                            );
                        }
                    }
                    AgentEvent::ToolCallInput {
                        tool_call_id,
                        input,
                    } => {
                        if g.tool_names
                            .get(tool_call_id)
                            .is_some_and(|t| tools.is_launch(t))
                        {
                            let inherited =
                                g.session_model
                                    .as_deref()
                                    .or(g.launch.settings.model.as_deref());
                            if let Some(launch) =
                                resolve_launch(tools, input, &g.agent_tiers, inherited)
                            {
                                if let Some(m) = launch.model.as_ref() {
                                    g.sub_models.tier(tool_call_id, m);
                                }
                                extra.push(AgentEvent::SubagentStarted {
                                    tool_call_id: tool_call_id.clone(),
                                    role: launch.role,
                                    name: launch.name,
                                    model: launch.model,
                                });
                            }
                        }
                        if let Some(tool) = g.tool_names.get(tool_call_id) {
                            let by = g.subs.author_of(Some(tool_call_id));
                            captures.push((tool.clone(), input.clone(), by));
                        }
                    }
                    AgentEvent::ToolCallFinished { tool_call_id, .. } => {
                        self.changes
                            .command_finished(&self.chat_id, tool_call_id, Instant::now());
                        edit_ended |= g
                            .tool_names
                            .get(tool_call_id)
                            .is_some_and(|t| tools.is_edit(t));
                    }
                    // the permission request may come first: the tool has not run yet either
                    AgentEvent::PermissionRequest {
                        tool,
                        input,
                        tool_call_id,
                        ..
                    } => {
                        let by = g.subs.author_of(tool_call_id.as_deref());
                        captures.push((tool.clone(), input.clone(), by));
                        if let Some(call) = tool_call_id.as_deref().filter(|_| tools.is_shell(tool))
                        {
                            self.changes
                                .command_finished(&self.chat_id, call, Instant::now());
                        }
                    }
                    AgentEvent::SubagentModel {
                        tool_call_id,
                        model,
                    } => g.sub_models.reported(tool_call_id, model),
                    AgentEvent::Usage {
                        scope: UsageScope::Turn,
                        model,
                        ..
                    } => g.turn_model = model.clone(),
                    AgentEvent::TurnFinished { reason, .. } => {
                        // A sub-agent still working after a normal end (a background task, woken
                        // later) keeps the card open for its late edits; any other end closes it.
                        // (the tracker's rule; settled runs stay known for a later resume)
                        let (keep_open, ended) = g.subs.on_turn_finished(*reason);
                        g.background_open = keep_open;
                        if !keep_open {
                            let main = g.turn_model.take();
                            let mut models: Vec<String> = main.into_iter().collect();
                            for m in std::mem::take(&mut g.sub_models).models() {
                                if !models.contains(&m) {
                                    models.push(m);
                                }
                            }
                            turn_over = Some(models);
                            // a run that never got its end signal ends with the last turn
                            extra.extend(ended);
                            self.changes.commands_ended(&self.chat_id, Instant::now());
                            g.tool_names.clear();
                            // taken before `apply` flushes a queued message that starts the next turn
                            closed = self.changes.close_turn(&self.chat_id);
                        }
                    }
                    _ => {}
                }
                // the card says which sub-agent asks
                if let AgentEvent::PermissionRequest {
                    tool_call_id, by, ..
                } = &mut ev
                {
                    *by = g.subs.author_of(tool_call_id.as_deref()).map(|a| a.label);
                }
                if let AgentEvent::QuestionRequest {
                    tool_call_id, by, ..
                } = &mut ev
                {
                    *by = g.subs.author_of(tool_call_id.as_deref()).map(|a| a.label);
                }
                // a resume goes first: it marks where in the run's calls it restarted
                for r in resumes {
                    self.apply(&mut g, r, &mut started);
                }
                self.apply(&mut g, ev, &mut started);
                for ev in extra {
                    self.apply(&mut g, ev, &mut started);
                }
            }
        }
        for (tool, input, by) in captures {
            self.changes.capture_by(
                &self.chat_id,
                &self.root,
                &self.cwd,
                tools,
                &tool,
                &input,
                by.as_ref(),
            );
        }
        let ended_turn = closed.is_some();
        let mut finished_summary = None;
        if let Some(turn) = closed {
            if let Some(summary) = self.changes.finish(turn) {
                finished_summary = Some(summary.clone());
                self.log.push(AgentEvent::TurnChanges(summary));
            }
        }
        if let Some(models) = turn_over {
            self.emit_turn_finished(finished_summary.as_ref(), models);
        }
        if edit_ended || ended_turn {
            self.push_session_changes();
        }
        if let Some(info) = started {
            self.ports.chats().session_started(&self.root, &info);
        }
    }

    /// Writer's own writes in the vault (the editor's saves), as the watcher reported them: the
    /// running turn will not vouch for these files' text from before it (`changes.rs`).
    pub(crate) fn own_paths_written(&self, own: &[PathBuf]) {
        self.changes.note_own_writes(&self.chat_id, &self.root, own);
    }

    /// The watcher's changed vault paths (Writer's own writes removed), delivered at `at`: the
    /// files a running shell command of this chat changed join its changes (`changes.rs`).
    pub(crate) fn vault_paths_changed(&self, paths: &[PathBuf], at: Instant) {
        // what the turn-baseline provider (the Git history, when it is on) vouches for; no
        // contributor means no answer at once
        let turn = self.inner.lock().turn_seq;
        let baseline = |rels: &[String]| {
            self.points
                .ask(
                    &api::TURN_BASELINE,
                    &api::TurnBaseline {
                        root: self.root.clone(),
                        chat_id: self.chat_id.clone(),
                        turn,
                        paths: rels.to_vec(),
                    },
                )
                .unwrap_or_default()
        };
        if self
            .changes
            .record_command_changes(&self.chat_id, &self.root, paths, at, &baseline)
        {
            self.push_session_changes();
        }
    }

    /// Tells the features that extend `agent.turn-finished` (`api.rs`) that a turn is over. With
    /// no contributor nothing happens (not even the title read). Call it without the lock.
    fn emit_turn_finished(&self, summary: Option<&TurnChangesSummary>, models: Vec<String>) {
        let points = &self.points;
        if points.contributors(api::TURN_FINISHED.id) == 0 {
            return;
        }
        let files = summary
            .map(|s| s.files.as_slice())
            .unwrap_or_default()
            .iter()
            .map(|f| {
                let (kind, from) = match f.status {
                    ChangeStatus::Added => (api::FileChangeKind::Add, None),
                    ChangeStatus::Modified => (api::FileChangeKind::Edit, None),
                    ChangeStatus::Deleted => (api::FileChangeKind::Delete, None),
                    ChangeStatus::Renamed => (api::FileChangeKind::Move, f.old_path.clone()),
                };
                api::FileChange {
                    kind,
                    path: f.path.clone(),
                    from,
                }
            })
            .collect();
        let title = chat_store::load(&self.root, &self.chat_id)
            .ok()
            .map(|(summary, _)| summary.title);
        points.emit(
            &api::TURN_FINISHED,
            &api::TurnFinished {
                root: self.root.clone(),
                chat_id: self.chat_id.clone(),
                turn_id: summary.map(|s| s.turn_id.clone()),
                title,
                backend: self.backend.id.to_string(),
                models,
                files,
            },
        );
    }

    /// Publishes the chat's changed notes (the row above the composer) unless nothing changed
    /// since the last one. Reads files: call it without the lock.
    fn push_session_changes(&self) {
        let Some(summary) = self.changes.session_summary(&self.chat_id, &self.root) else {
            return;
        };
        {
            let mut g = self.inner.lock();
            if g.last_session.as_ref() == Some(&summary) {
                return;
            }
            g.last_session = Some(summary.clone());
        }
        self.log.push(AgentEvent::SessionChanges(summary));
    }

    /// Fold one mapped event into the state machine, then publish it.
    fn apply(&self, g: &mut Inner, ev: AgentEvent, started: &mut Option<ChatSessionInfo>) {
        match &ev {
            AgentEvent::SessionStarted {
                session_id,
                model,
                cli_version,
                mcp_servers,
                ..
            } => {
                g.mcp_failing = config_sync::failing(mcp_servers);
                // watch a failing server only when a recovery could restart this chat
                let watch = !g.mcp_failing.is_empty() && self.restarts_on_config(g);
                if let Some(shared) = self.shared.upgrade() {
                    shared.send_config(Msg::Mcp {
                        chat_id: self.chat_id.clone(),
                        failing: watch,
                    });
                }
                g.init_seen = true;
                g.session_model = model.clone();
                g.resume_next = true;
                if !session_id.is_empty() {
                    g.session_id = session_id.clone();
                }
                if cli_version.is_some() {
                    g.launch.cli_version = cli_version.clone();
                }
                self.mark_running(g);
                *started = Some(ChatSessionInfo {
                    chat_id: self.chat_id.clone(),
                    session_id: g.session_id.clone(),
                    cli_version: g.launch.cli_version.clone(),
                    model: model.clone(),
                    project_path: self.project_path.clone(),
                });
            }
            AgentEvent::TextDelta { .. }
            | AgentEvent::Text { .. }
            | AgentEvent::Thinking { .. }
            | AgentEvent::ToolCallStarted { .. }
            | AgentEvent::ToolCallInputDelta { .. }
            | AgentEvent::ToolCallInput { .. }
            | AgentEvent::ToolCallFinished { .. } => self.mark_running(g),
            AgentEvent::PermissionRequest {
                request_id,
                tool,
                tool_call_id,
                input,
                suggestions,
                ..
            } => {
                g.pending.insert(
                    request_id.clone(),
                    PendingPerm {
                        input: input.clone(),
                        suggestions: suggestions.clone(),
                        command_call: tool_call_id
                            .clone()
                            .filter(|_| self.backend.tools().is_shell(tool)),
                        question: None,
                    },
                );
                if g.state != AgentSessionState::Cancelling {
                    g.state = AgentSessionState::AwaitingPermission;
                }
            }
            AgentEvent::QuestionRequest {
                request_id,
                tool_call_id,
                ..
            } => {
                g.pending.insert(
                    request_id.clone(),
                    PendingPerm {
                        // the mapper keeps the CLI's own input, the answer is built from it
                        input: Value::Null,
                        suggestions: vec![],
                        command_call: None,
                        question: Some(QuestionPending {
                            tool_call_id: tool_call_id.clone(),
                        }),
                    },
                );
                if g.state != AgentSessionState::Cancelling {
                    g.state = AgentSessionState::AwaitingPermission;
                }
            }
            AgentEvent::PermissionResolved { request_id, .. }
            | AgentEvent::QuestionResolved { request_id, .. } => {
                g.pending.remove(request_id);
                if g.pending.is_empty() && g.state == AgentSessionState::AwaitingPermission {
                    g.state = AgentSessionState::Running;
                }
            }
            AgentEvent::TurnFinished { reason, .. } => {
                // A steer aborts the running turn, so `interrupted` is its own doing; the user's stop
                // (`cancel`) and any failure forget what was written.
                if !matches!(
                    reason,
                    TurnFinishReason::Completed | TurnFinishReason::Interrupted
                ) {
                    self.forget_unechoed(g);
                }
                if !g.unechoed.is_empty() {
                    // The steer cut this turn short, or a queued line found no tool boundary
                    // left: the CLI starts that message's turn by itself. Still working; nothing
                    // flushes until that turn ends.
                    g.echo_hold = true;
                    g.last_activity = Instant::now();
                    self.watch_unwatched(g);
                    self.log.push(ev);
                    return;
                }
                self.end_turn(g, Some(ev));
                return;
            }
            AgentEvent::Error {
                kind: AgentErrorKind::Auth,
                ..
            } => g.state = AgentSessionState::Error,
            // The backend kept (or fell back to) another model: never pass the refused one again.
            AgentEvent::ModelRefused { using, .. } => g.launch.settings.model = using.clone(),
            _ => {}
        }
        self.log.push(ev);
    }

    fn mark_running(&self, g: &mut Inner) {
        if g.turn_active
            && matches!(
                g.state,
                AgentSessionState::Starting | AgentSessionState::Idle
            )
        {
            g.state = AgentSessionState::Running;
        }
    }

    /// Restart with `--resume` now, or once the running turn (and any background sub-agent and
    /// the turn that reports it) has finished.
    fn restart_when_idle(&self, g: &mut Inner) {
        if g.turn_active || g.background_open {
            g.restart_after_turn = true;
        } else {
            g.closing = Some(Closing::Restart);
            self.terminate(g);
        }
    }

    fn on_exit(self: &Arc<Self>, gen: u64, ended: Ended) {
        let Ended {
            code,
            signal,
            session_unknown,
        } = ended;
        let mut respawn: Option<(Vec<Outgoing>, Option<String>)> = None;
        let mut closed: Option<ClosedTurn> = None;
        let reloaded: Option<ReloadWhy>;
        let had_turn;
        {
            let mut g = self.inner.lock();
            if g.live_gen != Some(gen) {
                return;
            }
            had_turn = g.turn_active || g.background_open;
            // no command of this chat runs once its process is gone
            self.changes.commands_ended(&self.chat_id, Instant::now());
            // a sub-agent is a child of the process: its card ends with it (stopped, not running)
            for ev in g.subs.end_running(SubagentRunStatus::Interrupted) {
                self.log.push(ev);
            }
            // a card kept open for a sub-agent ends with the process: nothing more can arrive
            // the process is gone: so is everything it knew of its runs
            g.subs.clear();
            if std::mem::take(&mut g.background_open) {
                g.tool_names.clear();
                closed = self.changes.close_turn(&self.chat_id);
            }
            g.live_gen = None;
            g.ready = false;
            g.pid = None;
            // written, never acknowledged: a planned restart sends them again (below)
            let unacked = std::mem::take(&mut g.unechoed);
            g.echo_hold = false;
            self.live.store(false, Ordering::SeqCst);
            let closing = g.closing.take();
            // Anything but a planned restart forgets a queued line: the chip learns it is gone.
            let replayable = matches!(closing, Some(Closing::Restart) | Some(Closing::Idle));
            if !replayable {
                for u in unacked.iter().filter(|u| u.kind == LineKind::Queued) {
                    self.log.push(AgentEvent::SteerUndelivered {
                        message_id: u.uuid.clone(),
                    });
                }
            }
            let mid_turn = g.turn_active || !g.pending.is_empty();
            let init_seen = g.init_seen;
            g.restart_after_turn = false;
            reloaded = g.reload_pending.take();
            self.drop_pending(&mut g);
            let clean = code == Some(0) && signal.is_none();
            log::info!(
                target: "agent",
                "agent: exited (code {:?}, signal {:?}, closing {closing:?}, mid-turn {mid_turn})",
                code, signal
            );
            match closing {
                Some(Closing::Closed) => {
                    self.finish_terminal(&mut g, SessionEndReason::Closed, code, signal)
                }
                Some(Closing::Shutdown) => {
                    self.finish_terminal(&mut g, SessionEndReason::VaultSwitched, code, signal)
                }
                Some(Closing::Killed) => {
                    g.turn_active = false;
                    g.queue.clear();
                    g.inflight.clear();
                    g.state = AgentSessionState::Idle;
                    self.log.push(AgentEvent::SessionEnded {
                        reason: SessionEndReason::Killed,
                        exit_code: code,
                        signal,
                    });
                }
                Some(Closing::Restart) | Some(Closing::Idle) => {
                    g.turn_active = false;
                    g.state = AgentSessionState::Idle;
                    // The restart is Writer's own doing, so a message the process never acknowledged
                    // goes to the new one, once (the same echo that settles it decides; a queued
                    // line keeps its receipt id, so its chip still resolves).
                    // A message may also be waiting, or a reload asked for the new process.
                    let replay: Vec<Outgoing> = unacked.into_iter().map(|s| s.out).collect();
                    g.inflight.clear();
                    if !replay.is_empty() || !g.queue.is_empty() || reloaded.is_some() {
                        respawn = Some((replay, None));
                    }
                }
                None => {
                    let resume_missing = !init_seen
                        && g.used_resume
                        && !g.fallback_used
                        && (session_unknown || !clean);
                    if resume_missing {
                        // The CLI does not know this conversation: continue in a NEW session
                        // seeded from the chat note (spec 9).
                        g.fallback_used = true;
                        let old =
                            std::mem::replace(&mut g.session_id, uuid::Uuid::new_v4().to_string());
                        g.resume_next = false;
                        let replay = std::mem::take(&mut g.inflight);
                        g.turn_active = false;
                        log::info!(target: "agent", "agent: resume found no conversation, starting a new session");
                        g.state = AgentSessionState::Starting;
                        respawn = Some((replay, Some(old)));
                    } else if !mid_turn {
                        g.state = AgentSessionState::Idle;
                        if !clean {
                            self.log.push(AgentEvent::Error {
                                kind: AgentErrorKind::ProcessExited,
                                message: self.transport.phrases().exited_idle.into(),
                                retryable: true,
                            });
                        }
                        if !g.queue.is_empty() {
                            respawn = Some((Vec::new(), None));
                        }
                    } else {
                        g.turn_active = false;
                        let replay = if init_seen {
                            Vec::new()
                        } else {
                            std::mem::take(&mut g.inflight)
                        };
                        g.inflight.clear();
                        if g.respawns < MAX_RESPAWNS {
                            g.respawns += 1;
                            g.state = AgentSessionState::Reconnecting;
                            self.log.push(AgentEvent::Error {
                                kind: AgentErrorKind::ProcessExited,
                                message: self.transport.phrases().connection_lost.into(),
                                retryable: true,
                            });
                            if init_seen {
                                // the interrupted turn is over for the transcript
                                self.log.push(AgentEvent::TurnFinished {
                                    reason: TurnFinishReason::Error,
                                    duration_ms: 0,
                                    api_duration_ms: None,
                                    num_turns: None,
                                    is_error: true,
                                    result: None,
                                    session_id: Some(g.session_id.clone()),
                                    errors: vec![self.transport.phrases().ended_in_turn.into()],
                                });
                            }
                            respawn = Some((replay, None));
                        } else {
                            g.state = AgentSessionState::Error;
                            g.queue.clear();
                            self.log.push(AgentEvent::Error {
                                kind: AgentErrorKind::ProcessExited,
                                message: self.transport.phrases().keeps_exiting.into(),
                                retryable: true,
                            });
                            self.log.push(AgentEvent::SessionEnded {
                                reason: SessionEndReason::Exit,
                                exit_code: code,
                                signal,
                            });
                        }
                    }
                }
            }
        }
        let ended_card = closed.is_some();
        let summary = closed.and_then(|turn| self.changes.finish(turn));
        if let Some(summary) = &summary {
            self.log.push(AgentEvent::TurnChanges(summary.clone()));
        }
        // the process died under a turn that is not resumed: it is over
        if had_turn && respawn.is_none() {
            self.emit_turn_finished(summary.as_ref(), Vec::new());
        }
        if ended_card {
            self.push_session_changes();
        }
        if let Some((replay, replaced_from)) = respawn {
            let me = Arc::clone(self);
            self.spawn_helper("agent-respawn", move |_| {
                // before the new process: the notice comes ahead of its first events
                if let Some(why) = reloaded {
                    me.log
                        .push(AgentEvent::SessionReloaded { reason: why.text() });
                }
                me.respawn(replay, replaced_from)
            });
        }
    }

    fn respawn(self: &Arc<Self>, replay: Vec<Outgoing>, replaced_from: Option<String>) {
        if let Some(old) = replaced_from {
            let new = self.session_id();
            let chats = self.ports.chats();
            chats.session_replaced(&self.root, &self.chat_id, &old, &new);
            let seed = chats.replay_seed(&self.root, &self.chat_id);
            self.inner.lock().seed = seed;
        }
        {
            let mut g = self.inner.lock();
            for out in replay.into_iter().rev() {
                g.queue.push_front(out);
            }
        }
        match self.ensure_process() {
            Ok(()) => {
                let mut g = self.inner.lock();
                if g.queue.is_empty()
                    && !g.turn_active
                    && matches!(
                        g.state,
                        AgentSessionState::Reconnecting | AgentSessionState::Starting
                    )
                    && g.ready
                {
                    g.state = AgentSessionState::Idle;
                }
            }
            Err(e) => {
                let mut g = self.inner.lock();
                g.turn_active = false;
                g.queue.clear();
                g.inflight.clear();
                g.state = AgentSessionState::Error;
                self.log.push(e.to_event(self.transport.phrases()));
            }
        }
    }

    fn drop_pending(&self, g: &mut Inner) {
        let all: Vec<(String, PendingPerm)> = g.pending.drain().collect();
        for (id, p) in all {
            self.log.push(match p.question {
                Some(q) => AgentEvent::QuestionResolved {
                    request_id: id,
                    tool_call_id: q.tool_call_id,
                    resolution: QuestionResolution::Cancelled,
                    answers: vec![],
                },
                None => AgentEvent::PermissionResolved {
                    request_id: id,
                    resolution: PermissionResolution::Cancelled,
                },
            });
        }
    }

    fn finish_terminal(
        &self,
        g: &mut Inner,
        reason: SessionEndReason,
        code: Option<i32>,
        signal: Option<String>,
    ) {
        g.terminal = true;
        g.turn_active = false;
        g.queue.clear();
        g.state = AgentSessionState::Ended;
        self.drop_pending(g);
        self.log.push(AgentEvent::SessionEnded {
            reason,
            exit_code: code,
            signal,
        });
        self.log.close();
        if let Some(shared) = self.shared.upgrade() {
            shared.remove_if_same(self);
        }
    }

    // ---------------------------------------------------------------- outbound

    /// Hand the next queued user message to the backend when it is ready and no turn is running.
    fn flush_queue(&self, g: &mut Inner) {
        // a process that is being stopped gets nothing: the respawn sends the queue
        if !g.ready || g.turn_active || g.terminal || g.closing.is_some() {
            return;
        }
        let Some(mut out) = g.queue.pop_front() else {
            if matches!(
                g.state,
                AgentSessionState::Starting | AgentSessionState::Reconnecting
            ) {
                g.state = AgentSessionState::Idle;
            }
            return;
        };
        if out.receipt.is_none() {
            out.start
                .get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
        }
        g.inflight.push(out.clone());
        let sent = match g.seed.take() {
            Some(seed) => format!("{seed}\n\n{}", out.text),
            None => out.text.clone(),
        };
        g.turn_active = true;
        g.turn_seq += 1;
        self.changes.begin_turn(&self.chat_id);
        g.last_activity = Instant::now();
        if g.state == AgentSessionState::Idle || g.state == AgentSessionState::Reconnecting {
            g.state = AgentSessionState::Running;
        }
        match &out.receipt {
            // a queued line sent again (a restart replay, or no turn to join): the echo is its
            // receipt, so it is tracked like a line written mid-turn
            Some(uuid) => {
                g.unechoed.push(Unechoed {
                    uuid: uuid.clone(),
                    out: out.clone(),
                    kind: LineKind::Queued,
                    watching: true,
                    accepted: false,
                });
                self.watch_receipt(g.live_gen, uuid);
                self.transport.send(&Outbound {
                    text: &sent,
                    files: &out.files,
                    delivery: Delivery::Queued { receipt: uuid },
                });
            }
            None => {
                self.transport.send(&Outbound {
                    text: &sent,
                    files: &out.files,
                    delivery: Delivery::Start {
                        receipt: out.start.as_deref().unwrap_or_default(),
                    },
                });
            }
        }
    }

    // -------------------------------------------------------------- commands

    /// Queue the user's message; it is written now when idle, after the running turn
    /// otherwise, and the process is started first when there is none.
    pub(crate) fn send(self: &Arc<Self>, out: Outgoing) -> Result<(), SpawnError> {
        // an idle chat's message starts a turn: `agent.turn-started` (may block, no lock held).
        // The decision is made and recorded under the lock, so of two concurrent sends to an
        // idle chat exactly one announces the turn.
        let (starts_turn, turn) = {
            let mut g = self.inner.lock();
            let idle = !g.terminal && !self.is_busy(&g) && !g.turn_starting;
            g.turn_starting |= idle;
            // the number the turn takes when its message is flushed
            (idle, g.turn_seq + 1)
        };
        if starts_turn {
            self.points.emit(
                &api::TURN_STARTED,
                &api::TurnStarted {
                    root: self.root.clone(),
                    chat_id: self.chat_id.clone(),
                    turn,
                },
            );
        }
        let need_process = {
            let mut g = self.inner.lock();
            // from here the message is in the queue (or refused), so the chat reads as busy
            g.turn_starting &= !starts_turn;
            if g.terminal {
                if starts_turn {
                    drop(g);
                    self.emit_turn_finished(None, Vec::new());
                    return Err(SpawnError::Ended);
                }
                return Err(SpawnError::Ended);
            }
            g.respawns = 0;
            // stale and idle: restart first, then send (the respawn writes the queue)
            let restart_first = g.stale.is_some()
                && config_sync::decide(self.stale_view(&g, self.is_busy(&g)))
                    == Decision::RestartNow;
            g.queue.push_back(out);
            if g.live_gen.is_none() && !g.spawning {
                true
            } else if restart_first {
                let why = self.config_why(&g);
                self.begin_reload(&mut g, why);
                false
            } else {
                self.flush_queue(&mut g);
                false
            }
        };
        if need_process {
            if let Err(e) = self.ensure_process() {
                let mut g = self.inner.lock();
                g.queue.clear();
                g.state = AgentSessionState::Error;
                self.log.push(e.to_event(self.transport.phrases()));
                drop(g);
                if starts_turn {
                    self.emit_turn_finished(None, Vec::new());
                }
            }
        }
        Ok(())
    }

    /// A steer: write the message to the CLI now, into the running turn, never held in Writer's
    /// queue. It carries `priority:"now"`: the CLI aborts the running tool or text, ends that turn
    /// and starts this message's turn at once. `message_id` (the UI's card key, a uuid) is the
    /// receipt id: the CLI echoes it, and a steer not echoed within `Timing::steer_ack` is
    /// reported undelivered. With no running turn on a live process it is an ordinary send.
    pub(crate) fn steer(
        self: &Arc<Self>,
        out: Outgoing,
        message_id: &str,
    ) -> Result<(), SpawnError> {
        let Some((gen, uuid)) = self.write_mid_turn(out.clone(), message_id, LineKind::Steer)?
        else {
            return self.send(out);
        };
        self.watch_receipt(gen, &uuid);
        Ok(())
    }

    /// A message sent with Enter while a turn runs: write it to the CLI now as a plain line (no
    /// `priority`), never held in Writer's queue. The CLI injects it after the next tool result of
    /// the running turn, or runs it right after the turn; its echo (`message-received`) says which
    /// and where. `message_id` is the receipt id. Where no turn can take it (idle, starting,
    /// cancelling) it is an ordinary send that keeps the id, so the echo still resolves it.
    pub(crate) fn queue_line(
        self: &Arc<Self>,
        mut out: Outgoing,
        message_id: &str,
    ) -> Result<(), SpawnError> {
        // `unqueue` finds the line by the same id, so it must be one the CLI can echo
        if uuid::Uuid::parse_str(message_id).is_err() {
            return Err(SpawnError::Invalid("the message id must be a uuid".into()));
        }
        out.receipt = Some(message_id.to_string());
        let written = self.write_mid_turn(out.clone(), message_id, LineKind::Queued)?;
        if written.is_none() {
            return self.send(out);
        }
        Ok(())
    }

    /// Writes `out` into the running turn and tracks it until echoed. `None`: nothing was written
    /// (no turn runs on a live process, or it is being stopped); otherwise the process generation
    /// and the receipt id.
    fn write_mid_turn(
        &self,
        mut out: Outgoing,
        message_id: &str,
        kind: LineKind,
    ) -> Result<Option<(Option<u64>, String)>, SpawnError> {
        let mut g = self.inner.lock();
        if g.terminal {
            return Err(SpawnError::Ended);
        }
        if !(g.ready
            && g.turn_active
            && g.closing.is_none()
            && g.state != AgentSessionState::Cancelling)
        {
            return Ok(None);
        }
        let uuid = receipt_id(message_id);
        if kind == LineKind::Queued {
            out.receipt = Some(uuid.clone());
        }
        g.unechoed.push(Unechoed {
            uuid: uuid.clone(),
            out: out.clone(),
            kind,
            watching: kind == LineKind::Steer,
            accepted: false,
        });
        g.inflight.push(out.clone());
        g.last_activity = Instant::now();
        self.transport.send(&Outbound {
            text: &out.text,
            files: &out.files,
            delivery: match kind {
                LineKind::Steer => Delivery::Steer { receipt: &uuid },
                LineKind::Queued => Delivery::Queued { receipt: &uuid },
            },
        });
        Ok(Some((g.live_gen, uuid)))
    }

    /// Takes a queued line back before the backend took it: `true` when it was still waiting and
    /// is gone (the backend never runs it), `false` when it already took it (its receipt is
    /// coming or came). Blocks for the backend's answer. An error means no answer came; the line
    /// stays tracked.
    pub(crate) fn unqueue(&self, message_id: &str) -> Result<bool, SpawnError> {
        let uuid = message_id.to_string();
        {
            let mut g = self.inner.lock();
            if g.terminal {
                return Err(SpawnError::Ended);
            }
            // still in Writer's own queue (no process yet): drop it there
            if let Some(i) = g
                .queue
                .iter()
                .position(|o| o.receipt.as_deref() == Some(uuid.as_str()))
            {
                g.queue.remove(i);
                return Ok(true);
            }
            let waiting = g
                .unechoed
                .iter()
                .any(|u| u.uuid == uuid && u.kind == LineKind::Queued);
            if !waiting || !g.ready {
                return Ok(false);
            }
        }
        match self.transport.unqueue(&uuid, self.timing.unqueue_ack) {
            // a confirmed cancel was already forgotten, in order, through `Message::Unqueued`
            Ok(cancelled) => Ok(cancelled),
            Err(_) => Err(SpawnError::Invalid(
                self.transport.phrases().no_answer.into(),
            )),
        }
    }

    /// Forget every written message (the user's stop, a failed turn). A queued line is also taken
    /// out of the CLI's queue (best effort, no answer awaited) and its chip told it is gone
    /// (`steer-undelivered`); a steer has no chip.
    fn forget_unechoed(&self, g: &mut Inner) {
        for u in std::mem::take(&mut g.unechoed) {
            if u.kind != LineKind::Queued {
                continue;
            }
            if g.ready {
                self.transport.discard(&u.uuid);
            }
            self.log
                .push(AgentEvent::SteerUndelivered { message_id: u.uuid });
        }
    }

    /// Starts the receipt watchdog of every written message that has none yet.
    fn watch_unwatched(&self, g: &mut Inner) {
        let gen = g.live_gen;
        for u in g.unechoed.iter_mut().filter(|u| !u.watching) {
            u.watching = true;
            self.watch_receipt(gen, &u.uuid);
        }
    }

    /// A thread (the shape of the cancel watchdog) that reports `uuid` undelivered when the CLI
    /// has not echoed it within `Timing::steer_ack`.
    fn watch_receipt(&self, gen: Option<u64>, uuid: &str) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let wait = self.timing.steer_ack;
        let uuid = uuid.to_string();
        self.spawn_helper("agent-steer-ack", move |sp| {
            if sp.sleep(wait) {
                me.receipt_overdue(gen, &uuid);
            }
        });
    }

    /// The receipt time is up: unless it arrived, report it and, when it was what kept the
    /// session working, let the session go idle.
    fn receipt_overdue(&self, gen: Option<u64>, uuid: &str) {
        let mut g = self.inner.lock();
        if g.live_gen != gen {
            return;
        }
        let Some(i) = g.unechoed.iter().position(|u| u.uuid == uuid) else {
            return;
        };
        if g.unechoed[i].accepted {
            // the CLI has it and will run it when its running tool calls end: keep waiting
            // (a stop, a failed turn or the process ending forgets it)
            return;
        }
        let late = g.unechoed.remove(i);
        log::warn!(target: "agent", "agent: a message was not acknowledged by the backend");
        if late.kind == LineKind::Queued && g.ready {
            // it must not run later, behind the chip that is about to send it again
            self.transport.discard(&late.uuid);
        }
        self.log.push(AgentEvent::SteerUndelivered {
            message_id: uuid.to_string(),
        });
        self.release_hold(&mut g);
    }

    /// Nothing written is waiting for an echo any more: a turn that was held for it is over.
    fn release_hold(&self, g: &mut Inner) {
        if g.unechoed.is_empty() && g.echo_hold {
            self.end_turn(g, None);
        }
    }

    /// The one tail of a turn (its `turn-finished`, or the release of one held for an echo):
    /// idle again, then whatever waited for this moment, a restart first and else the queue.
    /// `finished` is the event to log between the two (none when it was logged at the hold).
    fn end_turn(&self, g: &mut Inner, finished: Option<AgentEvent>) {
        g.echo_hold = false;
        g.turn_active = false;
        g.inflight.clear();
        g.respawns = 0;
        g.cancel_token += 1;
        g.state = AgentSessionState::Idle;
        if let Some(ev) = finished {
            self.log.push(ev);
        }
        // stale: restart right after the turn (a waiting message is sent after it)
        // (not while a background sub-agent runs or its report turn is still to come)
        let stale_restart = g.stale.is_some()
            && config_sync::decide(self.stale_view(g, g.background_open)) == Decision::RestartNow;
        if stale_restart {
            g.restart_after_turn = false;
            let why = self.config_why(g);
            self.begin_reload(g, why);
        } else if g.restart_after_turn && !g.background_open {
            g.restart_after_turn = false;
            g.closing = Some(Closing::Restart);
            self.terminate(g);
        } else {
            self.flush_queue(g);
        }
    }

    /// "Reload session": replace an idle process by a new one (`--resume`, same argv otherwise) so
    /// it re-reads skills, MCP servers, settings and instruction files. Refused (`Busy`) while a
    /// turn runs, a permission card is open or a process is starting, never queued: a restart
    /// that fires later, behind the user's back, would cut nothing short but would be invisible.
    /// With no process (never started, or ended when idle) there is nothing to stop: the next
    /// message already starts a fresh one, so only the notice is reported.
    pub(crate) fn reload(self: &Arc<Self>) -> Result<ReloadOutcome, SpawnError> {
        let mut g = self.inner.lock();
        if g.terminal {
            return Err(SpawnError::Ended);
        }
        if self.is_busy(&g) {
            return Ok(ReloadOutcome::Busy);
        }
        if g.live_gen.is_none() {
            drop(g);
            self.log.push(AgentEvent::SessionReloaded { reason: None });
            return Ok(ReloadOutcome::Started);
        }
        log::info!(target: "agent", "agent: reloading the session");
        self.begin_reload(&mut g, ReloadWhy::Manual);
        Ok(ReloadOutcome::Started)
    }

    // ----------------------------------------------------------- config change (config_sync)

    /// A turn runs, a background sub-agent still works (or the turn that reports it is to come),
    /// a permission card is open, a process is starting or being replaced, or a message waits: a
    /// restart must not cut into it. The one fact behind the manual reload, the config sync and
    /// the project move.
    fn is_busy(&self, g: &Inner) -> bool {
        g.turn_active
            || g.background_open
            || !g.pending.is_empty()
            || g.spawning
            || !g.queue.is_empty()
            || g.closing.is_some()
            || matches!(
                g.state,
                AgentSessionState::Starting
                    | AgentSessionState::Reconnecting
                    | AgentSessionState::Cancelling
            )
    }

    /// The setting is on and the backend needs the restart (`RoleAdapter::restart_on_config_change`).
    fn restarts_on_config(&self, g: &Inner) -> bool {
        g.launch.settings.auto_reload && g.launch.restart_on_config_change
    }

    fn stale_view(&self, g: &Inner, busy: bool) -> StaleView {
        StaleView {
            auto_reload: g.launch.settings.auto_reload,
            backend_restarts: g.launch.restart_on_config_change,
            live: g.live_gen.is_some(),
            busy,
        }
    }

    fn config_why(&self, g: &Inner) -> ReloadWhy {
        g.stale
            .as_ref()
            .map_or(ReloadWhy::Manual, |r| ReloadWhy::Config(r.describe()))
    }

    /// Stops the connection so that the restart path starts a fresh one (`--resume`, same argv).
    fn begin_reload(&self, g: &mut Inner, why: ReloadWhy) {
        g.reload_pending = Some(why);
        g.closing = Some(Closing::Restart);
        self.stop(g, |t| t.reload());
    }

    #[cfg(test)]
    pub(crate) fn set_restart_on_config_change_for_test(&self, on: bool) {
        self.inner.lock().launch.restart_on_config_change = on;
    }

    /// A watched file changed: `true` when this chat's process is now stale (the worker then
    /// arms the debounce). Nothing for a chat without a process, with the setting off, or on a
    /// backend that reloads itself.
    pub(crate) fn config_changed(&self, reason: Reason) -> bool {
        let mut g = self.inner.lock();
        if g.terminal || g.live_gen.is_none() || !self.restarts_on_config(&g) {
            return false;
        }
        if g.stale.is_none() {
            g.stale = Some(reason);
        }
        true
    }

    /// The change burst is over: apply [`config_sync::decide`]. Busy chats are left stale; the
    /// end of the turn restarts them (`apply`, `TurnFinished`).
    pub(crate) fn settle(&self) {
        let mut g = self.inner.lock();
        if g.stale.is_none() || g.terminal {
            return;
        }
        match config_sync::decide(self.stale_view(&g, self.is_busy(&g))) {
            Decision::RestartNow => {
                log::info!(target: "agent", "agent: config changed, restarting the idle process");
                let why = self.config_why(&g);
                self.begin_reload(&mut g, why);
            }
            Decision::AfterTurn => {}
            Decision::Ignore | Decision::Forget => g.stale = None,
        }
    }

    /// What the MCP re-check runs, `None` when there is no process (or the chat ended). The
    /// environment is built outside the lock (it may run the login shell).
    pub(crate) fn probe_target(&self) -> Option<ProbeTarget> {
        let (program, cli_dir, memory) = {
            let g = self.inner.lock();
            if g.terminal || g.live_gen.is_none() {
                return None;
            }
            (
                g.launch.program.clone()?,
                g.launch.cli_dir.clone(),
                g.launch.settings.memory,
            )
        };
        Some(ProbeTarget {
            program,
            cwd: self.cwd.clone(),
            env: env::with_memory_mode(env::current(cli_dir.as_deref()), memory),
        })
    }

    /// The result of an MCP re-check. A server that was failing and connects now makes the chat
    /// stale (once per server and chat), reason "MCP server <name> connected".
    pub(crate) fn mcp_checked(&self, probed: &[McpServerStatus]) -> McpWatch {
        let mut g = self.inner.lock();
        if g.terminal || g.live_gen.is_none() || !self.restarts_on_config(&g) {
            return McpWatch::Stop;
        }
        let check = config_sync::check(&g.mcp_failing, probed);
        g.mcp_failing = check.still_failing;
        let fresh = check
            .recovered
            .into_iter()
            .find(|n| !g.mcp_restarted.contains(n));
        if let Some(name) = fresh {
            g.mcp_restarted.insert(name.clone());
            if g.stale.is_none() {
                g.stale = Some(Reason::McpServer(name));
            }
            return McpWatch::Recovered;
        }
        if g.mcp_failing.is_empty() {
            McpWatch::Stop
        } else {
            McpWatch::Keep
        }
    }

    pub(crate) fn cancel(self: &Arc<Self>) {
        let mut g = self.inner.lock();
        g.queue.clear();
        self.forget_unechoed(&mut g);
        if g.live_gen.is_none() {
            g.turn_active = false;
            return;
        }
        if !g.turn_active && g.pending.is_empty() {
            return;
        }
        g.state = AgentSessionState::Cancelling;
        self.transport.interrupt();
        let (token, gen) = (g.cancel_token, g.live_gen);
        drop(g);
        let me = Arc::clone(self);
        let grace = self.timing.cancel_grace;
        self.spawn_helper("agent-cancel", move |sp| {
            if !sp.sleep(grace) {
                return;
            }
            let mut g = me.inner.lock();
            if g.live_gen == gen && g.cancel_token == token && g.turn_active {
                log::warn!(target: "agent", "agent: no turn-finished after the interrupt, killing the process");
                g.closing = Some(Closing::Killed);
                me.signal(&g, Close::Kill);
            }
        });
    }

    pub(crate) fn permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
        persist: Option<PermissionPersist>,
        rules: Option<Vec<String>>,
        message: Option<String>,
    ) -> Result<(), String> {
        let mut g = self.inner.lock();
        if g.live_gen.is_none() {
            return Err("this chat has no running process".into());
        }
        if g.pending
            .get(request_id)
            .is_some_and(|p| p.question.is_some())
        {
            return Err("this request is a question; answer it with the question command".into());
        }
        let Some(pending) = g.pending.get(request_id) else {
            return Err("unknown or already resolved permission request".into());
        };
        let perms = updated_permissions(&pending.suggestions, persist, rules.as_deref());
        if decision == PermissionDecision::Allow && rules.is_some() && perms.is_empty() {
            // the request stays open: the card can answer again
            return Err("none of the chosen rules was offered for this request".into());
        }
        let p = g.pending.remove(request_id).expect("checked above");
        let (reply, resolution) = match decision {
            PermissionDecision::Allow => (
                PermissionReply::Allow {
                    input: &p.input,
                    persist,
                    rules: rules.as_deref(),
                    suggestions: &p.suggestions,
                },
                PermissionResolution::Allowed,
            ),
            PermissionDecision::Deny => (
                PermissionReply::Deny {
                    message: message
                        .as_deref()
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .unwrap_or(DENY_MESSAGE),
                },
                PermissionResolution::Denied,
            ),
        };
        g.last_activity = Instant::now();
        if let (PermissionResolution::Allowed, Some(call)) = (resolution, &p.command_call) {
            // the command runs from now
            let by = g.subs.author_of(Some(call));
            self.changes
                .command_started(&self.chat_id, call, by.as_ref(), Instant::now());
        }
        self.transport.answer_permission(request_id, reply);
        self.log.push(AgentEvent::PermissionResolved {
            request_id: request_id.to_string(),
            resolution,
        });
        if g.pending.is_empty() && g.state == AgentSessionState::AwaitingPermission {
            g.state = AgentSessionState::Running;
        }
        Ok(())
    }

    /// Answers an open question card: `answers` `None` declines it. The reply is the transport's
    /// (the backend's shape), the card's end is the `question-resolved` event.
    pub(crate) fn answer_question(
        &self,
        request_id: &str,
        answers: Option<Vec<QuestionAnswer>>,
    ) -> Result<(), String> {
        let mut g = self.inner.lock();
        if g.live_gen.is_none() {
            return Err("this chat has no running process".into());
        }
        let Some(q) = g
            .pending
            .get(request_id)
            .and_then(|p| p.question.as_ref())
            .map(|q| q.tool_call_id.clone())
        else {
            return Err("unknown or already resolved question".into());
        };
        if !self
            .transport
            .answer_question(request_id, answers.as_deref())
        {
            return Err("unknown or already resolved question".into());
        }
        g.pending.remove(request_id);
        g.last_activity = Instant::now();
        let skipped = answers.is_none();
        self.log.push(AgentEvent::QuestionResolved {
            request_id: request_id.to_string(),
            tool_call_id: q,
            resolution: if skipped {
                QuestionResolution::Skipped
            } else {
                QuestionResolution::Answered
            },
            answers: answers.unwrap_or_default(),
        });
        if g.pending.is_empty() && g.state == AgentSessionState::AwaitingPermission {
            g.state = AgentSessionState::Running;
        }
        Ok(())
    }

    pub(crate) fn set_permission_mode(&self, mode: AgentPermissionMode) {
        let mut g = self.inner.lock();
        // a refusal restarts with the new mode (`Message::Refused`)
        g.launch.settings.permission_mode = mode;
        if g.live_gen.is_none() || !g.ready {
            // takes effect at the next spawn
            return;
        }
        self.transport.set_permission_mode(mode);
    }

    /// Live model switch where the backend can do it. A changed effort is a spawn flag for the
    /// CLI, so it (or a refused or impossible request) restarts with `--resume` at the next idle
    /// moment.
    pub(crate) fn set_model(&self, model: Option<String>, effort: Option<Effort>) {
        let mut g = self.inner.lock();
        let model = model.filter(|m| !m.is_empty());
        let change = ModelChange {
            model_changed: g.launch.settings.model != model,
            effort_changed: g.launch.settings.effort != effort,
            model: model.clone(),
            effort,
        };
        g.launch.settings.model = model;
        g.launch.settings.effort = effort;
        if g.live_gen.is_none() || !g.ready {
            return; // takes effect at the next spawn
        }
        if self.transport.set_model(&change) == LiveChange::Restart {
            self.restart_when_idle(&mut g);
        }
    }

    /// Rebind the chat to another CLI session (the next spawn resumes it).
    pub(crate) fn rebind(&self, session_id: String) {
        let mut g = self.inner.lock();
        if g.session_id == session_id {
            return;
        }
        g.session_id = session_id;
        g.resume_next = true;
        g.fallback_used = false;
        if g.live_gen.is_some() {
            g.closing = Some(Closing::Restart);
            self.terminate(&g);
        }
    }

    /// Graceful close: stdin ends, then the group is signalled after the grace period.
    pub(crate) fn close(self: &Arc<Self>) {
        let g = self.inner.lock();
        self.close_locked(g);
    }

    /// [`Self::close`] unless a turn runs, a permission card is open, a process is starting or a
    /// message waits; then nothing is done and `false` is returned. The check and the close are
    /// one critical section, so a turn cannot slip in between. An ended session counts as closed.
    pub(crate) fn close_if_idle(self: &Arc<Self>) -> bool {
        let g = self.inner.lock();
        if !g.terminal && self.is_busy(&g) {
            return false;
        }
        self.close_locked(g);
        true
    }

    /// Is the session working (see [`Self::is_busy`]) and not already ended?
    pub(crate) fn is_working(&self) -> bool {
        let g = self.inner.lock();
        !g.terminal && self.is_busy(&g)
    }

    fn close_locked(self: &Arc<Self>, mut g: StateGuard<'_>) {
        if g.terminal {
            return;
        }
        g.terminal = true;
        g.queue.clear();
        if let Some(gen) = g.live_gen {
            g.closing = Some(Closing::Closed);
            self.transport.close(Close::Graceful);
            drop(g);
            let me = Arc::clone(self);
            let grace = self.timing.close_grace;
            self.spawn_helper("agent-close", move |sp| {
                if !sp.sleep(grace) {
                    return;
                }
                let g = me.inner.lock();
                if g.live_gen == Some(gen) {
                    me.terminate(&g);
                }
            });
        } else {
            self.finish_terminal(&mut g, SessionEndReason::Closed, None, None);
        }
    }

    /// Window closed, vault switched, trust revoked, app exit: kill the group at once.
    pub(crate) fn shutdown(&self) {
        let mut g = self.inner.lock();
        if g.terminal {
            return;
        }
        g.terminal = true;
        g.queue.clear();
        if g.live_gen.is_some() {
            g.closing = Some(Closing::Shutdown);
            self.signal(&g, Close::Kill);
        } else {
            self.finish_terminal(&mut g, SessionEndReason::VaultSwitched, None, None);
        }
    }

    /// Idle for longer than the limit: end the process quietly (the next message resumes).
    pub(crate) fn reap_if_idle(self: &Arc<Self>) {
        let mut g = self.inner.lock();
        if g.live_gen.is_some()
            && g.ready
            && g.closing.is_none()
            && !g.turn_active
            && !g.background_open
            && g.pending.is_empty()
            && g.queue.is_empty()
            && g.last_activity.elapsed() >= self.timing.idle_after
        {
            log::info!(target: "agent", "agent: ending an idle process");
            g.closing = Some(Closing::Idle);
            self.terminate(&g);
        }
    }

    fn signal(&self, g: &Inner, how: Close) {
        if g.live_gen.is_some() {
            self.transport.close(how);
        }
    }

    /// SIGTERM to the group, SIGKILL after the escalation delay when it is still there.
    fn terminate(&self, g: &Inner) {
        self.stop(g, |t| t.close(Close::Terminate));
    }

    /// Asks the connection to stop (`first`), then stops it for good after the escalation delay if
    /// it is still there.
    fn stop(&self, g: &Inner, first: impl FnOnce(&dyn Transport)) {
        if g.live_gen.is_some() {
            first(&*self.transport);
        }
        let Some(gen) = g.live_gen else {
            return;
        };
        let me = self.me.clone();
        let wait = self.timing.term_to_kill;
        self.spawn_helper("agent-kill", move |sp| {
            if !sp.sleep(wait) {
                return;
            }
            if let Some(s) = me.upgrade() {
                let g = s.inner.lock();
                if g.live_gen == Some(gen) {
                    s.signal(&g, Close::Kill);
                }
            }
        });
    }

    pub(crate) fn snapshot(&self, after_seq: u64) -> (AgentSessionState, Vec<AgentEventEnvelope>) {
        let state = self.inner.lock().state;
        (state, self.log.snapshot(after_seq))
    }
}

#[cfg(test)]
mod sub_models_tests {
    use super::SubModels;

    #[test]
    fn the_reported_model_wins_over_the_tier_and_the_tier_is_the_fallback() {
        let mut m = SubModels::default();
        m.tier("a1", "sonnet");
        m.tier("a2", "haiku");
        m.reported("a1", "claude-opus-5-5");
        m.reported("a1", "claude-opus-5-5");
        m.reported("a3", "claude-opus-5-5");
        assert_eq!(m.models(), ["claude-opus-5-5", "haiku"]);
    }
}
