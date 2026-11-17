//! One chat's `claude` process: spawn (never a bypass flag, `build_args` is the only argv
//! builder), the stdin writer thread, the stdout line reader feeding `ClaudeStreamMapper`, the
//! state machine, the permission round trip, interrupt, queue, crash handling and `--resume`.
//! Spec: `SPECs/native-agent-spec.md` sections 2, 6, 8, 11, 13 (lane 1).
//!
//! Threading. `ProcManager` (shared with the plugin host, a separate instance) owns the process,
//! its process group and its pipes and calls our `Emit` closure from its reader/waiter threads.
//! Everything that mutates a chat goes through `Session::inner` (one lock). Lines for the CLI
//! go through one channel to one writer thread so JSON lines never interleave and a slow pipe
//! never blocks the reader. Events go to the [`EventLog`], which numbers, rings and emits them.
//! No lock of `inner` is ever held across a call into a port, the login shell or
//! `ProcManager::spawn`.
//!
//! Never logged: user text, assistant text, tool input/output, note paths, the system prompt,
//! environment values (spec section 8).

use super::binary::is_older_than_verified;
use super::changes::{ChangeStore, ClosedTurn};
use super::claude_stream::{
    build_args, encode_control_error, encode_interrupt, encode_permission_allow,
    encode_permission_deny, encode_set_model, encode_set_permission_mode, encode_user_message,
    updated_permissions, ClaudeSpawn, ClaudeStreamMapper, SessionRef,
};
use super::env;
use super::events::*;
use super::images::Outgoing;
use super::ports::{AgentPorts, ChatSessionInfo};
use super::session::{EventLog, Shared, Sink, Timing};
use super::sub_tracker::SubTracker;
use crate::plugin_proc::{Emit, Prepared, ProcEvent, ProcManager, Sig};
use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Weak};
use std::time::Instant;

/// Live agent processes per window (spec 8). The plugin host's cap of 8 is separate.
pub const MAX_LIVE_PER_WINDOW: usize = 4;
/// Respawns after an unexpected exit, reset by the next finished turn.
const MAX_RESPAWNS: u8 = 2;
/// A stdout line over this size is dropped with a content-free protocol error.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
const STDERR_KEEP: usize = 2048;
const DENY_MESSAGE: &str = "The user denied this action";

/// Why a process could not be started. All of them become an `error` event for the chat
/// (the pane's error cards), none of them an IPC rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    NotFound,
    /// The window already has `MAX_LIVE_PER_WINDOW` live processes.
    Busy,
    Invalid(String),
    Ended,
}

impl SpawnError {
    pub fn to_event(&self) -> AgentEvent {
        let (kind, message, retryable) = match self {
            Self::NotFound => (
                AgentErrorKind::BinaryNotFound,
                "The claude program was not found".to_string(),
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

/// Settings of the next spawn, refreshed by every `agent_start`.
pub(crate) struct LaunchConfig {
    pub program: Option<PathBuf>,
    pub cli_version: Option<String>,
    pub system_prompt: Option<String>,
    pub add_dirs: Vec<String>,
    /// The `--agents` JSON (`subagents::agents_json`), `None` when orchestration is off.
    pub agents: Option<String>,
    /// Directory holding the `writer` launcher, put first on the child's PATH (`cli_launcher`);
    /// `None` when there is none.
    pub cli_dir: Option<PathBuf>,
    /// The memory folder of this chat (`agent.memory` = `vault`), created already.
    pub memory_dir: Option<PathBuf>,
    pub settings: AgentSettings,
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

struct PendingPerm {
    input: Value,
    suggestions: Vec<Value>,
}

struct Inner {
    // refreshed by `configure`
    program: Option<PathBuf>,
    cli_version: Option<String>,
    system_prompt: Option<String>,
    add_dirs: Vec<String>,
    agents: Option<String>,
    cli_dir: Option<PathBuf>,
    memory_dir: Option<PathBuf>,
    settings: AgentSettings,

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
    stderr: Vec<u8>,
    pid: Option<u32>,

    state: AgentSessionState,
    mapper: ClaudeStreamMapper,
    /// Tool name by call id for the current turn: `tool-call-input` carries only the id.
    tool_names: HashMap<String, String>,
    /// Who made each call and which sub-agents are still working (see `sub_tracker.rs`).
    subs: SubTracker,
    /// The first `turn-finished` came while a sub-agent still worked: the Changes card stays open
    /// (late sub-agent edits join it) until a later `turn-finished` finds none working, or the
    /// process ends.
    changes_deferred: bool,
    pending: HashMap<String, PendingPerm>,
    turn_active: bool,
    queue: VecDeque<Outgoing>,
    inflight: Vec<Outgoing>,
    seed: Option<String>,
    respawns: u8,
    fallback_used: bool,
    cancel_token: u64,
    counter: u64,
    mode_request: Option<(String, AgentPermissionMode)>,
    /// (request id, the model asked for)
    model_request: Option<(String, Option<String>)>,
    restart_after_turn: bool,
    last_activity: Instant,
}

pub struct Session {
    pub(crate) chat_id: String,
    pub(crate) label: String,
    pub(crate) root: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) project_path: Option<String>,
    me: Weak<Session>,
    shared: Weak<Shared>,
    procs: Arc<ProcManager>,
    ports: Arc<AgentPorts>,
    changes: Arc<ChangeStore>,
    timing: Timing,
    pub(crate) log: Arc<EventLog>,
    /// Counted toward the per-window cap (set under `Shared::gate`).
    live: AtomicBool,
    /// `ProcManager` id of the current process, 0 for none; read by the writer thread.
    proc_cell: Arc<AtomicU64>,
    write_tx: Sender<String>,
    inner: Mutex<Inner>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.log.close();
    }
}

fn writer_thread(
    rx: Receiver<String>,
    procs: Arc<ProcManager>,
    label: String,
    cell: Arc<AtomicU64>,
) {
    for line in rx {
        let id = cell.load(Ordering::SeqCst);
        if id == 0 {
            log::warn!(target: "agent", "agent: dropped a stdin line (no process)");
            continue;
        }
        let mut data = line.into_bytes();
        data.push(b'\n');
        if let Err(e) = procs.write(&label, id, &data) {
            // the error text names no content
            log::warn!(target: "agent", "agent: stdin write failed: {e}");
        }
    }
}

enum LineItem {
    Line(String),
    TooLong,
}

#[derive(Default)]
struct LineBuf {
    buf: Vec<u8>,
    discarding: bool,
}

impl LineBuf {
    fn push(&mut self, data: &[u8]) -> Vec<LineItem> {
        let mut out = Vec::new();
        for chunk in data.split_inclusive(|b| *b == b'\n') {
            let ends = chunk.ends_with(b"\n");
            if self.discarding {
                if ends {
                    self.discarding = false;
                    out.push(LineItem::TooLong);
                }
                continue;
            }
            self.buf.extend_from_slice(chunk);
            if self.buf.len() > MAX_LINE_BYTES {
                self.buf = Vec::new();
                if ends {
                    out.push(LineItem::TooLong);
                } else {
                    self.discarding = true;
                }
                continue;
            }
            if ends {
                let line = String::from_utf8_lossy(&self.buf).trim().to_string();
                self.buf.clear();
                if !line.is_empty() {
                    out.push(LineItem::Line(line));
                }
            }
        }
        out
    }

    fn rest(&mut self) -> Option<String> {
        let line = String::from_utf8_lossy(&self.buf).trim().to_string();
        self.buf.clear();
        (!line.is_empty()).then_some(line)
    }
}

pub(crate) fn redact_prompt(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut redact = false;
    for a in args {
        if redact {
            out.push(format!("<{} bytes>", a.len()));
            redact = false;
        } else {
            // the prompt and the memory folder's path stay out of the log (spec section 8)
            redact = a == "--append-system-prompt" || a == "--settings";
            out.push(a.clone());
        }
    }
    out
}

impl Session {
    pub(crate) fn new(init: SessionInit, config: LaunchConfig) -> Arc<Session> {
        let shared = init.shared.upgrade().expect("registry is alive");
        let (tx, rx) = channel();
        let cell = Arc::new(AtomicU64::new(0));
        let procs = Arc::clone(&shared.procs);
        {
            let (p, l, c) = (Arc::clone(&procs), init.label.clone(), Arc::clone(&cell));
            std::thread::Builder::new()
                .name("agent-stdin".into())
                .spawn(move || writer_thread(rx, p, l, c))
                .expect("spawn stdin writer");
        }
        let log = EventLog::new(init.chat_id.clone(), init.sink);
        Arc::new_cyclic(|me| Session {
            me: me.clone(),
            chat_id: init.chat_id,
            label: init.label,
            root: init.root,
            cwd: init.cwd,
            project_path: init.project_path,
            shared: init.shared,
            procs,
            ports: Arc::clone(&shared.ports),
            changes: Arc::clone(&shared.changes),
            timing: shared.timing,
            log,
            live: AtomicBool::new(false),
            proc_cell: cell,
            write_tx: tx,
            inner: Mutex::new(Inner {
                program: config.program,
                cli_version: config.cli_version,
                system_prompt: config.system_prompt,
                add_dirs: config.add_dirs,
                agents: config.agents,
                cli_dir: config.cli_dir,
                memory_dir: config.memory_dir,
                settings: config.settings,
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
                stderr: Vec::new(),
                pid: None,
                state: AgentSessionState::Idle,
                mapper: ClaudeStreamMapper::new(),
                tool_names: HashMap::new(),
                subs: SubTracker::default(),
                changes_deferred: false,
                pending: HashMap::new(),
                turn_active: false,
                queue: VecDeque::new(),
                inflight: Vec::new(),
                seed: None,
                respawns: 0,
                fallback_used: false,
                cancel_token: 0,
                counter: 0,
                mode_request: None,
                model_request: None,
                restart_after_turn: false,
                last_activity: Instant::now(),
            }),
        })
    }

    // ---------------------------------------------------------------- queries

    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    pub fn state(&self) -> AgentSessionState {
        self.inner.lock().state
    }

    pub fn session_id(&self) -> String {
        self.inner.lock().session_id.clone()
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
        Some((g.program.clone()?, self.cwd.clone()))
    }

    // ---------------------------------------------------------------- start

    /// Refresh the next spawn's configuration. A running process keeps its own.
    pub(crate) fn configure(&self, config: LaunchConfig) {
        let mut g = self.inner.lock();
        if g.live_gen.is_some() || g.spawning {
            return;
        }
        g.program = config.program;
        g.cli_version = config.cli_version;
        g.system_prompt = config.system_prompt;
        g.add_dirs = config.add_dirs;
        g.agents = config.agents;
        g.cli_dir = config.cli_dir;
        g.memory_dir = config.memory_dir;
        g.settings = config.settings;
    }

    /// Report a failure that happened before any process existed.
    pub(crate) fn fail(&self, err: &SpawnError) {
        let mut g = self.inner.lock();
        if !g.terminal {
            g.state = AgentSessionState::Error;
        }
        self.log.push(err.to_event());
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
        let (program, args, used_resume, cli_dir, memory_off) = {
            let mut g = self.inner.lock();
            if g.terminal {
                return Err(SpawnError::Ended);
            }
            if g.live_gen.is_some() || g.spawning {
                return Ok(());
            }
            let program = g.program.clone().ok_or(SpawnError::NotFound)?;
            let used_resume = g.resume_next;
            let session = if used_resume {
                SessionRef::Resume(g.session_id.clone())
            } else {
                SessionRef::New(g.session_id.clone())
            };
            // `--thinking-display` is newer than the verified CLI: an older one would refuse
            // the unknown option and the chat could not start, so it only gets the default.
            let mut settings = g.settings.clone();
            settings.show_thinking &= !is_older_than_verified(g.cli_version.as_deref());
            let args = build_args(&ClaudeSpawn {
                session,
                settings: &settings,
                append_system_prompt: g.system_prompt.as_deref(),
                add_dirs: &g.add_dirs,
                agents: g.agents.as_deref(),
                memory_dir: g.memory_dir.as_deref(),
            })
            .map_err(SpawnError::Invalid)?;
            g.spawning = true;
            if g.state != AgentSessionState::Reconnecting {
                g.state = AgentSessionState::Starting;
            }
            (
                program,
                args,
                used_resume,
                g.cli_dir.clone(),
                g.settings.memory == AgentMemory::Off,
            )
        };

        let mut env = env::current(cli_dir.as_deref());
        if memory_off {
            env = env::with_auto_memory_off(env);
        }
        let display = redact_prompt(&args);
        self.launch(program, args, display, env, used_resume)
    }

    fn launch(
        self: &Arc<Self>,
        program: PathBuf,
        args: Vec<String>,
        display: Vec<String>,
        env: Vec<(String, String)>,
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
            g.stderr.clear();
            g.pid = None;
            g.mapper = ClaudeStreamMapper::new();
            g.last_activity = Instant::now();
            gen
        };
        let prepared = Prepared {
            program: program.clone(),
            args,
            cwd: self.cwd.clone(),
            env,
            stdin_pipe: true,
            inherit_env: false,
        };
        log::info!(
            target: "agent",
            "agent: spawn {} {} (cwd: {}, resume: {used_resume})",
            program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            display.join(" "),
            self.project_path.as_deref().unwrap_or("."),
        );
        let emit = self.make_emit(gen);
        let res = self
            .procs
            .spawn(&self.label, &self.root, "agent", &prepared, emit);
        let mut g = self.inner.lock();
        match res {
            Ok(id) => {
                // an exec failure already cleared `live_gen` through `on_spawn_error`
                if g.live_gen == Some(gen) {
                    self.proc_cell.store(id, Ordering::SeqCst);
                    g.ready = true;
                    g.spawning = false;
                    self.flush_queue(&mut g);
                } else {
                    g.spawning = false;
                }
                Ok(())
            }
            Err(e) => {
                g.live_gen = None;
                g.spawning = false;
                self.live.store(false, Ordering::SeqCst);
                if e.starts_with("EBUSY") {
                    Err(SpawnError::Busy)
                } else {
                    Err(SpawnError::Invalid(e))
                }
            }
        }
    }

    fn make_emit(self: &Arc<Self>, gen: u64) -> Emit {
        let weak = Arc::downgrade(self);
        let lines = Mutex::new(LineBuf::default());
        Arc::new(move |ev| {
            let Some(s) = weak.upgrade() else {
                return false;
            };
            match ev {
                ProcEvent::Spawn { pid } => s.on_spawn(gen, pid),
                ProcEvent::Stdout { data_base64 } => {
                    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64)
                    else {
                        return true;
                    };
                    let items = lines.lock().push(&bytes);
                    for item in items {
                        s.on_item(gen, item);
                    }
                }
                ProcEvent::Stderr { data_base64 } => {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64)
                    {
                        s.on_stderr(gen, &bytes);
                    }
                }
                ProcEvent::Exit { code, signal } => {
                    if let Some(rest) = lines.lock().rest() {
                        s.on_item(gen, LineItem::Line(rest));
                    }
                    s.on_exit(gen, code, signal);
                }
                ProcEvent::Error { code, message } => s.on_spawn_error(gen, &code, &message),
            }
            true
        })
    }

    // ------------------------------------------------------------ process events

    fn on_spawn(&self, gen: u64, pid: u32) {
        let mut g = self.inner.lock();
        if g.live_gen == Some(gen) {
            g.pid = Some(pid);
            log::info!(target: "agent", "agent: started pid {pid}");
        }
    }

    fn on_stderr(&self, gen: u64, bytes: &[u8]) {
        let mut g = self.inner.lock();
        if g.live_gen == Some(gen) && g.stderr.len() < STDERR_KEEP {
            let room = STDERR_KEEP - g.stderr.len();
            g.stderr.extend_from_slice(&bytes[..bytes.len().min(room)]);
        }
    }

    fn on_spawn_error(&self, gen: u64, code: &str, message: &str) {
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
        self.proc_cell.store(0, Ordering::SeqCst);
        g.state = AgentSessionState::Error;
        log::warn!(target: "agent", "agent: could not start the program ({code})");
        let (kind, retryable) = match code {
            "ENOENT" => (AgentErrorKind::BinaryNotFound, false),
            _ => (AgentErrorKind::SpawnFailed, true),
        };
        self.log.push(AgentEvent::Error {
            kind,
            message: message.to_string(),
            retryable,
        });
    }

    fn on_item(self: &Arc<Self>, gen: u64, item: LineItem) {
        match item {
            LineItem::Line(l) => self.on_line(gen, &l),
            LineItem::TooLong => {
                let g = self.inner.lock();
                if g.live_gen == Some(gen) {
                    self.log.push(AgentEvent::Error {
                        kind: AgentErrorKind::Protocol,
                        message: "claude sent a line over the size limit".into(),
                        retryable: false,
                    });
                }
            }
        }
    }

    fn on_line(self: &Arc<Self>, gen: u64, line: &str) {
        let mut started: Option<ChatSessionInfo> = None;
        // snapshots to take and the turn to finish happen after the lock is released (file IO)
        let mut captures: Vec<(String, Value, Option<String>)> = Vec::new();
        let mut closed: Option<ClosedTurn> = None;
        {
            let mut g = self.inner.lock();
            if g.live_gen != Some(gen) {
                return;
            }
            g.last_activity = Instant::now();
            if line.contains("\"control_response\"") {
                self.on_control_response(&mut g, line);
            }
            let out = g.mapper.map_line(line);
            if let Some(id) = out.unsupported_control_request {
                // never leave the CLI waiting
                log::info!(target: "agent", "agent: answered an unsupported control request with an error");
                self.write(encode_control_error(&id, "unsupported"));
            }
            for signal in &out.tasks {
                g.subs.on_task(signal);
            }
            for mut ev in out.events {
                match &ev {
                    AgentEvent::ToolCallStarted {
                        tool_call_id,
                        tool,
                        parent_tool_call_id,
                        ..
                    } => {
                        g.tool_names.insert(tool_call_id.clone(), tool.clone());
                        g.subs
                            .on_started(tool_call_id, tool, parent_tool_call_id.as_deref());
                    }
                    AgentEvent::ToolCallInput {
                        tool_call_id,
                        input,
                    } => {
                        g.subs.on_input(tool_call_id, input);
                        if let Some(tool) = g.tool_names.get(tool_call_id) {
                            let by = g.subs.author_of(Some(tool_call_id));
                            captures.push((tool.clone(), input.clone(), by));
                        }
                    }
                    AgentEvent::ToolCallFinished { tool_call_id, .. } => {
                        g.subs.on_finished(tool_call_id);
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
                    }
                    AgentEvent::TurnFinished { reason, .. } => {
                        // A sub-agent still working after a normal end (a background task, woken
                        // later) keeps the card open for its late edits; any other end closes it.
                        let keep_open = *reason == TurnFinishReason::Completed && g.subs.busy();
                        g.changes_deferred = keep_open;
                        if !keep_open {
                            g.tool_names.clear();
                            g.subs.clear();
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
                    *by = g.subs.author_of(tool_call_id.as_deref());
                }
                self.apply(&mut g, ev, &mut started);
            }
        }
        for (tool, input, by) in captures {
            self.changes.capture_by(
                &self.chat_id,
                &self.root,
                &self.cwd,
                &tool,
                &input,
                by.as_deref(),
            );
        }
        if let Some(turn) = closed {
            if let Some(summary) = self.changes.finish(turn) {
                self.log.push(AgentEvent::TurnChanges(summary));
            }
        }
        if let Some(info) = started {
            self.ports.chats().session_started(&self.root, &info);
        }
    }

    /// Fold one mapped event into the state machine, then publish it.
    fn apply(&self, g: &mut Inner, ev: AgentEvent, started: &mut Option<ChatSessionInfo>) {
        match &ev {
            AgentEvent::SessionStarted {
                session_id,
                model,
                cli_version,
                ..
            } => {
                g.init_seen = true;
                g.resume_next = true;
                if !session_id.is_empty() {
                    g.session_id = session_id.clone();
                }
                if cli_version.is_some() {
                    g.cli_version = cli_version.clone();
                }
                self.mark_running(g);
                *started = Some(ChatSessionInfo {
                    chat_id: self.chat_id.clone(),
                    session_id: g.session_id.clone(),
                    cli_version: g.cli_version.clone(),
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
                input,
                suggestions,
                ..
            } => {
                g.pending.insert(
                    request_id.clone(),
                    PendingPerm {
                        input: input.clone(),
                        suggestions: suggestions.clone(),
                    },
                );
                if g.state != AgentSessionState::Cancelling {
                    g.state = AgentSessionState::AwaitingPermission;
                }
            }
            AgentEvent::PermissionResolved { request_id, .. } => {
                g.pending.remove(request_id);
                if g.pending.is_empty() && g.state == AgentSessionState::AwaitingPermission {
                    g.state = AgentSessionState::Running;
                }
            }
            AgentEvent::TurnFinished { .. } => {
                g.turn_active = false;
                g.inflight.clear();
                g.respawns = 0;
                g.cancel_token += 1;
                g.state = AgentSessionState::Idle;
                self.log.push(ev);
                if g.restart_after_turn {
                    g.restart_after_turn = false;
                    g.closing = Some(Closing::Restart);
                    self.terminate(g);
                } else {
                    self.flush_queue(g);
                }
                return;
            }
            AgentEvent::Error {
                kind: AgentErrorKind::Auth,
                ..
            } => g.state = AgentSessionState::Error,
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

    /// The CLI's answers to our own control requests. Only `set_permission_mode` matters.
    fn on_control_response(&self, g: &mut Inner, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let resp = v.get("response");
        let id = resp
            .and_then(|r| r.get("request_id"))
            .and_then(Value::as_str);
        let ok = resp.and_then(|r| r.get("subtype")).and_then(Value::as_str) == Some("success");
        if id.is_some() && g.model_request.as_ref().map(|(r, _)| r.as_str()) == id {
            let (_, requested) = g.model_request.take().unwrap();
            if ok {
                log::info!(target: "agent", "agent: model changed in the running process");
            } else if resp
                .and_then(|r| r.get("error_code"))
                .and_then(Value::as_str)
                == Some("restricted_by_org")
            {
                // The CLI kept (or fell back to) another model: never pass the refused one again.
                let using = resp
                    .and_then(|r| r.get("model"))
                    .and_then(Value::as_str)
                    .map(String::from);
                log::info!(target: "agent", "agent: model refused by the organization policy");
                g.settings.model = using.clone();
                self.log.push(AgentEvent::ModelRefused { requested, using });
            } else {
                // The model change keeps the new setting for the next spawn (spec 6.1).
                log::info!(target: "agent", "agent: set_model refused, restarting with --resume");
                self.restart_when_idle(g);
            }
            return;
        }
        let Some((want, mode)) = g.mode_request.clone() else {
            return;
        };
        if id != Some(want.as_str()) {
            return;
        }
        g.mode_request = None;
        g.settings.permission_mode = mode;
        if ok {
            log::info!(target: "agent", "agent: permission mode changed in the running process");
            return;
        }
        // The CLI refused: restart with --resume and the new --permission-mode (spec 6.1).
        log::info!(target: "agent", "agent: set_permission_mode refused, restarting with --resume");
        self.restart_when_idle(g);
    }

    /// Restart with `--resume` now, or once the running turn has finished.
    fn restart_when_idle(&self, g: &mut Inner) {
        if g.turn_active {
            g.restart_after_turn = true;
        } else {
            g.closing = Some(Closing::Restart);
            self.terminate(g);
        }
    }

    fn on_exit(self: &Arc<Self>, gen: u64, code: Option<i32>, signal: Option<String>) {
        let mut respawn: Option<(Vec<Outgoing>, Option<String>)> = None;
        let mut closed: Option<ClosedTurn> = None;
        {
            let mut g = self.inner.lock();
            if g.live_gen != Some(gen) {
                return;
            }
            // a card kept open for a sub-agent ends with the process: nothing more can arrive
            if std::mem::take(&mut g.changes_deferred) {
                g.subs.clear();
                g.tool_names.clear();
                closed = self.changes.close_turn(&self.chat_id);
            }
            g.live_gen = None;
            g.ready = false;
            g.pid = None;
            self.live.store(false, Ordering::SeqCst);
            self.proc_cell.store(0, Ordering::SeqCst);
            let closing = g.closing.take();
            let mid_turn = g.turn_active || !g.pending.is_empty();
            let init_seen = g.init_seen;
            let stderr = String::from_utf8_lossy(&g.stderr).to_ascii_lowercase();
            g.mode_request = None;
            g.model_request = None;
            g.restart_after_turn = false;
            self.drop_pending(&mut g);
            g.mapper = ClaudeStreamMapper::new();
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
                    // a message may already be waiting
                    if !g.queue.is_empty() {
                        respawn = Some((Vec::new(), None));
                    }
                }
                None => {
                    let resume_missing = !init_seen
                        && g.used_resume
                        && !g.fallback_used
                        && (stderr.contains("no conversation found") || !clean);
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
                                message:
                                    "claude exited while idle; it restarts on the next message"
                                        .into(),
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
                                message: "Connection to claude lost, resuming".into(),
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
                                    errors: vec!["claude exited during the turn".into()],
                                });
                            }
                            respawn = Some((replay, None));
                        } else {
                            g.state = AgentSessionState::Error;
                            g.queue.clear();
                            self.log.push(AgentEvent::Error {
                                kind: AgentErrorKind::ProcessExited,
                                message: "claude keeps exiting; send a message to try again".into(),
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
        if let Some(summary) = closed.and_then(|turn| self.changes.finish(turn)) {
            self.log.push(AgentEvent::TurnChanges(summary));
        }
        if let Some((replay, replaced_from)) = respawn {
            let me = Arc::clone(self);
            std::thread::Builder::new()
                .name("agent-respawn".into())
                .spawn(move || me.respawn(replay, replaced_from))
                .expect("spawn respawn thread");
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
                self.log.push(e.to_event());
            }
        }
    }

    fn drop_pending(&self, g: &mut Inner) {
        let ids: Vec<String> = g.pending.drain().map(|(k, _)| k).collect();
        for id in ids {
            g.mapper.permission_answered(&id);
            self.log.push(AgentEvent::PermissionResolved {
                request_id: id,
                resolution: PermissionResolution::Cancelled,
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

    // ----------------------------------------------------------------- stdin

    fn write(&self, line: String) {
        let _ = self.write_tx.send(line);
    }

    /// Write the next queued user message when the CLI is ready and no turn is running.
    fn flush_queue(&self, g: &mut Inner) {
        if !g.ready || g.turn_active || g.terminal {
            return;
        }
        let Some(out) = g.queue.pop_front() else {
            if matches!(
                g.state,
                AgentSessionState::Starting | AgentSessionState::Reconnecting
            ) {
                g.state = AgentSessionState::Idle;
            }
            return;
        };
        g.inflight.push(out.clone());
        let sent = match g.seed.take() {
            Some(seed) => format!("{seed}\n\n{}", out.text),
            None => out.text,
        };
        g.turn_active = true;
        g.last_activity = Instant::now();
        if g.state == AgentSessionState::Idle || g.state == AgentSessionState::Reconnecting {
            g.state = AgentSessionState::Running;
        }
        self.write(encode_user_message(&sent, &out.images));
    }

    // -------------------------------------------------------------- commands

    /// Queue the user's message; it is written now when idle, after the running turn
    /// otherwise, and the process is started first when there is none.
    pub(crate) fn send(self: &Arc<Self>, out: Outgoing) -> Result<(), SpawnError> {
        let need_process = {
            let mut g = self.inner.lock();
            if g.terminal {
                return Err(SpawnError::Ended);
            }
            g.respawns = 0;
            g.queue.push_back(out);
            if g.live_gen.is_none() && !g.spawning {
                true
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
                self.log.push(e.to_event());
            }
        }
        Ok(())
    }

    pub(crate) fn cancel(self: &Arc<Self>) {
        let mut g = self.inner.lock();
        g.queue.clear();
        if g.live_gen.is_none() {
            g.turn_active = false;
            return;
        }
        if !g.turn_active && g.pending.is_empty() {
            return;
        }
        g.counter += 1;
        let id = format!("req_int_{}", g.counter);
        g.state = AgentSessionState::Cancelling;
        self.write(encode_interrupt(&id));
        let (token, gen) = (g.cancel_token, g.live_gen);
        drop(g);
        let me = Arc::clone(self);
        let grace = self.timing.cancel_grace;
        std::thread::Builder::new()
            .name("agent-cancel".into())
            .spawn(move || {
                std::thread::sleep(grace);
                let mut g = me.inner.lock();
                if g.live_gen == gen && g.cancel_token == token && g.turn_active {
                    log::warn!(target: "agent", "agent: no turn-finished after the interrupt, killing the process");
                    g.closing = Some(Closing::Killed);
                    me.signal(&g, Sig::Kill);
                }
            })
            .expect("spawn cancel watchdog");
    }

    pub(crate) fn permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
        persist: Option<PermissionPersist>,
        message: Option<String>,
    ) -> Result<(), String> {
        let mut g = self.inner.lock();
        if g.live_gen.is_none() {
            return Err("this chat has no running process".into());
        }
        let Some(p) = g.pending.remove(request_id) else {
            return Err("unknown or already resolved permission request".into());
        };
        let (line, resolution) = match decision {
            PermissionDecision::Allow => (
                encode_permission_allow(
                    request_id,
                    &p.input,
                    &updated_permissions(&p.suggestions, persist),
                ),
                PermissionResolution::Allowed,
            ),
            PermissionDecision::Deny => (
                encode_permission_deny(
                    request_id,
                    message
                        .as_deref()
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .unwrap_or(DENY_MESSAGE),
                ),
                PermissionResolution::Denied,
            ),
        };
        g.mapper.permission_answered(request_id);
        g.last_activity = Instant::now();
        self.write(line);
        self.log.push(AgentEvent::PermissionResolved {
            request_id: request_id.to_string(),
            resolution,
        });
        if g.pending.is_empty() && g.state == AgentSessionState::AwaitingPermission {
            g.state = AgentSessionState::Running;
        }
        Ok(())
    }

    pub(crate) fn set_permission_mode(&self, mode: AgentPermissionMode) {
        let mut g = self.inner.lock();
        if g.live_gen.is_none() || !g.ready {
            // takes effect at the next spawn
            g.settings.permission_mode = mode;
            return;
        }
        g.counter += 1;
        let id = format!("req_mode_{}", g.counter);
        g.mode_request = Some((id.clone(), mode));
        self.write(encode_set_permission_mode(&id, mode));
    }

    /// Live model switch: a `set_model` control request. A changed effort is a spawn flag, so it
    /// (or a refused or impossible request) restarts with `--resume` at the next idle moment.
    pub(crate) fn set_model(&self, model: Option<String>, effort: Option<Effort>) {
        let mut g = self.inner.lock();
        let model = model.filter(|m| !m.is_empty());
        let effort_changed = g.settings.effort != effort;
        let model_changed = g.settings.model != model;
        g.settings.model = model.clone();
        g.settings.effort = effort;
        if g.live_gen.is_none() || !g.ready {
            return; // takes effect at the next spawn
        }
        if effort_changed {
            self.restart_when_idle(&mut g);
        } else if model_changed {
            g.counter += 1;
            let id = format!("req_model_{}", g.counter);
            g.model_request = Some((id.clone(), model.clone()));
            self.write(encode_set_model(&id, model.as_deref()));
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
        let mut g = self.inner.lock();
        if g.terminal {
            return;
        }
        g.terminal = true;
        g.queue.clear();
        if let Some(gen) = g.live_gen {
            g.closing = Some(Closing::Closed);
            let id = self.proc_cell.load(Ordering::SeqCst);
            if id != 0 {
                let _ = self.procs.close_stdin(&self.label, id);
            }
            drop(g);
            let me = Arc::clone(self);
            let grace = self.timing.close_grace;
            std::thread::Builder::new()
                .name("agent-close".into())
                .spawn(move || {
                    std::thread::sleep(grace);
                    let g = me.inner.lock();
                    if g.live_gen == Some(gen) {
                        me.terminate(&g);
                    }
                })
                .expect("spawn close watchdog");
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
            self.signal(&g, Sig::Kill);
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
            && g.pending.is_empty()
            && g.queue.is_empty()
            && g.last_activity.elapsed() >= self.timing.idle_after
        {
            log::info!(target: "agent", "agent: ending an idle process");
            g.closing = Some(Closing::Idle);
            self.terminate(&g);
        }
    }

    fn signal(&self, g: &Inner, sig: Sig) {
        let id = self.proc_cell.load(Ordering::SeqCst);
        if g.live_gen.is_some() && id != 0 {
            let _ = self.procs.kill(&self.label, id, sig, true);
        }
    }

    /// SIGTERM to the group, SIGKILL after the escalation delay when it is still there.
    fn terminate(&self, g: &Inner) {
        self.signal(g, Sig::Term);
        let Some(gen) = g.live_gen else {
            return;
        };
        let me = self.me.clone();
        let wait = self.timing.term_to_kill;
        std::thread::Builder::new()
            .name("agent-kill".into())
            .spawn(move || {
                std::thread::sleep(wait);
                if let Some(s) = me.upgrade() {
                    let g = s.inner.lock();
                    if g.live_gen == Some(gen) {
                        s.signal(&g, Sig::Kill);
                    }
                }
            })
            .expect("spawn kill escalation");
    }

    pub(crate) fn snapshot(&self, after_seq: u64) -> (AgentSessionState, Vec<AgentEventEnvelope>) {
        let state = self.inner.lock().state;
        (state, self.log.snapshot(after_seq))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_buffer_splits_across_chunks_and_caps() {
        let mut lb = LineBuf::default();
        let lines = |items: Vec<LineItem>| -> Vec<String> {
            items
                .into_iter()
                .filter_map(|i| match i {
                    LineItem::Line(l) => Some(l),
                    LineItem::TooLong => None,
                })
                .collect()
        };
        assert!(lines(lb.push(b"{\"a\":")).is_empty());
        assert_eq!(
            lines(lb.push(b"1}\n{\"b\":2}\n{\"c\"")),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
        assert_eq!(lb.rest().as_deref(), Some("{\"c\""));
        assert_eq!(lines(lb.push(b"\n\n  \n")), Vec::<String>::new());
        // multibyte split across chunks stays intact
        let s = "é\n".as_bytes();
        assert!(lines(lb.push(&s[..1])).is_empty());
        assert_eq!(lines(lb.push(&s[1..])), vec!["é"]);
    }

    #[test]
    fn system_prompt_is_redacted_in_logs_and_dialogs() {
        let args: Vec<String> = [
            "-p",
            "--append-system-prompt",
            "secret note text",
            "--model",
            "x",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = redact_prompt(&args);
        assert_eq!(r[2], "<16 bytes>");
        assert!(!r.join(" ").contains("secret"));
        assert_eq!(r[4], "x");
    }

    /// The memory folder is a vault path: it stays out of the spawn log like the prompt.
    #[test]
    fn the_settings_value_is_redacted_in_logs() {
        let json = r#"{"autoMemoryDirectory":"/Users/me/Vault/.writer/memory"}"#;
        let args: Vec<String> = ["-p", "--settings", json, "--model", "x"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let r = redact_prompt(&args);
        assert_eq!(r[2], format!("<{} bytes>", json.len()));
        assert!(!r.join(" ").contains("/Users"));
        assert_eq!(r[4], "x");
    }
}
