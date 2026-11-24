//! [`OpencodeServer`]: one `opencode serve` per window and vault, shared by every OpenCode chat of
//! it (spec `SPECs/opencode-backend-spec.md` section 5). It owns the process (spawned through the
//! scope's `Spawner`, alone in its process group), its one-time password and port, the ready
//! check, the version check, the one `GET /api/event` subscription and the fan-out of its events
//! to the chat that owns each session. It never knows what an event means: the mapper does.
//!
//! Flows:
//!
//! - **Start** ([`OpencodeServer::ensure_started`], blocking, once at a time): launch with the
//!   isolated environment ([`isolated_env`]), `GET /api/info` and refuse a version older than
//!   [`MIN_VERSION`], open the stream and wait for `server.connected`.
//! - **Fan-out**: a chat [`register`](OpencodeServer::register)s one sink and
//!   [`own`](OpencodeServer::own)s its session ids; a `session.created` whose parent is owned
//!   makes the new session owned by the same chat (transitively, a grandchild too). An event of a
//!   session nobody owns is dropped and counted ([`OpencodeServer::dropped`]).
//! - **Stream drop** with the process alive: reconnect with a pause, then tell every chat to
//!   resync ([`ChatInput::Resync`]); there is no replay.
//! - **Crash**: the process is gone: every chat is told ([`ChatInput::Down`]) once, and the next
//!   [`ensure_started`](OpencodeServer::ensure_started) starts a new one (new port, new password).
//! - **Stop**: SIGTERM to the group, SIGKILL after 15 s; never by pattern.
//!
//! Never logged: the password, the port, paths, any event content.

use super::client::{Client, Endpoint, Io, SHORT};
use super::opencode_api::{self as api, Info, SseParser, WireEvent, MIN_VERSION};
use crate::features::scope::Spawner;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// What a chat is told.
#[derive(Debug, Clone)]
pub enum ChatInput {
    Event(WireEvent),
    /// The stream dropped and is back: reconcile from the message list.
    Resync,
    /// The server process is gone (a crash, or it was stopped).
    Down(ExitInfo),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// Where a chat's events are delivered. Called from the stream task: it must not block.
pub type Sink = Arc<dyn Fn(ChatInput) + Send + Sync>;

/// One running server process, as far as the owner needs it.
pub trait Process: Send + Sync {
    fn endpoint(&self) -> &Endpoint;
    /// `Some` once the process is gone.
    fn exited(&self) -> Option<ExitInfo>;
    /// SIGTERM to its group, SIGKILL after 15 s. Blocks until it is gone.
    fn stop(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// The program does not exist.
    NotFound,
    Failed(String),
}

/// What to start: the program and its whole environment (nothing is inherited).
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub root: PathBuf,
    pub env: Vec<(String, String)>,
    pub password: String,
}

/// Starts a server process and returns once it said `server listening`. The real one is
/// [`ProcessLauncher`]; tests bring a fake OpenCode server.
pub trait Launcher: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, LaunchError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerError {
    NotFound,
    /// A version older than [`MIN_VERSION`], of another major, or one that is not a version.
    Unsupported(String),
    Failed(String),
}

impl std::fmt::Display for ServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerError::NotFound => write!(f, "The opencode program was not found"),
            ServerError::Unsupported(v) => {
                write!(
                    f,
                    "OpenCode {v} is not supported; Writer needs {MIN_VERSION} or newer"
                )
            }
            ServerError::Failed(m) => write!(f, "{m}"),
        }
    }
}

/// What a server is started with. The config file is written by the caller (phase 3's builder);
/// the config home is recreated empty on every start.
#[derive(Debug, Clone)]
pub struct ServerSettings {
    pub program: PathBuf,
    /// The vault root: the server's working directory.
    pub root: PathBuf,
    pub config_file: PathBuf,
    /// Writer's own empty `XDG_CONFIG_HOME`: `<app data>/opencode/xdg-config`, recreated on every
    /// start (see [`ServerSettings::config_home_is_ours`]).
    pub config_home: PathBuf,
    /// The app data directory the config home must live in.
    pub app_data: PathBuf,
}

impl ServerSettings {
    /// The folder about to be deleted is Writer's own and nothing else.
    pub fn config_home_is_ours(&self) -> bool {
        self.config_home == self.app_data.join("opencode").join("xdg-config")
    }
}

/// The environment of the server (spec section 8, "Isolation"): the inherited one with every
/// `OPENCODE_*` variable removed first (a stray `OPENCODE_CONFIG_CONTENT` would bring the user's
/// own setup back), then Writer's: the password, Writer's config file, the vault's own
/// `opencode.json` and `.opencode/` switched off, an empty config home, no Claude Code compatibility
/// and no self-update. The real `HOME` stays: the user's logins live in OpenCode's data directory.
pub fn isolated_env(
    inherited: impl IntoIterator<Item = (String, String)>,
    password: &str,
    settings: &ServerSettings,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = inherited
        .into_iter()
        .filter(|(k, _)| !k.starts_with("OPENCODE_") && k != "XDG_CONFIG_HOME")
        .collect();
    let ours = [
        ("OPENCODE_SERVER_PASSWORD", password.to_string()),
        (
            "OPENCODE_CONFIG",
            settings.config_file.to_string_lossy().into_owned(),
        ),
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "1".to_string()),
        ("OPENCODE_DISABLE_CLAUDE_CODE", "1".to_string()),
        ("OPENCODE_DISABLE_AUTOUPDATE", "1".to_string()),
        (
            "XDG_CONFIG_HOME",
            settings.config_home.to_string_lossy().into_owned(),
        ),
    ];
    env.extend(ours.map(|(k, v)| (k.to_string(), v)));
    env
}

/// What the ready line of `opencode serve` says: `server listening on http://127.0.0.1:<port>`.
#[derive(Debug, PartialEq, Eq)]
pub enum Listening {
    /// Exactly `http://127.0.0.1:<port>`: the only place Writer ever talks to.
    Loopback(String),
    /// A ready line that names anything else (another host, userinfo, a path): refused before a
    /// request carries the password.
    Elsewhere,
}

/// `None` when the line is not a ready line.
pub fn listening_url(line: &str) -> Option<Listening> {
    let rest = line.split("server listening on").nth(1)?.trim();
    let url = rest.split_whitespace().next().unwrap_or("");
    let url = url.strip_suffix('/').unwrap_or(url);
    let port = url.strip_prefix("http://127.0.0.1:");
    Some(match port {
        Some(p)
            if !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n != 0) =>
        {
            Listening::Loopback(url.to_string())
        }
        _ => Listening::Elsewhere,
    })
}

/// `x.y.z` is not older than `MIN_VERSION` and of the same major (a leading `v` and a suffix after `-` are ignored).
pub fn version_ok(found: &str) -> bool {
    fn parts(v: &str) -> Option<[u64; 3]> {
        let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
        let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
        Some([it.next()??, it.next()??, it.next().unwrap_or(Some(0))?])
    }
    // the pinned major only: a newer major may have changed the contract
    matches!((parts(found), parts(MIN_VERSION)), (Some(a), Some(b)) if a[0] == b[0] && a >= b)
}

// ---------------------------------------------------------------------------------------------

struct Live {
    epoch: u64,
    process: Arc<dyn Process>,
    client: Client,
    info: Info,
}

/// A server that is up: what a transport talks through.
#[derive(Clone)]
pub struct Connection {
    pub client: Client,
    pub epoch: u64,
    pub version: String,
}

#[derive(Default)]
struct Routes {
    next: u64,
    sinks: HashMap<u64, Sink>,
    /// Session id -> the sink that owns it.
    owner: HashMap<String, u64>,
}

struct Inner {
    io: Arc<Io>,
    launcher: Arc<dyn Launcher>,
    settings: ServerSettings,
    /// The environment the server inherits (the login-shell PATH, no secrets).
    inherited: Box<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    start_lock: Mutex<()>,
    live: Mutex<Option<Live>>,
    routes: Mutex<Routes>,
    epoch: AtomicU64,
    dropped: AtomicU64,
    starts: AtomicU64,
    closed: AtomicBool,
}

pub struct OpencodeServer {
    inner: Arc<Inner>,
}

impl OpencodeServer {
    pub fn new(
        io: Arc<Io>,
        launcher: Arc<dyn Launcher>,
        settings: ServerSettings,
        inherited: Box<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                io,
                launcher,
                settings,
                inherited,
                start_lock: Mutex::new(()),
                live: Mutex::new(None),
                routes: Mutex::new(Routes::default()),
                epoch: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
                starts: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
        })
    }

    pub fn io(&self) -> &Arc<Io> {
        &self.inner.io
    }

    /// How many events were dropped because no chat owned their session.
    pub fn dropped(&self) -> u64 {
        self.inner.dropped.load(Ordering::SeqCst)
    }

    /// How many times a server process was started (a restart counts).
    pub fn starts(&self) -> u64 {
        self.inner.starts.load(Ordering::SeqCst)
    }

    /// The server as it is now, `None` when it is not up.
    pub fn connection(&self) -> Option<Connection> {
        let live = self.inner.live.lock();
        let l = live.as_ref()?;
        l.process.exited().is_none().then(|| Connection {
            client: l.client.clone(),
            epoch: l.epoch,
            version: l.info.version.clone(),
        })
    }

    /// Starts the server unless it is up. Blocks (it runs the process and waits for it); only one
    /// start runs at a time, a second caller gets the first one's server.
    pub fn ensure_started(&self) -> Result<Connection, ServerError> {
        let _one = self.inner.start_lock.lock();
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(ServerError::Failed("OpenCode is stopped".into()));
        }
        if let Some(c) = self.connection() {
            return Ok(c);
        }
        // a dead one is forgotten (its chats were told when it died)
        if let Some(old) = self.inner.live.lock().take() {
            old.process.stop();
        }
        self.start()
    }

    fn start(&self) -> Result<Connection, ServerError> {
        let inner = &self.inner;
        let password = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        // the config home is recreated empty on every start (U1); never a folder that is not
        // Writer's own
        if !inner.settings.config_home_is_ours() {
            return Err(ServerError::Failed(
                "OpenCode's config folder is not Writer's".into(),
            ));
        }
        let _ = std::fs::remove_dir_all(&inner.settings.config_home);
        std::fs::create_dir_all(&inner.settings.config_home).map_err(|_| {
            ServerError::Failed("OpenCode's config folder could not be made".into())
        })?;
        let spec = LaunchSpec {
            program: inner.settings.program.clone(),
            root: inner.settings.root.clone(),
            env: isolated_env((inner.inherited)(), &password, &inner.settings),
            password,
        };
        let process = inner.launcher.launch(&spec).map_err(|e| match e {
            LaunchError::NotFound => ServerError::NotFound,
            LaunchError::Failed(m) => ServerError::Failed(m),
        })?;
        inner.starts.fetch_add(1, Ordering::SeqCst);
        let client = inner.io.client(process.endpoint().clone());
        let refuse = |why: ServerError, process: &Arc<dyn Process>| {
            process.stop();
            why
        };
        let info = {
            let c = client.clone();
            inner
                .io
                .call(async move { c.get(&api::INFO, &[]).await }, SHORT)
        };
        let info: Info = match info {
            Some(Ok(v)) => serde_json::from_value(v).map_err(|_| {
                refuse(
                    ServerError::Failed("OpenCode's info was unreadable".into()),
                    &process,
                )
            })?,
            Some(Err(e)) => return Err(refuse(ServerError::Failed(e.to_string()), &process)),
            None => {
                return Err(refuse(
                    ServerError::Failed("OpenCode did not answer".into()),
                    &process,
                ))
            }
        };
        if !version_ok(&info.version) {
            return Err(refuse(ServerError::Unsupported(info.version), &process));
        }
        let epoch = inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        let task = stream_task(
            Arc::downgrade(inner),
            client.clone(),
            Arc::clone(&process),
            epoch,
            tx,
        );
        inner.io.spawn(task);
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(()) => {}
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                return Err(refuse(
                    ServerError::Failed("OpenCode's event stream did not open".into()),
                    &process,
                ))
            }
        }
        let version = info.version.clone();
        *inner.live.lock() = Some(Live {
            epoch,
            process,
            client: client.clone(),
            info,
        });
        Ok(Connection {
            client,
            epoch,
            version,
        })
    }

    /// A chat's sink. Its sessions are named with [`OpencodeServer::own`].
    pub fn register(&self, sink: Sink) -> u64 {
        let mut r = self.inner.routes.lock();
        r.next += 1;
        let key = r.next;
        r.sinks.insert(key, sink);
        key
    }

    pub fn own(&self, key: u64, session: &str) {
        self.inner
            .routes
            .lock()
            .owner
            .insert(session.to_string(), key);
    }

    /// The chat is gone: its sink and every session it owned (children included).
    pub fn release(&self, key: u64) {
        let mut r = self.inner.routes.lock();
        r.sinks.remove(&key);
        r.owner.retain(|_, k| *k != key);
    }

    /// The chat owns this session (or a session below it).
    #[cfg(test)]
    pub fn owns(&self, key: u64, session: &str) -> bool {
        self.inner.routes.lock().owner.get(session) == Some(&key)
    }

    /// Stops the process and the runtime: the window or the vault closed.
    pub fn shutdown(&self) {
        let _one = self.inner.start_lock.lock();
        self.inner.closed.store(true, Ordering::SeqCst);
        if let Some(live) = self.inner.live.lock().take() {
            live.process.stop();
        }
        self.inner.io.stop();
    }
}

impl Inner {
    fn sink_of(&self, session: &str) -> Option<Sink> {
        let r = self.routes.lock();
        r.owner.get(session).and_then(|k| r.sinks.get(k)).cloned()
    }

    fn broadcast(&self, input: &ChatInput) {
        let sinks: Vec<Sink> = self.routes.lock().sinks.values().cloned().collect();
        for s in sinks {
            s(input.clone());
        }
    }

    /// One frame of the stream.
    fn dispatch(&self, ev: WireEvent) {
        if ev.kind == "session.created" {
            // a child of an owned session is owned by the same chat, at once, so its first events
            // already find their way
            if let (Some(id), Some(parent)) = (
                ev.data.get("sessionID").and_then(Value::as_str),
                ev.data.get("parentID").and_then(Value::as_str),
            ) {
                let mut r = self.routes.lock();
                if let Some(k) = r.owner.get(parent).copied() {
                    r.owner.insert(id.to_string(), k);
                }
            }
        }
        let session = ev
            .session_id()
            .or_else(|| ev.data["form"]["sessionID"].as_str())
            .or_else(|| ev.data["info"]["sessionID"].as_str());
        let Some(session) = session else {
            // server-wide events name no session; the chats read the models again on this one
            if ev.kind == "model.updated" {
                self.broadcast(&ChatInput::Event(ev));
            }
            return;
        };
        match self.sink_of(session) {
            Some(sink) => sink(ChatInput::Event(ev)),
            None => {
                self.dropped.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// The process is gone: forget it and tell every chat once.
    fn down(&self, epoch: u64, exit: ExitInfo) {
        {
            let mut live = self.live.lock();
            match live.as_ref() {
                Some(l) if l.epoch == epoch => *live = None,
                // an older stream's end, or already handled
                _ => return,
            }
        }
        self.broadcast(&ChatInput::Down(exit));
    }
}

/// The one `GET /api/event` subscription of one server process, until the process is gone.
async fn stream_task(
    inner: Weak<Inner>,
    client: Client,
    process: Arc<dyn Process>,
    epoch: u64,
    connected: std::sync::mpsc::Sender<()>,
) {
    let mut connected = Some(connected);
    let mut failures = 0u32;
    let mut reconnected = false;
    loop {
        let Some(inner_arc) = inner.upgrade() else {
            return;
        };
        if inner_arc.io.is_stopped() || inner_arc.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Some(exit) = process.exited() {
            inner_arc.down(epoch, exit);
            return;
        }
        match client.open_events().await {
            Ok(mut resp) => {
                failures = 0;
                let mut parser = SseParser::default();
                if reconnected {
                    // what the stream missed is read back from the message lists
                    inner_arc.broadcast(&ChatInput::Resync);
                }
                reconnected = true;
                // until the stream ends or breaks
                while let Ok(Some(bytes)) = resp.chunk().await {
                    for payload in parser.push(&bytes) {
                        let Ok(ev) = WireEvent::parse(&payload) else {
                            continue;
                        };
                        if ev.kind == "server.connected" {
                            if let Some(tx) = connected.take() {
                                let _ = tx.send(());
                            }
                        }
                        inner_arc.dispatch(ev);
                    }
                }
            }
            Err(e) => {
                failures += 1;
                if e.is_unauthorized() || failures > 20 {
                    // the server is not ours to talk to any more: end it, the next send restarts
                    // (stopping waits for the process: never on this runtime's one thread)
                    let p = Arc::clone(&process);
                    drop(tokio::task::spawn_blocking(move || p.stop()));
                }
            }
        }
        drop(inner_arc);
        // a dying process is seen as a closed stream first: give its exit a moment to be known
        for _ in 0..10 {
            if let Some(exit) = process.exited() {
                if let Some(i) = inner.upgrade() {
                    i.down(epoch, exit);
                }
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

// ---------------------------------------------------------------------------------------------
// The real launcher

/// Starts `opencode serve` as a child of the scope.
pub struct ProcessLauncher {
    pub spawner: Spawner,
}

struct ChildProcess {
    /// Set from the ready line's own URL, before the process is handed out.
    endpoint: std::sync::OnceLock<Endpoint>,
    child: Arc<Mutex<crate::features::scope::ScopedChild>>,
    pid: u32,
    exit: Arc<Mutex<Option<ExitInfo>>>,
}

impl Process for ChildProcess {
    fn endpoint(&self) -> &Endpoint {
        self.endpoint
            .get()
            .expect("set before the process is handed out")
    }

    fn exited(&self) -> Option<ExitInfo> {
        self.exit.lock().clone()
    }

    fn stop(&self) {
        if self.exited().is_some() {
            return;
        }
        #[cfg(unix)]
        // SAFETY: signals the process group of the child this process started with
        // `process_group(0)`; the group id is its pid and is not reused while it is not reaped.
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGTERM);
        }
        for _ in 0..300 {
            if self.exited().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // a server that ignores SIGTERM (an open stream held one for 10 s in the spike)
        self.child.lock().kill();
    }
}

impl Launcher for ProcessLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, LaunchError> {
        let mut cmd = std::process::Command::new(&spec.program);
        cmd.args([
            "serve",
            "--hostname",
            "127.0.0.1",
            // the system picks the port and the ready line says which (opencode 2.4.0 accepts 0):
            // no probe-then-bind race
            "--port",
            "0",
        ])
        .current_dir(&spec.root)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        let mut child = self.spawner.process(&mut cmd).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                LaunchError::NotFound
            } else {
                LaunchError::Failed("OpenCode could not be started".into())
            }
        })?;
        let pid = child.id();
        let stdout = child.take_stdout();
        let stderr = child.take_stderr();
        let child = Arc::new(Mutex::new(child));
        let exit = Arc::new(Mutex::new(None));
        // the ready line, then drained: what the server prints is never kept or logged
        let (ready_tx, ready_rx) = channel::<Listening>();
        if let Some(out) = stdout {
            self.spawner
                .spawn("opencode-stdout", move |_| {
                    use std::io::BufRead;
                    let mut ready = Some(ready_tx);
                    for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                        if let Some(said) = listening_url(&line) {
                            if let Some(tx) = ready.take() {
                                let _ = tx.send(said);
                            }
                        }
                    }
                })
                .map_err(|_| LaunchError::Failed("OpenCode is stopping".into()))?;
        }
        if let Some(err) = stderr {
            self.spawner
                .spawn("opencode-stderr", move |_| {
                    let _ = std::io::copy(&mut { err }, &mut std::io::sink());
                })
                .map_err(|_| LaunchError::Failed("OpenCode is stopping".into()))?;
        }
        {
            let (child, exit) = (Arc::clone(&child), Arc::clone(&exit));
            self.spawner
                .spawn("opencode-wait", move |token| loop {
                    let status = child.lock().try_wait();
                    if let Ok(Some(s)) = status {
                        *exit.lock() = Some(exit_info(&s));
                        return;
                    }
                    if status.is_err() {
                        *exit.lock() = Some(ExitInfo::default());
                        return;
                    }
                    if !token.sleep(Duration::from_millis(100)) {
                        return;
                    }
                })
                .map_err(|_| LaunchError::Failed("OpenCode is stopping".into()))?;
        }
        let process = ChildProcess {
            endpoint: std::sync::OnceLock::new(),
            child,
            pid,
            exit,
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            match ready_rx.recv_timeout(Duration::from_millis(100)) {
                // the process says where it listens; only loopback is ever talked to
                Ok(Listening::Loopback(url)) => {
                    let _ = process.endpoint.set(Endpoint::new(&url, &spec.password));
                    return Ok(Arc::new(process));
                }
                Ok(Listening::Elsewhere) => {
                    process.stop();
                    return Err(LaunchError::Failed("OpenCode listens elsewhere".into()));
                }
                Err(RecvTimeoutError::Timeout) => {}
                // stdout closed before the ready line: it exited
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(LaunchError::Failed("OpenCode exited while starting".into()))
                }
            }
            if process.exited().is_some() {
                return Err(LaunchError::Failed("OpenCode exited while starting".into()));
            }
            if std::time::Instant::now() > deadline {
                process.stop();
                return Err(LaunchError::Failed("OpenCode did not start in time".into()));
            }
        }
    }
}

#[cfg(unix)]
fn exit_info(s: &std::process::ExitStatus) -> ExitInfo {
    use std::os::unix::process::ExitStatusExt;
    ExitInfo {
        code: s.code(),
        signal: s.signal().map(|n| format!("SIG{n}")),
    }
}

#[cfg(not(unix))]
fn exit_info(s: &std::process::ExitStatus) -> ExitInfo {
    ExitInfo {
        code: s.code(),
        signal: None,
    }
}
