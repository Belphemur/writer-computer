//! The session registry (chat id -> [`Session`]), the per-chat event log and the facade the Tauri
//! commands call. Spec section 8 (process lifecycle) and 11.
//!
//! - one process per chat tab, at most `MAX_LIVE_PER_WINDOW` live per window;
//! - events are numbered per chat from 1 (`seq`), kept in a ring of the last 2,000 for
//!   `agent_snapshot`, and emitted by one pump thread per chat; consecutive `text-delta`s of one
//!   block that are still waiting to be emitted are merged, nothing else is ever dropped or
//!   reordered (spec 3.5);
//! - sessions die with their window, vault, trust and the app (`kill_window`, `kill_root`,
//!   `kill_all`) and after 30 idle minutes (resumed on the next message).

use super::binary;
use super::changes::ChangeStore;
use super::events::*;
use super::ports::{AgentPorts, InjectAgentsMd, SpawnContext};
use super::runner::{LaunchConfig, Session, SessionInit, SpawnError};
use super::subagents;
use crate::plugin_consent::ConsentStore;
use crate::plugin_proc::{Consent, ProcManager};
use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

pub const RING_CAP: usize = 2000;

/// Emits one envelope to the window that owns the chat.
pub type Sink = Arc<dyn Fn(AgentEventEnvelope) + Send + Sync>;

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Interrupt without a `turn-finished` for this long: kill the group.
    pub cancel_grace: Duration,
    /// Graceful close: stdin ends, then the group is signalled after this.
    pub close_grace: Duration,
    /// SIGTERM, then SIGKILL after this.
    pub term_to_kill: Duration,
    pub idle_after: Duration,
    pub reaper_every: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            cancel_grace: Duration::from_secs(5),
            close_grace: Duration::from_secs(3),
            term_to_kill: Duration::from_secs(3),
            idle_after: Duration::from_secs(30 * 60),
            reaper_every: Duration::from_secs(30),
        }
    }
}

// ------------------------------------------------------------------------------ event log

struct LogInner {
    next_seq: u64,
    outbox: VecDeque<AgentEventEnvelope>,
    ring: VecDeque<AgentEventEnvelope>,
    closed: bool,
}

pub struct EventLog {
    chat_id: String,
    sink: Sink,
    inner: Mutex<LogInner>,
    wake: Condvar,
}

impl EventLog {
    pub fn new(chat_id: String, sink: Sink) -> Arc<EventLog> {
        let log = Arc::new(EventLog {
            chat_id,
            sink,
            inner: Mutex::new(LogInner {
                next_seq: 1,
                outbox: VecDeque::new(),
                ring: VecDeque::new(),
                closed: false,
            }),
            wake: Condvar::new(),
        });
        let pump = Arc::clone(&log);
        std::thread::Builder::new()
            .name("agent-events".into())
            .spawn(move || pump.pump())
            .expect("spawn event pump");
        log
    }

    pub fn push(&self, event: AgentEvent) {
        let mut g = self.inner.lock();
        if g.closed {
            return;
        }
        if let (
            AgentEvent::TextDelta {
                message_id,
                block_index,
                text,
            },
            Some(AgentEventEnvelope {
                event:
                    AgentEvent::TextDelta {
                        message_id: last_message,
                        block_index: last_block,
                        text: last_text,
                    },
                ..
            }),
        ) = (&event, g.outbox.back_mut())
        {
            if message_id == last_message && block_index == last_block {
                last_text.push_str(text);
                return;
            }
        }
        let seq = g.next_seq;
        g.next_seq += 1;
        g.outbox.push_back(AgentEventEnvelope {
            chat_id: self.chat_id.clone(),
            seq,
            event,
        });
        self.wake.notify_one();
    }

    /// No more events after this; the pump delivers what is queued and ends.
    pub fn close(&self) {
        let mut g = self.inner.lock();
        g.closed = true;
        self.wake.notify_all();
    }

    pub fn snapshot(&self, after_seq: u64) -> Vec<AgentEventEnvelope> {
        let g = self.inner.lock();
        g.ring
            .iter()
            .chain(g.outbox.iter())
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect()
    }

    fn pump(&self) {
        loop {
            let batch: Vec<AgentEventEnvelope> = {
                let mut g = self.inner.lock();
                while g.outbox.is_empty() && !g.closed {
                    self.wake.wait(&mut g);
                }
                if g.outbox.is_empty() {
                    return;
                }
                let batch: Vec<_> = g.outbox.drain(..).collect();
                for e in &batch {
                    if g.ring.len() == RING_CAP {
                        g.ring.pop_front();
                    }
                    g.ring.push_back(e.clone());
                }
                batch
            };
            for e in batch {
                (self.sink)(e);
            }
        }
    }
}

// --------------------------------------------------------------------------- registry

pub(crate) struct Shared {
    pub procs: Arc<ProcManager>,
    pub ports: Arc<AgentPorts>,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Serialises "count the window's live processes, then take a slot".
    pub gate: Mutex<()>,
    pub timing: Timing,
    /// In-memory pre-turn snapshots behind the "Changes" card (`changes.rs`).
    pub changes: Arc<ChangeStore>,
}

impl Shared {
    pub fn live_in_window(&self, label: &str) -> usize {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().values().cloned().collect();
        sessions
            .iter()
            .filter(|s| s.label == label && s.is_live())
            .count()
    }

    pub fn remove_if_same(&self, session: &Session) {
        let mut map = self.sessions.lock();
        if map
            .get(&session.chat_id)
            .is_some_and(|s| std::ptr::eq(Arc::as_ptr(s), session))
        {
            map.remove(&session.chat_id);
        }
    }

    fn all(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().values().cloned().collect()
    }
}

/// Managed Tauri state of the agent pane.
pub struct AgentSessions {
    shared: Arc<Shared>,
}

impl Default for AgentSessions {
    fn default() -> Self {
        Self::with_timing(Timing::default())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartedIds {
    pub chat_id: String,
    pub session_id: String,
}

/// A rejected call (bad input), as opposed to a spawn failure, which is an `error` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected(pub String);

pub struct StartParams {
    /// Tauri window label, the owner of the chat.
    pub label: String,
    /// Canonical, trusted vault root.
    pub root: PathBuf,
    pub request: StartSessionRequest,
    pub inject_agents_md: InjectAgentsMd,
    pub store: ConsentStore,
    /// Trust and vault are unchanged (asked after the dialog and before respawns).
    pub still_ok: Arc<dyn Fn() -> bool + Send + Sync>,
    pub sink: Sink,
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

impl AgentSessions {
    pub fn with_timing(timing: Timing) -> Self {
        let shared = Arc::new(Shared {
            procs: Arc::new(ProcManager::default()),
            ports: Arc::new(AgentPorts::default()),
            sessions: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
            timing,
            changes: Arc::new(ChangeStore::default()),
        });
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("agent-reaper".into())
            .spawn(move || loop {
                let every = match weak.upgrade() {
                    Some(s) => s.timing.reaper_every,
                    None => return,
                };
                std::thread::sleep(every);
                let Some(s) = weak.upgrade() else { return };
                for session in s.all() {
                    session.reap_if_idle();
                }
            })
            .expect("spawn idle reaper");
        Self { shared }
    }

    pub fn changes(&self) -> Arc<ChangeStore> {
        Arc::clone(&self.shared.changes)
    }

    /// Where lane 3 and lane 4 install their implementations.
    pub fn ports(&self) -> &AgentPorts {
        &self.shared.ports
    }

    pub fn get(&self, label: &str, chat_id: &str) -> Result<Arc<Session>, Rejected> {
        let s = self
            .shared
            .sessions
            .lock()
            .get(chat_id)
            .cloned()
            .ok_or_else(|| Rejected("no such chat: start it first".into()))?;
        if s.label != label {
            return Err(Rejected("this chat belongs to another window".into()));
        }
        Ok(s)
    }

    /// The program of any chat of this window whose spawn the user consented to (a "Run once"
    /// counts): what a helper call for a chat without a session may reuse.
    pub fn consented_program(&self, label: &str) -> Option<PathBuf> {
        self.shared
            .all()
            .iter()
            .filter(|s| s.label == label)
            .find_map(|s| s.helper_target().map(|(program, _)| program))
    }

    /// Live agent processes of a window.
    pub fn live_count(&self, label: &str) -> usize {
        self.shared.live_in_window(label)
    }

    fn config_for(
        &self,
        p: &StartParams,
        cwd: &Path,
    ) -> Result<(LaunchConfig, Option<SpawnError>), String> {
        let req = &p.request;
        let mut settings = req.settings.clone();
        let override_path = settings.binary_path.clone();
        let info = binary::detect(override_path.as_deref());
        let project = self.shared.ports.project();
        if settings.permission_mode == AgentPermissionMode::Manual {
            if let Some(mode) =
                project.project_permission_mode(&p.root, req.project_path.as_deref())
            {
                settings.permission_mode = mode;
            }
        }
        let add_dirs = if cwd != p.root {
            vec![p.root.to_string_lossy().into_owned()]
        } else {
            Vec::new()
        };
        let writer_cli = crate::managed_skills::claude_skills_installed(&p.root);
        let system_prompt = project.append_system_prompt(&SpawnContext {
            root: &p.root,
            cwd,
            project_path: req.project_path.as_deref(),
            cli_version: info.version.as_deref(),
            inject_agents_md: p.inject_agents_md,
            requested_prompt: req.append_system_prompt.as_deref(),
            writer_cli,
            orchestrate: settings.orchestrate,
        })?;
        let agents = settings
            .orchestrate
            .then(|| subagents::agents_json(settings.subagent_model.as_deref(), writer_cli));
        let program = info.path.as_deref().map(PathBuf::from);
        let missing = (!info.found).then_some(SpawnError::NotFound);
        Ok((
            LaunchConfig {
                program,
                cli_version: info.version,
                system_prompt,
                add_dirs,
                agents,
                settings,
            },
            missing,
        ))
    }

    /// Create (or find) the chat's session and make sure its process runs. Blocking: login
    /// shell, version probe, consent dialog. Spawn-class failures are `error` events of the
    /// chat; only bad input is `Err`.
    pub fn start(&self, p: StartParams, consent: &dyn Consent) -> Result<StartedIds, Rejected> {
        let req = &p.request;
        if !is_uuid(&req.chat_id) {
            return Err(Rejected("chat id must be a uuid".into()));
        }
        if let Some(r) = &req.resume_session_id {
            if !is_uuid(r) {
                return Err(Rejected("session id must be a uuid".into()));
            }
        }
        let cwd = self
            .shared
            .ports
            .project()
            .resolve_cwd(&p.root, req.project_path.as_deref())
            .map_err(Rejected)?;
        let existing = self.shared.sessions.lock().get(&req.chat_id).cloned();
        if let Some(s) = &existing {
            if s.label != p.label {
                return Err(Rejected("this chat belongs to another window".into()));
            }
            if s.project_path != req.project_path {
                return Err(Rejected("this chat belongs to another project".into()));
            }
        }
        let existing = existing.filter(|s| !s.is_terminal());

        let (config, missing) = match self.config_for(&p, &cwd) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(target: "agent", "agent: could not prepare the project context");
                // surface it on the chat; no process starts without its instructions
                let session = self.session_for(&p, &cwd, existing, None);
                session.fail(&SpawnError::Invalid(format!(
                    "Could not prepare the project context: {e}"
                )));
                return Ok(StartedIds {
                    chat_id: req.chat_id.clone(),
                    session_id: session.session_id(),
                });
            }
        };
        let session = self.session_for(&p, &cwd, existing, Some(config));
        if let Some(err) = missing {
            session.fail(&err);
        } else if let Err(err) = session.ensure_process(Some(consent)) {
            session.fail(&err);
        }
        Ok(StartedIds {
            chat_id: req.chat_id.clone(),
            session_id: session.session_id(),
        })
    }

    fn session_for(
        &self,
        p: &StartParams,
        cwd: &Path,
        existing: Option<Arc<Session>>,
        config: Option<LaunchConfig>,
    ) -> Arc<Session> {
        if let Some(s) = existing {
            if let Some(c) = config {
                s.configure(c);
            }
            return s;
        }
        let req = &p.request;
        let config = config.unwrap_or_else(|| LaunchConfig {
            program: None,
            cli_version: None,
            system_prompt: None,
            add_dirs: Vec::new(),
            agents: None,
            settings: req.settings.clone(),
        });
        let session = Session::new(
            SessionInit {
                chat_id: req.chat_id.clone(),
                label: p.label.clone(),
                root: p.root.clone(),
                cwd: cwd.to_path_buf(),
                project_path: req.project_path.clone(),
                session_id: req
                    .resume_session_id
                    .clone()
                    .unwrap_or_else(|| req.chat_id.clone()),
                resume: req.resume_session_id.is_some(),
                shared: Arc::downgrade(&self.shared),
                store: p.store.clone(),
                still_ok: Arc::clone(&p.still_ok),
                sink: Arc::clone(&p.sink),
            },
            config,
        );
        self.shared
            .sessions
            .lock()
            .insert(req.chat_id.clone(), Arc::clone(&session));
        if let Some(project) = req.project_path.as_deref().filter(|p| !p.is_empty()) {
            self.shared
                .ports
                .project()
                .touch_last_used(&p.root, project);
        }
        session
    }

    pub fn send(
        &self,
        label: &str,
        chat_id: &str,
        text: String,
        context: &[ContextRef],
    ) -> Result<(), Rejected> {
        let s = self.get(label, chat_id)?;
        validate_context(&s.root, context).map_err(Rejected)?;
        s.send(text)
            .map_err(|e| Rejected(format!("cannot send: {e:?}")))
    }

    pub fn cancel(&self, label: &str, chat_id: &str) -> Result<(), Rejected> {
        self.get(label, chat_id)?.cancel();
        Ok(())
    }

    pub fn permission(
        &self,
        label: &str,
        chat_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        persist: Option<PermissionPersist>,
        message: Option<String>,
    ) -> Result<(), Rejected> {
        self.get(label, chat_id)?
            .permission(request_id, decision, persist, message)
            .map_err(Rejected)
    }

    pub fn set_permission_mode(
        &self,
        label: &str,
        chat_id: &str,
        mode: AgentPermissionMode,
    ) -> Result<(), Rejected> {
        self.get(label, chat_id)?.set_permission_mode(mode);
        Ok(())
    }

    pub fn set_model(
        &self,
        label: &str,
        chat_id: &str,
        model: Option<String>,
        effort: Option<Effort>,
    ) -> Result<(), Rejected> {
        if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
            if !super::claude_stream::is_safe_value(m) {
                return Err(Rejected("invalid model name".into()));
            }
        }
        self.get(label, chat_id)?.set_model(model, effort);
        Ok(())
    }

    pub fn close(&self, label: &str, chat_id: &str) -> Result<(), Rejected> {
        // a chat that never started is already closed
        if let Ok(s) = self.get(label, chat_id) {
            s.close();
        }
        Ok(())
    }

    pub fn resume(&self, label: &str, chat_id: &str, session_id: &str) -> Result<(), Rejected> {
        if !is_uuid(session_id) {
            return Err(Rejected("session id must be a uuid".into()));
        }
        self.get(label, chat_id)?.rebind(session_id.to_string());
        Ok(())
    }

    /// `(state, events after seq)`; an unknown chat is `ended` with no events.
    pub fn snapshot(
        &self,
        label: &str,
        chat_id: &str,
        after_seq: u64,
    ) -> (AgentSessionState, Vec<AgentEventEnvelope>) {
        match self.get(label, chat_id) {
            Ok(s) => s.snapshot(after_seq),
            Err(_) => (AgentSessionState::Ended, Vec::new()),
        }
    }

    fn kill_where(&self, pred: impl Fn(&Session) -> bool) {
        let victims: Vec<Arc<Session>> =
            self.shared.all().into_iter().filter(|s| pred(s)).collect();
        for s in victims {
            s.shutdown();
        }
    }

    /// The window closed or left its vault.
    pub fn kill_window(&self, label: &str) {
        self.kill_where(|s| s.label == label);
    }

    /// Trust revoked or the vault was left: everything that vault started.
    pub fn kill_root(&self, root: &Path) {
        self.kill_where(|s| s.root == root);
    }

    /// App exit.
    pub fn kill_all(&self) {
        self.kill_where(|_| true);
    }
}

// ------------------------------------------------------------------------ context refs

fn path_inside(root: &Path, p: &str) -> bool {
    let path = Path::new(p);
    if p.is_empty()
        || p.contains('\0')
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return false;
    }
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    match (full.canonicalize(), root.canonicalize()) {
        (Ok(f), Ok(r)) => f.starts_with(r),
        // not on disk (a note about to be created, a deleted one): lexical check only
        (Err(_), Ok(r)) => full.starts_with(&r) || full.starts_with(root),
        _ => false,
    }
}

/// `ContextRef` paths come from the page: every one must resolve inside the vault.
pub fn validate_context(root: &Path, refs: &[ContextRef]) -> Result<(), String> {
    for r in refs {
        let path = match r {
            ContextRef::ActiveNote { path, .. }
            | ContextRef::Selection { path, .. }
            | ContextRef::Note { path }
            | ContextRef::Folder { path }
            | ContextRef::ProjectInstructions { path } => Some(path.as_str()),
            ContextRef::ProjectSource {
                source: ProjectSource::Folder { path, .. } | ProjectSource::Note { path, .. },
            } => Some(path.as_str()),
            _ => None,
        };
        if let Some(p) = path {
            if !path_inside(root, p) {
                return Err("a context path is outside the vault".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn collect_log() -> (Arc<EventLog>, mpsc::Receiver<AgentEventEnvelope>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.lock().send(e);
        });
        (EventLog::new("c".into(), sink), rx)
    }

    /// Everything delivered until the pump has been quiet for a moment (the sink keeps the
    /// channel's sender alive, so `iter()` would never end).
    fn collect<T>(rx: &mpsc::Receiver<T>) -> Vec<T> {
        let mut out = Vec::new();
        while let Ok(e) = rx.recv_timeout(Duration::from_millis(400)) {
            out.push(e);
        }
        out
    }

    fn delta(m: &str, b: u32, t: &str) -> AgentEvent {
        AgentEvent::TextDelta {
            message_id: m.into(),
            block_index: b,
            text: t.into(),
        }
    }

    #[test]
    fn seq_is_monotonic_from_one_and_never_reordered() {
        let (log, rx) = collect_log();
        for i in 0..50 {
            log.push(AgentEvent::Text {
                message_id: "m".into(),
                block_index: 0,
                text: i.to_string(),
            });
        }
        log.close();
        let got = collect(&rx);
        assert_eq!(got.len(), 50);
        assert!(got.iter().enumerate().all(|(i, e)| e.seq == i as u64 + 1));
    }

    #[test]
    fn pending_text_deltas_of_one_block_merge() {
        // hold the pump off by taking the inner lock while pushing is not possible, so use a
        // sink that blocks the pump on the first event
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (out_tx, out_rx) = mpsc::channel();
        let gate_rx = Mutex::new(gate_rx);
        let out_tx = Mutex::new(out_tx);
        let first = std::sync::atomic::AtomicBool::new(true);
        let sink: Sink = Arc::new(move |e| {
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let _ = gate_rx.lock().recv();
            }
            let _ = out_tx.lock().send(e);
        });
        let log = EventLog::new("c".into(), sink);
        log.push(delta("m", 0, "x")); // taken by the pump, blocked in the sink
        std::thread::sleep(Duration::from_millis(100));
        log.push(delta("m", 0, "a"));
        log.push(delta("m", 0, "b"));
        log.push(delta("m", 1, "c")); // other block: no merge
        log.push(AgentEvent::Text {
            message_id: "m".into(),
            block_index: 0,
            text: "ab".into(),
        });
        log.push(delta("m", 0, "d")); // after a non-delta: no merge across it
        gate_tx.send(()).unwrap();
        log.close();
        let got = collect(&out_rx);
        let texts: Vec<String> = got
            .iter()
            .map(|e| match &e.event {
                AgentEvent::TextDelta {
                    text, block_index, ..
                } => format!("d{block_index}:{text}"),
                AgentEvent::Text { text, .. } => format!("t:{text}"),
                _ => "?".into(),
            })
            .collect();
        assert_eq!(texts, vec!["d0:x", "d0:ab", "d1:c", "t:ab", "d0:d"]);
        assert!(
            got.windows(2).all(|w| w[1].seq == w[0].seq + 1),
            "no seq gaps"
        );
    }

    #[test]
    fn ring_keeps_the_last_events_and_snapshot_filters_by_seq() {
        let (log, rx) = collect_log();
        for i in 0..(RING_CAP + 10) {
            log.push(AgentEvent::Text {
                message_id: "m".into(),
                block_index: 0,
                text: i.to_string(),
            });
        }
        log.close();
        assert_eq!(collect(&rx).len(), RING_CAP + 10);
        let all = log.snapshot(0);
        assert_eq!(all.len(), RING_CAP);
        assert_eq!(all[0].seq, 11);
        let tail = log.snapshot(RING_CAP as u64 + 5);
        assert_eq!(
            tail.iter().map(|e| e.seq).collect::<Vec<_>>(),
            (2006..=2010).collect::<Vec<u64>>()
        );
    }

    #[test]
    fn context_paths_must_stay_inside_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "x").unwrap();
        let note = |p: &str| ContextRef::Note { path: p.into() };
        assert!(validate_context(&root, &[note("a.md"), note("new/not-yet.md")]).is_ok());
        assert!(validate_context(&root, &[ContextRef::Tag { tag: "x".into() }]).is_ok());
        assert!(validate_context(&root, &[note("../a.md")]).is_err());
        assert!(validate_context(&root, &[note("/etc/passwd")]).is_err());
        let abs = root.join("a.md");
        assert!(validate_context(&root, &[note(abs.to_str().unwrap())]).is_ok());
        assert!(validate_context(
            &root,
            &[ContextRef::ProjectSource {
                source: ProjectSource::Folder {
                    path: "../x".into(),
                    raw: "../x".into()
                }
            }]
        )
        .is_err());
    }
}
