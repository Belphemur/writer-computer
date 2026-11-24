//! The `claude` CLI as a [`Transport`]: spawn (never a bypass flag, `build_args` is the only argv
//! builder), the stdin writer thread, the stdout line reader feeding `ClaudeStreamMapper`, the
//! control requests and their answers, and the kill. Everything that is the CLI's stream-json
//! protocol is here; the state machine that decides what to do with it is `Session` (`runner.rs`).
//! Spec: `SPECs/native-agent-spec.md` sections 2, 6, 8, 11, 13 and
//! `SPECs/opencode-backend-spec.md` section 5.
//!
//! Threading. `ProcManager` (shared with the plugin host, a separate instance) owns the process,
//! its process group and its pipes and calls our `Emit` closure from its reader/waiter threads.
//! The closure maps each line and pushes the result into the chat's inbound channel, so the
//! `Session` reads one ordered stream. Lines for the CLI go through one channel to one writer
//! thread so JSON lines never interleave and a slow pipe never blocks the reader.
//!
//! Never logged: user text, assistant text, tool input/output, note paths, the system prompt,
//! environment values (spec section 8).

use super::binary::is_older_than_verified;
use super::claude_stream::{
    build_args, encode_cancel_queued, encode_control_error, encode_interrupt,
    encode_permission_allow, encode_permission_deny, encode_queued_message, encode_set_model,
    encode_set_permission_mode, encode_steer_message, encode_user_message,
    parse_cancel_queued_response, ClaudeSpawn, ClaudeStreamMapper, SessionRef,
};
use super::env;
use super::events::*;
use super::transport::{
    Close, Delivery, Ended, Inbound, LaunchConfig, LiveChange, Mapped, Message, ModelChange,
    Outbound, PermissionReply, Phrases, Receipt, SpawnError, StartRequest, Transport,
    TransportInit, Unanswered,
};
use crate::features::scope::CancelToken;
use crate::plugin_proc::{Emit, Prepared, ProcEvent, ProcManager, Sig};
use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// A stdout line over this size is dropped with a content-free protocol error.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
const STDERR_KEEP: usize = 2048;

/// What the CLI's failures read like to the user.
static PHRASES: Phrases = Phrases {
    not_found: "The claude program was not found",
    exited_idle: "claude exited while idle; it restarts on the next message",
    connection_lost: "Connection to claude lost, resuming",
    ended_in_turn: "claude exited during the turn",
    keeps_exiting: "claude keeps exiting; send a message to try again",
    no_answer: "the CLI did not answer",
};

/// What the mapper and the control requests keep between lines of one process.
struct State {
    /// The generation of the process this state belongs to.
    gen: u64,
    /// `start` is between "spawn requested" and "spawn returned": an exec failure is then the
    /// start's own error (`sync_failure`), not a message.
    starting: bool,
    sync_failure: Option<SpawnError>,
    /// A start of this generation failed to exec: its process id must not be kept.
    failed_gen: Option<u64>,
    mapper: ClaudeStreamMapper,
    stderr: Vec<u8>,
    /// Numbers the control requests (`req_<kind>_<n>`).
    counter: u64,
    /// `cancel_async_message` requests waiting for their answer, by request id.
    /// (the receipt asked about, the waiter)
    cancel_waits: HashMap<String, (String, Sender<bool>)>,
    /// (request id, the model asked for)
    model_request: Option<(String, Option<String>)>,
    mode_request: Option<String>,
}

impl State {
    fn next_id(&mut self, kind: &str) -> String {
        self.counter += 1;
        format!("req_{kind}_{}", self.counter)
    }
}

pub struct StdioTransport {
    me: Weak<StdioTransport>,
    procs: Arc<ProcManager>,
    label: String,
    root: std::path::PathBuf,
    cwd: std::path::PathBuf,
    project_path: Option<String>,
    inbound: Sender<Inbound>,
    /// `ProcManager` id of the current process, 0 for none; read by the writer thread.
    proc_cell: Arc<AtomicU64>,
    write_tx: Sender<String>,
    state: Mutex<State>,
}

/// The `claude` backend's transport factory (`backend::claude`).
pub fn connect(init: TransportInit) -> Result<Arc<dyn Transport>, String> {
    let (write_tx, rx) = channel();
    let cell = Arc::new(AtomicU64::new(0));
    {
        let (p, l, c) = (
            Arc::clone(&init.procs),
            init.label.clone(),
            Arc::clone(&cell),
        );
        init.spawner
            .spawn("agent-stdin", move |token| {
                writer_thread(rx, p, l, c, token)
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(Arc::new_cyclic(|me| StdioTransport {
        me: me.clone(),
        procs: init.procs,
        label: init.label,
        root: init.root,
        cwd: init.cwd,
        project_path: init.project_path,
        inbound: init.inbound,
        proc_cell: cell,
        write_tx,
        state: Mutex::new(State {
            gen: 0,
            starting: false,
            sync_failure: None,
            failed_gen: None,
            mapper: ClaudeStreamMapper::new(),
            stderr: Vec::new(),
            counter: 0,
            cancel_waits: HashMap::new(),
            model_request: None,
            mode_request: None,
        }),
    }))
}

fn writer_thread(
    rx: Receiver<String>,
    procs: Arc<ProcManager>,
    label: String,
    cell: Arc<AtomicU64>,
    token: CancelToken,
) {
    loop {
        let line = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) if !token.is_cancelled() => continue,
            Err(_) => return,
        };
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
            // the prompt, the memory folder's path and the vault path of the MCP config stay out of
            // the log (spec section 8)
            redact = a == "--append-system-prompt" || a == "--settings" || a == "--mcp-config";
            out.push(a.clone());
        }
    }
    out
}

impl StdioTransport {
    fn write(&self, line: String) {
        let _ = self.write_tx.send(line);
    }

    /// `false` once the chat's `Session` is gone.
    fn push(&self, gen: u64, message: Message) -> bool {
        self.inbound.send(Inbound { gen, message }).is_ok()
    }

    fn make_emit(&self, gen: u64) -> Emit {
        let weak = self.me.clone();
        let lines = Mutex::new(LineBuf::default());
        Arc::new(move |ev| {
            let Some(t) = weak.upgrade() else {
                return false;
            };
            match ev {
                ProcEvent::Spawn { pid } => {
                    return t.push(gen, Message::Started { pid: Some(pid) });
                }
                ProcEvent::Stdout { data_base64 } => {
                    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64)
                    else {
                        return true;
                    };
                    let items = lines.lock().push(&bytes);
                    for item in items {
                        t.on_item(gen, item);
                    }
                }
                ProcEvent::Stderr { data_base64 } => {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64)
                    {
                        t.on_stderr(gen, &bytes);
                    }
                }
                ProcEvent::Exit { code, signal } => {
                    if let Some(rest) = lines.lock().rest() {
                        t.on_item(gen, LineItem::Line(rest));
                    }
                    t.on_exit(gen, code, signal);
                }
                ProcEvent::Error { code, message } => t.on_spawn_error(gen, &code, &message),
            }
            true
        })
    }

    fn on_stderr(&self, gen: u64, bytes: &[u8]) {
        let mut st = self.state.lock();
        if st.gen == gen && st.stderr.len() < STDERR_KEEP {
            let room = STDERR_KEEP - st.stderr.len();
            st.stderr.extend_from_slice(&bytes[..bytes.len().min(room)]);
        }
    }

    fn on_spawn_error(&self, gen: u64, code: &str, message: &str) {
        let (kind, retryable) = match code {
            "ENOENT" => (AgentErrorKind::BinaryNotFound, false),
            _ => (AgentErrorKind::SpawnFailed, true),
        };
        {
            let mut st = self.state.lock();
            if st.gen != gen {
                return;
            }
            st.failed_gen = Some(gen);
            self.proc_cell.store(0, Ordering::SeqCst);
            if st.starting {
                // `start` is still running: it fails with this
                st.sync_failure = Some(match kind {
                    AgentErrorKind::BinaryNotFound => SpawnError::NotFound,
                    _ => SpawnError::Failed {
                        kind,
                        message: message.to_string(),
                        retryable,
                    },
                });
                return;
            }
        }
        self.push(
            gen,
            Message::StartFailed {
                kind,
                message: message.to_string(),
                retryable,
            },
        );
    }

    fn on_item(&self, gen: u64, item: LineItem) {
        match item {
            LineItem::Line(l) => self.on_line(gen, &l),
            LineItem::TooLong => {
                if self.state.lock().gen == gen {
                    self.push(
                        gen,
                        Message::Mapped(Mapped {
                            events: vec![AgentEvent::Error {
                                kind: AgentErrorKind::Protocol,
                                message: "claude sent a line over the size limit".into(),
                                retryable: false,
                            }],
                            ..Mapped::default()
                        }),
                    );
                }
            }
        }
    }

    fn on_line(&self, gen: u64, line: &str) {
        let mut events = Vec::new();
        let out = {
            let mut st = self.state.lock();
            if st.gen != gen {
                return;
            }
            if line.contains("\"control_response\"") {
                self.on_control_response(&mut st, gen, line, &mut events);
            }
            st.mapper.map_line(line)
        };
        if let Some(id) = out.unsupported_control_request {
            // never leave the CLI waiting
            log::info!(target: "agent", "agent: answered an unsupported control request with an error");
            self.write(encode_control_error(&id, "unsupported"));
        }
        events.extend(out.events);
        self.push(
            gen,
            Message::Mapped(Mapped {
                events,
                tasks: out.tasks,
                taken: out.user_echo,
                accepted: out.command_queued,
            }),
        );
    }

    /// The CLI's answers to our own control requests: the cancel of a waiting line, a model and a
    /// permission-mode change.
    fn on_control_response(
        &self,
        st: &mut State,
        gen: u64,
        line: &str,
        events: &mut Vec<AgentEvent>,
    ) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some((request, cancelled)) = parse_cancel_queued_response(line) {
            if let Some((receipt, wait)) = st.cancel_waits.remove(&request) {
                if cancelled {
                    // before the waiter wakes and before the lines that follow are read
                    self.push(gen, Message::Unqueued { receipt });
                }
                let _ = wait.send(cancelled);
                return;
            }
        }
        let resp = v.get("response");
        let id = resp
            .and_then(|r| r.get("request_id"))
            .and_then(Value::as_str);
        let ok = resp.and_then(|r| r.get("subtype")).and_then(Value::as_str) == Some("success");
        if id.is_some() && st.model_request.as_ref().map(|(r, _)| r.as_str()) == id {
            let (_, requested) = st.model_request.take().unwrap();
            if ok {
                log::info!(target: "agent", "agent: model changed in the running process");
            } else if resp
                .and_then(|r| r.get("error_code"))
                .and_then(Value::as_str)
                == Some("restricted_by_org")
            {
                // The CLI kept (or fell back to) another model: the `Session` never passes the
                // refused one again.
                let using = resp
                    .and_then(|r| r.get("model"))
                    .and_then(Value::as_str)
                    .map(String::from);
                log::info!(target: "agent", "agent: model refused by the organization policy");
                events.push(AgentEvent::ModelRefused { requested, using });
            } else {
                // The model change keeps the new setting for the next spawn (spec 6.1).
                log::info!(target: "agent", "agent: set_model refused, restarting with --resume");
                self.push(gen, Message::Refused);
            }
            return;
        }
        let Some(want) = st.mode_request.clone() else {
            return;
        };
        if id != Some(want.as_str()) {
            return;
        }
        st.mode_request = None;
        if ok {
            log::info!(target: "agent", "agent: permission mode changed in the running process");
            return;
        }
        // The CLI refused: restart with --resume and the new --permission-mode (spec 6.1).
        log::info!(target: "agent", "agent: set_permission_mode refused, restarting with --resume");
        self.push(gen, Message::Refused);
    }

    fn on_exit(&self, gen: u64, code: Option<i32>, signal: Option<String>) {
        let session_unknown = {
            let mut st = self.state.lock();
            if st.gen != gen {
                return;
            }
            let stderr = String::from_utf8_lossy(&st.stderr).to_ascii_lowercase();
            st.mapper = ClaudeStreamMapper::new();
            // a waiter learns there is no answer
            st.cancel_waits.clear();
            st.model_request = None;
            st.mode_request = None;
            stderr.contains("no conversation found")
        };
        self.proc_cell.store(0, Ordering::SeqCst);
        self.push(
            gen,
            Message::Ended(Ended {
                code,
                signal,
                session_unknown,
            }),
        );
    }
}

impl Transport for StdioTransport {
    fn phrases(&self) -> &'static Phrases {
        &PHRASES
    }

    fn start(&self, req: &StartRequest<'_>) -> Result<(), SpawnError> {
        let launch: &LaunchConfig = req.launch;
        let program = launch.program.clone().ok_or(SpawnError::NotFound)?;
        let session = if req.resume {
            SessionRef::Resume(req.session_id.to_string())
        } else {
            SessionRef::New(req.session_id.to_string())
        };
        // `--thinking-display` is newer than the verified CLI: an older one would refuse the
        // unknown option and the chat could not start, so it only gets the default.
        let mut settings = launch.settings.clone();
        settings.show_thinking &= !is_older_than_verified(launch.cli_version.as_deref());
        let args = build_args(&ClaudeSpawn {
            session,
            settings: &settings,
            append_system_prompt: launch.system_prompt.as_deref(),
            add_dirs: &launch.add_dirs,
            agents: launch.agents.as_deref(),
            memory_dir: launch.memory_dir.as_deref(),
            mcp: launch.mcp.as_ref(),
        })
        .map_err(SpawnError::Invalid)?;
        // may run the login shell: no lock is held
        let env = env::with_memory_mode(
            env::current(launch.cli_dir.as_deref()),
            launch.settings.memory,
        );
        let display = redact_prompt(&args);
        {
            let mut st = self.state.lock();
            st.gen = req.gen;
            st.failed_gen = None;
            st.starting = true;
            st.sync_failure = None;
            st.mapper = ClaudeStreamMapper::new();
            st.stderr.clear();
            st.cancel_waits.clear();
            st.model_request = None;
            st.mode_request = None;
        }
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
            "agent: spawn {} {} (cwd: {}, resume: {})",
            program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            display.join(" "),
            self.project_path.as_deref().unwrap_or("."),
            req.resume,
        );
        let emit = self.make_emit(req.gen);
        let spawned = self
            .procs
            .spawn(&self.label, &self.root, "agent", &prepared, emit);
        // the id is kept in the same critical section that ends `starting`, so an exec failure
        // is either seen here or clears the id after it
        let mut st = self.state.lock();
        st.starting = false;
        if let Some(failure) = st.sync_failure.take() {
            return Err(failure);
        }
        match spawned {
            Ok(id) => {
                if st.failed_gen != Some(req.gen) {
                    self.proc_cell.store(id, Ordering::SeqCst);
                }
                Ok(())
            }
            Err(e) if e.starts_with("EBUSY") => Err(SpawnError::Busy),
            Err(e) => Err(SpawnError::Invalid(e)),
        }
    }

    fn send(&self, msg: &Outbound<'_>) -> Receipt {
        let (line, id) = match msg.delivery {
            Delivery::Start => (encode_user_message(msg.text, msg.files), String::new()),
            Delivery::Steer { receipt } => (
                encode_steer_message(msg.text, msg.files, receipt),
                receipt.to_string(),
            ),
            Delivery::Queued { receipt } => (
                encode_queued_message(msg.text, msg.files, receipt),
                receipt.to_string(),
            ),
        };
        self.write(line);
        Receipt {
            message_id: id.clone(),
            backend_id: id,
        }
    }

    fn unqueue(&self, receipt: &str, wait: Duration) -> Result<bool, Unanswered> {
        let (request, answer) = {
            let mut st = self.state.lock();
            let request = st.next_id("cq");
            let (tx, rx) = channel();
            st.cancel_waits
                .insert(request.clone(), (receipt.to_string(), tx));
            self.write(encode_cancel_queued(&request, receipt));
            (request, rx)
        };
        match answer.recv_timeout(wait) {
            Ok(cancelled) => Ok(cancelled),
            Err(_) => {
                self.state.lock().cancel_waits.remove(&request);
                log::warn!(target: "agent", "agent: no answer to a cancel of a queued line");
                Err(Unanswered)
            }
        }
    }

    fn discard(&self, receipt: &str) {
        let request = self.state.lock().next_id("cq");
        self.write(encode_cancel_queued(&request, receipt));
    }

    fn interrupt(&self) {
        let id = self.state.lock().next_id("int");
        self.write(encode_interrupt(&id));
    }

    fn answer_permission(&self, request_id: &str, reply: PermissionReply<'_>) {
        let line = match reply {
            PermissionReply::Allow { input, updated } => {
                encode_permission_allow(request_id, input, updated)
            }
            PermissionReply::Deny { message } => encode_permission_deny(request_id, message),
        };
        self.state.lock().mapper.permission_answered(request_id);
        self.write(line);
    }

    fn answer_question(&self, request_id: &str, answers: Option<&[QuestionAnswer]>) -> bool {
        let Some(line) = self
            .state
            .lock()
            .mapper
            .encode_question_answer(request_id, answers)
        else {
            return false;
        };
        self.write(line);
        true
    }

    /// A changed effort is a spawn flag, so it (or a refused request) restarts with `--resume`.
    fn set_model(&self, change: &ModelChange) -> LiveChange {
        if change.effort_changed {
            return LiveChange::Restart;
        }
        if change.model_changed {
            let mut st = self.state.lock();
            let id = st.next_id("model");
            st.model_request = Some((id.clone(), change.model.clone()));
            self.write(encode_set_model(&id, change.model.as_deref()));
        }
        LiveChange::Applied
    }

    fn set_permission_mode(&self, mode: AgentPermissionMode) {
        let mut st = self.state.lock();
        let id = st.next_id("mode");
        st.mode_request = Some(id.clone());
        self.write(encode_set_permission_mode(&id, mode));
    }

    fn close(&self, how: Close) {
        let id = self.proc_cell.load(Ordering::SeqCst);
        if id == 0 {
            return;
        }
        match how {
            Close::Graceful => {
                let _ = self.procs.close_stdin(&self.label, id);
            }
            Close::Terminate => {
                let _ = self.procs.kill(&self.label, id, Sig::Term, true);
            }
            Close::Kill => {
                let _ = self.procs.kill(&self.label, id, Sig::Kill, true);
            }
        }
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

    /// The MCP config names the launcher and the vault: a path, so it stays out of the log too.
    #[test]
    fn the_mcp_config_value_is_redacted_in_logs() {
        let json = r#"{"mcpServers":{"writer":{"command":"/Users/me/bin/writer","args":["vault=/Users/me/Vault","mcp"]}}}"#;
        let args: Vec<String> = ["-p", "--mcp-config", json, "--model", "x"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let r = redact_prompt(&args);
        assert_eq!(r[2], format!("<{} bytes>", json.len()));
        assert!(!r.join(" ").contains("/Users"));
        assert_eq!(r[4], "x");
    }
}
