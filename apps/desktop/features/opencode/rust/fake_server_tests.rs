//! A fake OpenCode server for the tests of the server and the transport: HTTP and server-sent
//! events over `std` sockets on loopback, answering the routes Writer uses and replaying the
//! captured fixtures (`fixtures/*.sse`) on request. The fake launcher hands the server a new fake
//! per start, so a crash and a restart are real: a new port, a new password, the old streams cut.
//! Synthetic data only.

use super::client::Endpoint;
use super::events_tests::{fixture, fixtures_dir};
use super::opencode_api::SseParser;
use super::server::{ExitInfo, LaunchError, LaunchSpec, Launcher, Process};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub(super) struct Req {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Value,
    pub authorized: bool,
}

/// An answer the test scripts: `(status, body)`.
pub(super) type Handler = Box<dyn Fn(&Req) -> Option<(u16, Value)> + Send + Sync>;

pub(super) const SESSION: &str = "ses_fake0001";

#[derive(Default)]
pub(super) struct Shared {
    pub password: String,
    pub version: String,
    pub requests: Mutex<Vec<Req>>,
    subscribers: Mutex<Vec<Sender<Option<String>>>>,
    pub handler: Mutex<Option<Handler>>,
    /// Prompt ids admitted, once each (a repeated id is the same item).
    pub items: Arc<Mutex<Vec<String>>>,
    /// Prompt ids another session already holds: ids are global (spec 10.9), so posting one is a
    /// 409 (the recorded `prompt-id-conflict`).
    pub conflict_ids: Mutex<HashSet<String>>,
    /// Ids of prompts the server has taken: they cannot be cancelled any more.
    pub taken: Mutex<HashSet<String>>,
    /// Permission ids that are gone (a reject settled them): replying is a 404.
    pub gone: Mutex<HashSet<String>>,
    pub messages: Mutex<Value>,
    /// The sessions `GET /api/session/active` lists (a turn is running in each).
    pub active: Mutex<Vec<String>>,
    /// Path fragments whose answer is held for this long.
    pub delays: Mutex<Vec<(String, Duration)>>,
    pub unknown_session: AtomicBool,
    /// The inbox answers a cancel with no event (a server that is slow to say).
    pub silent_inbox: AtomicBool,
    /// The event stream answers 401 (a server that is no longer ours).
    pub reject_stream: AtomicBool,
    stop: AtomicBool,
    pub streams: Mutex<u32>,
}

impl Shared {
    fn emit(&self, payload: &str) {
        self.subscribers
            .lock()
            .retain(|tx| tx.send(Some(payload.to_string())).is_ok());
    }
}

pub(super) struct FakeServer {
    pub port: u16,
    pub shared: Arc<Shared>,
}

impl FakeServer {
    /// `items`: the prompt ids the server holds (shared by a launcher across restarts, as
    /// OpenCode keeps its inbox and transcript in its own database).
    pub fn start_with(
        password: &str,
        version: &str,
        items: Arc<Mutex<Vec<String>>>,
    ) -> Arc<FakeServer> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = Arc::new(Shared {
            password: password.to_string(),
            version: version.to_string(),
            conflict_ids: Mutex::new(HashSet::new()),
            messages: Mutex::new(json!({"data": []})),
            items,
            ..Shared::default()
        });
        let s = Arc::clone(&shared);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s.stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(conn) = conn else { continue };
                let s = Arc::clone(&s);
                std::thread::spawn(move || serve(conn, &s));
            }
        });
        Arc::new(FakeServer { port, shared })
    }

    pub fn endpoint(&self) -> Endpoint {
        Endpoint::new(
            &format!("http://127.0.0.1:{}", self.port),
            &self.shared.password,
        )
    }

    /// One event to every open stream.
    pub fn emit(&self, payload: &str) {
        self.shared.emit(payload);
    }

    /// The events of a fixture, in order, `from..` onward.
    pub fn replay(&self, name: &str) {
        self.replay_where(name, |_| true);
    }

    pub fn replay_where(&self, name: &str, keep: impl Fn(&Value) -> bool) {
        let sse = std::fs::read_to_string(fixtures_dir().join(format!("{name}.sse"))).unwrap();
        for payload in SseParser::default().push(sse.as_bytes()) {
            let v: Value = serde_json::from_str(&payload).unwrap();
            if v["type"] == "server.connected" || !keep(&v) {
                continue;
            }
            self.emit(&payload);
        }
    }

    /// The fixture's REST side `messages` list (what a resync reads), if it has one.
    pub fn serve_messages_of(&self, name: &str) {
        let (_, rest) = fixture(name);
        if let Some(m) = rest.get("messages") {
            *self.shared.messages.lock() = m.clone();
        }
    }

    /// Cuts every event stream (the process stays).
    pub fn drop_streams(&self) {
        for tx in self.shared.subscribers.lock().drain(..) {
            let _ = tx.send(None);
        }
    }

    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.drop_streams();
        // wakes the accept loop
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }

    pub fn requests(&self) -> Vec<Req> {
        self.shared.requests.lock().clone()
    }

    /// `METHOD path` of every request so far, queries dropped.
    pub fn log(&self) -> Vec<String> {
        self.requests()
            .iter()
            .filter(|r| r.path != "/api/event")
            .map(|r| format!("{} {}", r.method, r.path))
            .collect()
    }

    pub fn find(&self, method: &str, path_end: &str) -> Vec<Req> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == method && r.path.ends_with(path_end))
            .collect()
    }

    pub fn streams(&self) -> u32 {
        *self.shared.streams.lock()
    }
}

fn serve(conn: TcpStream, s: &Arc<Shared>) {
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let (path, query) = (path.to_string(), query.to_string());
    let mut length = 0usize;
    let mut auth = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") {
            auth = h.split_once(':').unwrap().1.trim().to_string();
        }
    }
    let mut raw = vec![0u8; length];
    let _ = reader.read_exact(&mut raw);
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let authorized = auth_matches(&auth, &s.password);
    let req = Req {
        method,
        path,
        query,
        body,
        authorized,
    };
    s.requests.lock().push(req.clone());
    let mut out = conn;
    if !req.authorized {
        return reply(&mut out, 401, &json!({"_tag": "UnauthorizedError"}));
    }
    if req.path == "/api/event" {
        if s.reject_stream.load(Ordering::SeqCst) {
            return reply(&mut out, 401, &json!({"_tag": "UnauthorizedError"}));
        }
        return stream(out, s);
    }
    let delay = s
        .delays
        .lock()
        .iter()
        .find(|(frag, _)| req.path.contains(frag.as_str()))
        .map(|(_, d)| *d);
    if let Some(d) = delay {
        std::thread::sleep(d);
    }
    let scripted = s.handler.lock().as_ref().and_then(|h| h(&req));
    let (status, body) = scripted.unwrap_or_else(|| default_route(&req, s));
    reply(&mut out, status, &body);
}

fn auth_matches(header: &str, password: &str) -> bool {
    use base64::Engine as _;
    let want = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
    header == format!("Basic {want}")
}

fn reply(out: &mut TcpStream, status: u16, body: &Value) {
    let text = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    let status = if body.is_null() && status == 200 {
        204
    } else {
        status
    };
    let _ = write!(
        out,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = out.flush();
    let _ = out.shutdown(Shutdown::Both);
}

fn stream(mut out: TcpStream, s: &Arc<Shared>) {
    let _ = write!(
        out,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
    );
    let (tx, rx) = channel();
    s.subscribers.lock().push(tx);
    *s.streams.lock() += 1;
    let hello = json!({"id": "evt_fake0000", "type": "server.connected", "data": {}}).to_string();
    let _ = write!(out, "data: {hello}\n\n");
    let _ = out.flush();
    loop {
        if s.stop.load(Ordering::SeqCst) {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Some(payload)) => {
                if write!(out, "data: {payload}\n\n").is_err() || out.flush().is_err() {
                    break;
                }
            }
            Ok(None) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    let _ = out.shutdown(Shutdown::Both);
}

fn segments(path: &str) -> Vec<&str> {
    path.trim_matches('/').split('/').collect()
}

/// The body the real server gave (`fixtures/rest.json`), so the tests run on real shapes.
fn recorded(key: &str) -> Value {
    let all: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures_dir().join("rest.json")).unwrap())
            .unwrap();
    all[key]["body"].clone()
}

fn default_route(req: &Req, s: &Arc<Shared>) -> (u16, Value) {
    let seg = segments(&req.path);
    let m = req.method.as_str();
    match (m, seg.as_slice()) {
        ("GET", ["api", "info"]) => {
            let mut info = recorded("info");
            info["version"] = json!(s.version);
            (200, info)
        }
        ("POST", ["api", "session"]) => (200, recorded("session-create")),
        ("POST", ["api", "session", _, "generate"]) => (200, recorded("generate")),
        ("GET", ["api", "session", "active"]) => (
            200,
            json!({"data": s.active.lock().iter().map(|id| (id.clone(), json!({}))).collect::<serde_json::Map<_, _>>()}),
        ),
        ("GET", ["api", "session", id]) => {
            if s.unknown_session.load(Ordering::SeqCst) {
                (404, recorded("session-get-404"))
            } else {
                (200, json!({"data": {"id": id}}))
            }
        }
        ("POST", ["api", "session", _, "prompt"]) => {
            let id = req.body["id"].as_str().unwrap_or("").to_string();
            if s.conflict_ids.lock().contains(&id) {
                return (409, recorded("prompt-id-conflict"));
            }
            let mut items = s.items.lock();
            if !items.contains(&id) {
                items.push(id.clone());
            }
            (
                200,
                json!({"data": {"id": id, "delivery": req.body["delivery"]}}),
            )
        }
        // the contract: 204 whether or not it cancelled; the outcome is the first of
        // `inbox.cancelled` and `inbox.delivered` for that id (nothing at all for an item that was
        // delivered long ago)
        ("DELETE", ["api", "session", sid, "inbox", id]) => {
            let (kind, known) = if s.taken.lock().contains(*id) {
                ("session.inbox.delivered", true)
            } else {
                let mut items = s.items.lock();
                let known = items.iter().any(|i| i == id);
                items.retain(|i| i != id);
                ("session.inbox.cancelled", known)
            };
            if known && !s.silent_inbox.load(Ordering::SeqCst) {
                let ev = json!({"id": "evt_fake", "created": 1, "type": kind,
                    "data": {"sessionID": sid, "inboxID": id}});
                // after the answer, as the real server does
                let shared = Arc::clone(s);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(30));
                    shared.emit(&ev.to_string());
                });
            }
            (204, Value::Null)
        }
        ("GET", ["api", "session", _, "inbox"]) => (
            200,
            json!({"data": s.items.lock().iter().map(|i| json!({"id": i})).collect::<Vec<_>>()}),
        ),
        ("GET", ["api", "session", _, "message"]) => (200, s.messages.lock().clone()),
        // Writer's agents, as the server lists them once Writer's config is in force
        ("GET", ["api", "agent"]) => (
            200,
            json!({"data": [
                {"id": "writer", "mode": "primary", "hidden": false},
                {"id": "writer-explorer", "mode": "subagent", "hidden": false},
                {"id": "writer-worker", "mode": "subagent", "hidden": false},
                {"id": "compaction", "mode": "primary", "hidden": true},
                {"id": "summary", "mode": "primary", "hidden": true},
            ]}),
        ),
        ("GET", ["api", "model"]) => (200, recorded("models")),
        ("GET", ["api", "skill"]) => (200, recorded("skills")),
        ("GET", ["api", "command"]) => (200, recorded("commands")),
        ("GET", ["api", "mcp"]) => (200, recorded("mcp")),
        ("POST", ["api", "session", _, "interrupt"]) => (200, recorded("interrupt-idle")),
        ("GET", ["api", "session", _, "permission"]) | ("GET", ["api", "session", _, "form"]) => {
            (200, json!({"data": []}))
        }
        ("POST", ["api", "session", _, "permission", id, "reply"]) => {
            if s.gone.lock().contains(*id) {
                (404, recorded("permission-reply-404"))
            } else {
                (204, Value::Null)
            }
        }
        _ => (204, Value::Null),
    }
}

// ---------------------------------------------------------------------------------------------
// The launcher

pub(super) struct FakeProcess {
    pub server: Arc<FakeServer>,
    endpoint: Endpoint,
    exit: Mutex<Option<ExitInfo>>,
    stop_delay: Duration,
}

impl FakeProcess {
    /// The process dies: its streams are cut and it is reported gone.
    pub fn crash(&self, code: i32) {
        *self.exit.lock() = Some(ExitInfo {
            code: Some(code),
            signal: None,
        });
        self.server.stop();
    }
}

impl Process for FakeProcess {
    fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    fn exited(&self) -> Option<ExitInfo> {
        self.exit.lock().clone()
    }

    fn stop(&self) {
        std::thread::sleep(self.stop_delay);
        let mut e = self.exit.lock();
        if e.is_none() {
            *e = Some(ExitInfo::default());
        }
        drop(e);
        self.server.stop();
    }
}

#[derive(Default)]
pub(super) struct FakeLauncher {
    pub version: Mutex<String>,
    pub processes: Mutex<Vec<Arc<FakeProcess>>>,
    pub specs: Mutex<Vec<LaunchSpec>>,
    pub fail: Mutex<Option<LaunchError>>,
    /// Prompt ids that survive a restart.
    pub items: Arc<Mutex<Vec<String>>>,
    /// A delay before `stop` returns (a process that is slow to die).
    pub stop_delay: Mutex<Duration>,
    /// The streams of the next process answer 401.
    pub reject_stream: AtomicBool,
    /// The next process does not know any session (set before the start, never raced).
    pub unknown_session: AtomicBool,
    /// The message list the next process serves.
    pub messages: Mutex<Option<Value>>,
}

impl FakeLauncher {
    pub fn new(version: &str) -> Arc<Self> {
        let l = FakeLauncher::default();
        *l.version.lock() = version.to_string();
        Arc::new(l)
    }

    pub fn current(&self) -> Arc<FakeProcess> {
        Arc::clone(self.processes.lock().last().expect("a process was started"))
    }

    pub fn launches(&self) -> usize {
        self.processes.lock().len()
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, LaunchError> {
        if let Some(e) = self.fail.lock().clone() {
            return Err(e);
        }
        self.specs.lock().push(spec.clone());
        let server = FakeServer::start_with(
            &spec.password,
            &self.version.lock(),
            Arc::clone(&self.items),
        );
        server
            .shared
            .reject_stream
            .store(self.reject_stream.load(Ordering::SeqCst), Ordering::SeqCst);
        if let Some(m) = self.messages.lock().clone() {
            *server.shared.messages.lock() = m;
        }
        server.shared.unknown_session.store(
            self.unknown_session.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
        let p = Arc::new(FakeProcess {
            endpoint: server.endpoint(),
            server,
            exit: Mutex::new(None),
            stop_delay: *self.stop_delay.lock(),
        });
        self.processes.lock().push(Arc::clone(&p));
        Ok(p)
    }
}

/// Polls `cond` until it holds, panicking after `secs`.
pub(super) fn wait_for(what: &str, secs: u64, mut cond: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}
