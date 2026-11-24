//! [`OpencodeServer`]: one `opencode serve` per window and vault, shared by every OpenCode chat of
//! it (spec `SPECs/opencode-backend-spec.md` section 5). It owns the process (spawned through the
//! scope's `Spawner`, alone in its process group), its one-time password and port, the ready
//! check, the version check, the one `GET /api/event` subscription and the fan-out of its events
//! to the chat that owns each session. It never knows what an event means: the mapper does.
//!
//! Flows:
//!
//! - **Start** ([`OpencodeServer::ensure_started`], blocking, once at a time), fail closed: the
//!   config file with the deny-all MCP policies is on disk first, then launch with the isolated
//!   environment ([`isolated_env`]), `GET /api/info` and refuse a version older than
//!   [`MIN_VERSION`], the names step (`GET /api/config`, the keys of the user's MCP servers; a
//!   changed document is written and read again), then open the stream and wait for
//!   `server.connected`. Nothing of the user's config starts before the first location-scoped
//!   call, so the lever is in force before any server can (captures C1, C2).
//! - **Fallback**: a user config that sets an `mcp.use` policy is applied after Writer's and can
//!   start a server once before Writer can stop it, so that start is stopped and the server
//!   runs on Writer's configuration alone ([`GlobalConfig::SkippedMcpPolicy`]).
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

use super::client::{Client, Endpoint, Io, LONG, SHORT};
use super::config::{self, Overrides};
use super::in_force::Expectation;
use super::opencode_api::{self as api, Info, SseParser, WireEvent, MIN_VERSION};
use crate::agent::mcp_menu::Switches;
use crate::features::scope::Spawner;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::time::Duration;

/// Whether the user's own OpenCode config (its MCP servers, agents, providers) is loaded in a
/// server. One neutral line for the UI, never the config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum GlobalConfig {
    /// Loaded, with its MCP servers held off unless switched on.
    Loaded,
    /// Not loaded: the user's config sets an `mcp.use` policy, which Writer cannot hold off before
    /// a server may start once, so this server runs on Writer's configuration alone.
    SkippedMcpPolicy,
}

/// What a chat is told.
#[derive(Debug, Clone)]
pub enum ChatInput {
    Event(WireEvent),
    /// The server read its config again: whatever it keeps per session may need to be put back.
    Reloaded,
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

/// What the user's switches are, read when the config is rendered: the stored MCP list (the
/// servers switched on) and the providers switched off. Names only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stored {
    pub mcp_on: Vec<String>,
    pub providers_off: Vec<String>,
}

/// Where the current switches come from (the settings, for the window of the server).
pub type SwitchSource = Arc<dyn Fn() -> Stored + Send + Sync>;

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
    /// The server was stopped (its window closed, the feature went off): it never starts again.
    Closed,
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
            ServerError::Closed => write!(f, "OpenCode is stopped"),
        }
    }
}

/// What a server is started with. The config file is written by [`OpencodeServer::apply_config`]
/// (the policy builds its text); the config home and the shell wrapper are recreated on every
/// start.
#[derive(Debug, Clone)]
pub struct ServerSettings {
    pub program: PathBuf,
    /// The vault root: the server's working directory.
    pub root: PathBuf,
    pub config_file: PathBuf,
    /// Writer's own empty `XDG_CONFIG_HOME`: `<app data>/opencode/xdg-config`. Only the fallback
    /// ([`GlobalConfig::SkippedMcpPolicy`]) runs on it (recreated empty for that start); any other
    /// start removes it, which also clears the one the first version kept
    /// (see [`ServerSettings::config_home_is_ours`]).
    pub config_home: PathBuf,
    /// The `SHELL` of the server, so the commands the agent runs do not see the server's own
    /// settings (see [`shell_wrapper`]): `<app data>/opencode/writer-shell`.
    pub shell_wrapper: PathBuf,
    /// The app data directory the config home and the wrapper must live in.
    pub app_data: PathBuf,
}

impl ServerSettings {
    /// The folder about to be deleted is Writer's own and nothing else.
    pub fn config_home_is_ours(&self) -> bool {
        self.is_ours(&self.config_home, CONFIG_HOME_NAME)
    }

    /// The file about to be written is Writer's own wrapper and nothing else.
    pub fn shell_wrapper_is_ours(&self) -> bool {
        self.is_ours(&self.shell_wrapper, SHELL_WRAPPER_NAME)
    }

    /// The file about to be written is Writer's own config: `<app data>/opencode/<name>.json`.
    pub fn config_file_is_ours(&self) -> bool {
        self.config_file.extension().is_some_and(|e| e == "json")
            && self.config_file.parent() == Some(&self.app_data.join("opencode"))
    }

    fn is_ours(&self, path: &Path, name: &str) -> bool {
        path == self.app_data.join("opencode").join(name)
    }
}

pub const CONFIG_HOME_NAME: &str = "xdg-config";
pub const SHELL_WRAPPER_NAME: &str = "writer-shell";

/// What Writer sets for the server and no command the agent runs has any business seeing: the
/// password, Writer's config, the switches and the config home. [`isolated_env`] sets exactly
/// these (a test says so) and [`shell_wrapper`] unsets exactly these.
const SERVER_VARS: [&str; 5] = [
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_AUTOUPDATE",
];
/// Also unset by the wrapper: the name OpenCode reads before `OPENCODE_SERVER_PASSWORD`, which
/// Writer never sets.
const EXTRA_PASSWORD_VAR: &str = "OPENCODE_PASSWORD";
/// Where [`isolated_env`] keeps what the wrapper gives back to the shell.
const USER_SHELL_VAR: &str = "WRITER_USER_SHELL";
const USER_XDG_VAR: &str = "WRITER_USER_XDG_CONFIG_HOME";

/// The environment of the server (spec section 8, "Isolation"): the inherited one with every
/// `OPENCODE_*` variable removed first (a stray `OPENCODE_CONFIG_CONTENT` would bring the user's
/// own setup back), then Writer's: the password, Writer's config file, the vault's own
/// `opencode.json` and `.opencode/` switched off, no Claude Code compatibility and no self-update.
/// The real `HOME` and `XDG_CONFIG_HOME` stay: the user's own OpenCode config loads, held off by
/// Writer's file (`config::overrides`), and their logins live in OpenCode's data directory.
/// Only for [`GlobalConfig::SkippedMcpPolicy`] the config home is Writer's empty one.
///
/// `SHELL` is Writer's wrapper ([`shell_wrapper`]); the shell the user had goes to the wrapper
/// under `WRITER_USER_SHELL`, which gives it back (and the user's `XDG_CONFIG_HOME` under
/// `WRITER_USER_XDG_CONFIG_HOME` in the fallback, where the server's own is replaced).
pub fn isolated_env(
    inherited: impl IntoIterator<Item = (String, String)>,
    password: &str,
    settings: &ServerSettings,
    global: GlobalConfig,
) -> Vec<(String, String)> {
    let skipped = global == GlobalConfig::SkippedMcpPolicy;
    let mut user_shell = None;
    let mut user_xdg = None;
    let mut env: Vec<(String, String)> = inherited
        .into_iter()
        .filter(|(k, v)| match k.as_str() {
            // never the wrapper itself (a server started from a shell that is one): it would
            // run itself for ever, so the wrapper falls back to `sh`
            "SHELL" => {
                user_shell = (Path::new(v) != settings.shell_wrapper).then(|| v.clone());
                false
            }
            "XDG_CONFIG_HOME" if skipped => {
                user_xdg = Some(v.clone());
                false
            }
            k => !k.starts_with("OPENCODE_") && !k.starts_with("WRITER_USER_"),
        })
        .collect();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let ours: [(&str, String); SERVER_VARS.len()] = [
        (SERVER_VARS[0], password.to_string()),
        (SERVER_VARS[1], path(&settings.config_file)),
        (SERVER_VARS[2], "1".to_string()),
        (SERVER_VARS[3], "1".to_string()),
        (SERVER_VARS[4], "1".to_string()),
    ];
    env.extend(ours.map(|(k, v)| (k.to_string(), v)));
    env.push(("SHELL".into(), path(&settings.shell_wrapper)));
    env.extend(user_shell.map(|v| (USER_SHELL_VAR.to_string(), v)));
    if skipped {
        env.push(("XDG_CONFIG_HOME".into(), path(&settings.config_home)));
        // set (empty when the user has none) so the wrapper knows to give theirs back or unset it
        env.push((USER_XDG_VAR.to_string(), user_xdg.unwrap_or_default()));
    }
    env
}

/// The script that is the server's `SHELL` (spec 10.9, 12b): OpenCode runs the agent's shell
/// commands with `$SHELL`, so a command would see the password and Writer's settings in its
/// environment. The wrapper unsets them, gives the shell and the `XDG_CONFIG_HOME` the user had
/// back and runs that shell with the arguments it was given. Plain `sh`: it works whatever the
/// user's shell is.
///
/// It does not hide anything from the process table: `ps -E` of the server's pid, by the same user,
/// still shows its environment (12c). The password stays mandatory; there is no socket or file
/// option in 2.4.0 (spec 10.9).
pub fn shell_wrapper() -> String {
    let unset = SERVER_VARS
        .iter()
        .chain([&EXTRA_PASSWORD_VAR])
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "#!/bin/sh\n\
         # Writer: the settings the OpenCode server was started with are not for the commands it runs.\n\
         unset {unset}\n\
         if [ \"${{{USER_XDG_VAR}+x}}\" = x ]; then\n\
         \x20 if [ -n \"${USER_XDG_VAR}\" ]; then XDG_CONFIG_HOME=${USER_XDG_VAR}; export XDG_CONFIG_HOME; else unset XDG_CONFIG_HOME; fi\n\
         fi\n\
         SHELL=${{{USER_SHELL_VAR}-}}\n\
         [ -x \"$SHELL\" ] || SHELL=/bin/sh\n\
         export SHELL\n\
         unset {USER_SHELL_VAR} {USER_XDG_VAR}\n\
         exec \"$SHELL\" \"$@\"\n"
    )
}

/// The wrapper, written fresh at every start (a changed script is never left behind) and made
/// executable.
fn write_shell_wrapper(settings: &ServerSettings) -> Result<(), ServerError> {
    let failed = || ServerError::Failed("OpenCode's shell wrapper could not be written".into());
    if !settings.shell_wrapper_is_ours() {
        return Err(failed());
    }
    let (Some(dir), Some(name)) = (
        settings.shell_wrapper.parent(),
        settings.shell_wrapper.file_name().and_then(|n| n.to_str()),
    ) else {
        return Err(failed());
    };
    let text = shell_wrapper();
    // already there, the same and executable: nothing to write
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let same = std::fs::read_to_string(&settings.shell_wrapper).is_ok_and(|t| t == text)
            && std::fs::metadata(&settings.shell_wrapper)
                .is_ok_and(|m| m.permissions().mode() & 0o777 == WRAPPER_MODE);
        if same {
            return Ok(());
        }
    }
    std::fs::create_dir_all(dir).map_err(|_| failed())?;
    // 0700 from creation, before the rename that puts it in place
    crate::plugins::write_atomic_private(dir, name, text.as_bytes(), WRAPPER_MODE)
        .map_err(|_| failed())
}

const WRAPPER_MODE: u32 = 0o700;

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
    /// The text of the config file as last written and (for a live server) loaded.
    written: Mutex<Option<String>>,
    /// The document the callers built (the config of the adapter and the vault): the overrides
    /// go on top of it at every write, so a switch can be put in force without rebuilding it.
    base: Mutex<Option<Value>>,
    /// The switches, read at every write.
    switches: Mutex<Option<SwitchSource>>,
    /// What the server found of the user's config: server names and the agents that must go.
    learned: Mutex<Learned>,
    /// The text of the config file the process was launched with, then read again at: what it
    /// runs. A switch written between the launch and the end of the start is read again.
    loaded: Mutex<Option<String>>,
    /// What the file written says must hold (the gate checks it).
    expect: Mutex<Expectation>,
    /// A user config with an `mcp.use` policy was found: every start from now runs on Writer's
    /// configuration alone.
    skip_global: AtomicBool,
    /// How the server that is up was started.
    global: Mutex<Option<GlobalConfig>>,
    /// The sessions that are executing a turn, and a reload that waits for the last of them.
    gate: Mutex<Gate>,
    reload_deadline_ms: AtomicU64,
    /// The epoch of the server start whose configuration was found in force (0: none).
    in_force: AtomicU64,
    /// Sessions of Writer's own helper calls (a title): not a chat's turn, so they are not
    /// counted by the gate that holds a reload or by what turning the feature off waits for.
    untracked: Mutex<std::collections::HashSet<String>>,
    /// Told each time a start of the server succeeded (what is owed to the server from before:
    /// the sessions of deleted chats).
    on_up: Mutex<Option<UpHook>>,
    /// Told when the server says its models changed (`model.updated`).
    on_models: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

/// What runs when a start succeeded, with the server's client.
pub type UpHook = Box<dyn Fn(&Client) + Send + Sync>;

#[derive(Default)]
struct Learned {
    mcp: std::collections::BTreeSet<String>,
    agents: std::collections::BTreeSet<String>,
}

#[derive(Default)]
struct Gate {
    running: std::collections::HashSet<String>,
    /// A reload waits for the last running turn; the token names the wait, for its deadline.
    reload_pending: Option<u64>,
    next_token: u64,
}

impl Gate {
    /// A waiting reload is due when nothing runs any more (and is then not waiting).
    fn take_due(&mut self) -> bool {
        let due = self.running.is_empty() && self.reload_pending.is_some();
        if due {
            self.reload_pending = None;
        }
        due
    }
}

/// How long a reload waits for running turns before it is made anyway: an end event that was
/// never seen must not hold the server's configuration for ever.
const RELOAD_DEADLINE: Duration = Duration::from_secs(600);

/// What a write of the config does about a server that is up.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reload {
    /// Nothing: the caller does it (a start, the gate).
    None,
    /// The server reads the file when no session is executing a turn.
    WhenIdle,
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
                written: Mutex::new(None),
                base: Mutex::new(None),
                switches: Mutex::new(None),
                learned: Mutex::new(Learned::default()),
                loaded: Mutex::new(None),
                expect: Mutex::new(Expectation::default()),
                skip_global: AtomicBool::new(false),
                global: Mutex::new(None),
                gate: Mutex::new(Gate::default()),
                reload_deadline_ms: AtomicU64::new(RELOAD_DEADLINE.as_millis() as u64),
                in_force: AtomicU64::new(0),
                untracked: Mutex::new(Default::default()),
                on_up: Mutex::new(None),
                on_models: Mutex::new(None),
            }),
        })
    }

    pub fn io(&self) -> &Arc<Io> {
        &self.inner.io
    }

    /// How many events were dropped because no chat owned their session.
    #[cfg(test)]
    pub fn dropped(&self) -> u64 {
        self.inner.dropped.load(Ordering::SeqCst)
    }

    /// How many times a server process was started (a restart counts).
    #[cfg(test)]
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
            return Err(ServerError::Closed);
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
        let mode = if self.inner.skip_global.load(Ordering::SeqCst) {
            GlobalConfig::SkippedMcpPolicy
        } else {
            GlobalConfig::Loaded
        };
        self.start_in(mode)
    }

    /// One start, fail closed (see the module doc). `mode` says whether the user's config is the
    /// server's own or Writer's empty home stands in for it.
    fn start_in(&self, mode: GlobalConfig) -> Result<Connection, ServerError> {
        let inner = &self.inner;
        let password = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        // the config home is Writer's, empty, for the fallback alone; any other start removes it
        // (the first version kept one for every start). Never a folder that is not Writer's own
        if !inner.settings.config_home_is_ours() {
            return Err(ServerError::Failed(
                "OpenCode's config folder is not Writer's".into(),
            ));
        }
        let _ = std::fs::remove_dir_all(&inner.settings.config_home);
        if mode == GlobalConfig::SkippedMcpPolicy {
            std::fs::create_dir_all(&inner.settings.config_home).map_err(|_| {
                ServerError::Failed("OpenCode's config folder could not be made".into())
            })?;
        }
        write_shell_wrapper(&inner.settings)?;
        // the deny-all policies are on disk before the first call that boots the location, which
        // is what starts the user's servers (capture C1)
        self.write_config(Reload::None)?;
        *inner.loaded.lock() = inner.written.lock().clone();
        let spec = LaunchSpec {
            program: inner.settings.program.clone(),
            root: inner.settings.root.clone(),
            env: isolated_env((inner.inherited)(), &password, &inner.settings, mode),
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
        if mode == GlobalConfig::Loaded {
            match self.names_step(&client) {
                Ok(false) => {}
                // the user's own `mcp.use` policy is applied after Writer's and can have started a
                // server already: that process goes, and the start runs without the user's config
                Ok(true) => {
                    process.stop();
                    log::info!(target: "opencode", "opencode: the user's config sets an MCP policy, so it is not loaded");
                    inner.skip_global.store(true, Ordering::SeqCst);
                    return self.start_in(GlobalConfig::SkippedMcpPolicy);
                }
                Err(e) => return Err(refuse(e, &process)),
            }
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
        // a switch written while the start ran (the file changed, nothing was up to read it)
        if mode == GlobalConfig::Loaded {
            if let Err(e) = self.sync_loaded(&client) {
                return Err(refuse(e, &process));
            }
        }
        *inner.global.lock() = Some(mode);
        *inner.live.lock() = Some(Live {
            epoch,
            process,
            client: client.clone(),
            info,
        });
        if let Some(hook) = inner.on_up.lock().as_ref() {
            hook(&client);
        }
        Ok(Connection {
            client,
            epoch,
            version,
        })
    }

    /// Has the process read the file as it is now: when what was written differs from what it
    /// loaded (names learned, or a switch written since the launch), it reads it again.
    fn sync_loaded(&self, client: &Client) -> Result<(), ServerError> {
        let now = self.inner.written.lock().clone();
        if now == *self.inner.loaded.lock() {
            return Ok(());
        }
        let c = client.clone();
        let reloaded = self.inner.io.call(
            async move { c.request(&api::RELOAD, &[], &[], None, LONG).await },
            LONG,
        );
        if !matches!(reloaded, Some(Ok(_))) {
            return Err(ServerError::Failed(
                "OpenCode did not read its new configuration".into(),
            ));
        }
        *self.inner.loaded.lock() = now;
        Ok(())
    }

    /// The names step: `GET /api/config` as the first location-scoped call (under the deny-all
    /// policies it starts nothing but Writer's server) gives the names of the user's MCP servers,
    /// keys only. New names change the document (a placeholder for each that is off, an allow for
    /// each that is on), which is written and read again before the stream opens. `true`: a
    /// document of the user's sets an `mcp.use` policy.
    fn names_step(&self, client: &Client) -> Result<bool, ServerError> {
        let c = client.clone();
        let reply = self.inner.io.call(
            async move { c.request(&api::CONFIG, &[], &[], None, LONG).await },
            LONG,
        );
        let reply = match reply {
            Some(Ok(v)) => v,
            Some(Err(e)) => return Err(ServerError::Failed(e.to_string())),
            None => return Err(ServerError::Failed("OpenCode did not answer".into())),
        };
        let names = config::config_names(&reply, &self.inner.settings.config_file);
        if names.foreign_mcp_policy {
            return Ok(true);
        }
        self.learn_mcp(names.mcp);
        self.write_config(Reload::None)?;
        self.sync_loaded(client)?;
        Ok(false)
    }

    /// What to do each time the server came up (set once by its owner, before the first start).
    pub fn on_up(&self, hook: UpHook) {
        *self.inner.on_up.lock() = Some(hook);
    }

    /// What to do when the server says its models changed (the settings page reads them again).
    pub fn on_models_changed(&self, hook: Box<dyn Fn() + Send + Sync>) {
        *self.inner.on_models.lock() = Some(hook);
    }

    /// `session` is a helper call's, not a chat's: its turns do not hold a reload and are not
    /// "running turns". Call it before the session first runs.
    pub fn untrack(&self, session: &str) {
        self.inner.untracked.lock().insert(session.to_string());
    }

    /// Where the user's switches come from (set once by the owner, before the first write).
    pub fn on_switches(&self, source: SwitchSource) {
        *self.inner.switches.lock() = Some(source);
    }

    /// The one write path of Writer's config file (spec section 8): `base` is the document of
    /// the adapter and the vault, the overrides ([`config::overrides`]) go on top of it, and the
    /// file is written when the result differs from what was written before. A running server
    /// reads it again (`POST /api/location/reload`) at its next idle moment: at once when no
    /// session is executing a turn, else when the last one ends. Call it before
    /// [`OpencodeServer::ensure_started`]: a server that starts reads the file as it is. Blocks.
    pub fn apply_config(&self, base: &str) -> Result<(), ServerError> {
        let doc: Value = serde_json::from_str(base)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| ServerError::Failed("OpenCode's config was not a document".into()))?;
        *self.inner.base.lock() = Some(doc);
        self.write_config(Reload::WhenIdle).map(|_| ())
    }

    /// Renders the config again from the document of the last [`apply_config`] and the switches
    /// as they are now (a switch changed), and has a running server read it. Nothing before the
    /// first `apply_config`: the next start renders it. Blocks.
    pub fn reapply(&self) -> Result<(), ServerError> {
        if self.inner.base.lock().is_none() {
            return Ok(());
        }
        self.write_config(Reload::WhenIdle).map(|_| ())
    }

    /// The overrides now: the user's switches over what the server found.
    fn overrides(&self) -> Overrides {
        let stored = self
            .inner
            .switches
            .lock()
            .clone()
            .map(|f| f())
            .unwrap_or_default();
        let sw = Switches::new(&config::MCP_SWITCHES, stored.mcp_on);
        let learned = self.inner.learned.lock();
        let known: Vec<String> = learned.mcp.iter().cloned().collect();
        // the known servers that are on, and the switched-on keys the server has not named (yet)
        let mut mcp_on: Vec<String> = known.iter().filter(|n| sw.on(n)).cloned().collect();
        mcp_on.extend(sw.switched.iter().cloned());
        Overrides {
            mcp_on,
            mcp_known: known,
            foreign_agents: learned.agents.iter().cloned().collect(),
            providers_off: stored.providers_off,
        }
    }

    /// Renders the document, writes the file when it changed and reloads as `reload` says.
    /// `true`: the file changed.
    fn write_config(&self, reload: Reload) -> Result<bool, ServerError> {
        let inner = &self.inner;
        let mut written = inner.written.lock();
        let base = inner
            .base
            .lock()
            .clone()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let doc = config::overrides(base, &self.overrides());
        let text = serde_json::to_string_pretty(&doc).expect("a JSON value is text") + "\n";
        if written.as_deref() == Some(text.as_str()) {
            return Ok(false);
        }
        let settings = &inner.settings;
        let file = &settings.config_file;
        let (true, Some(dir), Some(name)) = (
            settings.config_file_is_ours(),
            file.parent(),
            file.file_name().and_then(|n| n.to_str()),
        ) else {
            return Err(ServerError::Failed(
                "OpenCode's config path is not Writer's".into(),
            ));
        };
        std::fs::create_dir_all(dir).map_err(|_| {
            ServerError::Failed("OpenCode's config folder could not be made".into())
        })?;
        crate::plugins::write_atomic_private(dir, name, text.as_bytes(), 0o600)
            .map_err(|_| ServerError::Failed("OpenCode's config could not be written".into()))?;
        *inner.expect.lock() = Expectation::of(&doc);
        // a server that is up has read the old file
        if reload == Reload::WhenIdle && self.connection().is_some() {
            let me = Arc::clone(inner);
            let done = inner
                .io
                .call(async move { reload_when_idle(&me).await }, LONG);
            if !matches!(done, Some(Ok(()))) {
                return Err(ServerError::Failed(
                    "OpenCode did not read its new configuration".into(),
                ));
            }
        }
        *written = Some(text);
        Ok(true)
    }

    /// Server names the config documents or the server's own list gave (raw): placeholders and
    /// allows follow at the next write.
    pub fn learn_mcp(&self, names: impl IntoIterator<Item = String>) {
        self.inner.learned.lock().mcp.extend(
            names
                .into_iter()
                .filter(|n| n != crate::cli::mcp::SERVER_NAME),
        );
    }

    /// Agents that are not Writer's and are enabled: disabled by name at the next write.
    pub fn learn_agents(&self, ids: impl IntoIterator<Item = String>) {
        self.inner.learned.lock().agents.extend(ids);
    }

    /// Every MCP server name known to the server: the user's config and what it listed.
    pub fn mcp_known(&self) -> Vec<String> {
        self.inner.learned.lock().mcp.iter().cloned().collect()
    }

    /// What the file Writer wrote says must hold of the running server.
    pub fn expectation(&self) -> Expectation {
        self.inner.expect.lock().clone()
    }

    /// Writes the file again when what was learned changed it. `true`: it did, and the server
    /// must read it (see [`OpencodeServer::reload_now`]); the gate does that, nothing runs yet.
    pub fn rewrite(&self) -> Result<bool, ServerError> {
        self.write_config(Reload::None)
    }

    /// Has the server read its config again, now (the gate: no turn of this start has begun). A
    /// failure does not stop the process: the gate's caller does, after its card.
    pub async fn reload_now(&self) -> Result<(), super::client::ApiError> {
        reload(&self.inner, false).await
    }

    /// Whether the user's config is loaded in the server that is up.
    pub fn global_config(&self) -> Option<GlobalConfig> {
        self.connection()?;
        *self.inner.global.lock()
    }

    /// Stops the process without closing the server: the next start is a new one. For a server
    /// the gate found running what Writer did not switch on.
    pub fn stop_process(&self) {
        let _one = self.inner.start_lock.lock();
        if let Some(live) = self.inner.live.lock().take() {
            live.process.stop();
        }
    }

    /// Has the server read its config again, now when no session is executing a turn, else when
    /// the last one ends (the stream's events say so).
    pub async fn reload_when_idle(&self) -> Result<(), super::client::ApiError> {
        reload_when_idle(&self.inner).await
    }

    /// Whether this start of the server was found to run the configuration Writer wrote (the
    /// gate of the transport, once per start).
    pub fn in_force(&self, epoch: u64) -> bool {
        self.inner.in_force.load(Ordering::SeqCst) == epoch
    }

    pub fn mark_in_force(&self, epoch: u64) {
        self.inner.in_force.store(epoch, Ordering::SeqCst);
    }

    /// How long a waiting reload waits for running turns (tests shorten it).
    #[cfg(test)]
    pub fn set_reload_deadline(&self, d: Duration) {
        self.inner
            .reload_deadline_ms
            .store(d.as_millis() as u64, Ordering::SeqCst);
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
        let ids: Vec<String> = {
            let mut r = self.inner.routes.lock();
            let ids = r
                .owner
                .iter()
                .filter(|(_, k)| **k == key)
                .map(|(id, _)| id.clone())
                .collect();
            r.sinks.remove(&key);
            r.owner.retain(|_, k| *k != key);
            ids
        };
        // its turns are not running for anyone to wait for
        let due = {
            let mut g = self.inner.gate.lock();
            for id in &ids {
                g.running.remove(id);
            }
            g.take_due()
        };
        if due {
            let me = Arc::clone(&self.inner);
            self.inner.io.spawn(async move {
                let _ = reload_now(&me).await;
            });
        }
    }

    /// The chat owns this session (or a session below it).
    #[cfg(test)]
    pub fn owns(&self, key: u64, session: &str) -> bool {
        self.inner.routes.lock().owner.get(session) == Some(&key)
    }

    /// How many sessions of this server are executing a turn now (children included): what
    /// turning the feature off would cut short.
    pub fn running_turns(&self) -> usize {
        self.inner.gate.lock().running.len()
    }

    /// Stops the process and the runtime: the window or the vault closed.
    ///
    /// The runtime goes first: the event stream we hold open is what keeps a server from ending
    /// on SIGTERM, and a start that is waiting for the process fails at once. Then the process
    /// gets its signal and, a few seconds later, the kill. Blocks for as long as the process
    /// takes to end: call it off the UI thread (`Servers` does).
    pub fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.io.stop();
        let _one = self.inner.start_lock.lock();
        if let Some(live) = self.inner.live.lock().take() {
            live.process.stop();
        }
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

    /// Counts the turns that are running. `true`: the last one just ended and a reload waits.
    fn track(&self, ev: &WireEvent) -> bool {
        let Some(session) = ev.session_id() else {
            return false;
        };
        if self.untracked.lock().contains(session) {
            return false;
        }
        let mut g = self.gate.lock();
        match ev.kind.as_str() {
            "session.execution.started" => {
                g.running.insert(session.to_string());
            }
            "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted" => {
                g.running.remove(session);
                return g.take_due();
            }
            _ => {}
        }
        false
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
                if let Some(hook) = self.on_models.lock().as_ref() {
                    hook();
                }
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
        // nothing runs in a process that is gone, and the next one reads the file as it is
        *self.gate.lock() = Gate::default();
        self.broadcast(&ChatInput::Down(exit));
    }
}

/// The server's idle-gated reload: now, or recorded for the end of the last running turn.
async fn reload_when_idle(inner: &Arc<Inner>) -> Result<(), super::client::ApiError> {
    {
        let mut g = inner.gate.lock();
        if !g.running.is_empty() {
            if g.reload_pending.is_none() {
                g.next_token += 1;
                let token = g.next_token;
                g.reload_pending = Some(token);
                arm_deadline(inner, token);
            }
            return Ok(());
        }
    }
    reload_now(inner).await
}

/// After the deadline the reload that still waits is made anyway.
fn arm_deadline(inner: &Arc<Inner>, token: u64) {
    let weak = Arc::downgrade(inner);
    let wait = Duration::from_millis(inner.reload_deadline_ms.load(Ordering::SeqCst));
    inner.io.spawn(async move {
        tokio::time::sleep(wait).await;
        let Some(me) = weak.upgrade() else { return };
        let due = {
            let mut g = me.gate.lock();
            let due = g.reload_pending == Some(token);
            if due {
                g.reload_pending = None;
            }
            due
        };
        if due {
            log::warn!("opencode: a turn did not end in time, reading the configuration anyway");
            let _ = reload_now(&me).await;
        }
    });
}

/// The turns that are running as the server says now: after a reconnect the end of a turn may
/// have gone by unseen, so what is counted is replaced by the server's own list (a list that
/// cannot be read counts nothing: a gate that never opens is worse than a reload mid-turn).
async fn rebuild_running(inner: &Arc<Inner>, client: &Client) {
    let active: std::collections::HashSet<String> = client
        .get(&api::SESSIONS_ACTIVE, &[])
        .await
        .ok()
        .and_then(|v| v["data"].as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default();
    let due = {
        let mut g = inner.gate.lock();
        g.running = active;
        g.take_due()
    };
    if due {
        let _ = reload_now(inner).await;
    }
}

/// The server reads its config again. A reload that fails leaves the process on the old file; with
/// `stop_on_failure` it is stopped (only the process that failed, never a newer one) so the next
/// start reads the file. The gate passes `false`: its caller sends the refusal card first and
/// stops after it.
async fn reload_now(inner: &Arc<Inner>) -> Result<(), super::client::ApiError> {
    reload(inner, true).await
}

async fn reload(inner: &Arc<Inner>, stop_on_failure: bool) -> Result<(), super::client::ApiError> {
    let live = inner
        .live
        .lock()
        .as_ref()
        .map(|l| (l.client.clone(), Arc::clone(&l.process)));
    let Some((client, process)) = live else {
        return Ok(());
    };
    if let Err(e) = client.request(&api::RELOAD, &[], &[], None, LONG).await {
        log::warn!(target: "opencode", "opencode: the server did not read its configuration again");
        if stop_on_failure {
            // the file on disk is not what the process runs: the one lever is to stop it
            // (stopping waits for the process: never on the runtime's thread)
            let me = Arc::clone(inner);
            drop(tokio::task::spawn_blocking(move || {
                let mut live = me.live.lock();
                if live
                    .as_ref()
                    .is_some_and(|l| Arc::ptr_eq(&l.process, &process))
                {
                    live.take();
                    drop(live);
                    process.stop();
                }
            }));
        }
        return Err(e);
    }
    inner.broadcast(&ChatInput::Reloaded);
    Ok(())
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
                    rebuild_running(&inner_arc, &client).await;
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
                        let due = inner_arc.track(&ev);
                        inner_arc.dispatch(ev);
                        if due {
                            // the last turn ended: the reload that waited for it goes now, off
                            // the stream's own task
                            let me = Arc::clone(&inner_arc);
                            inner_arc.io.spawn(async move {
                                let _ = reload_now(&me).await;
                            });
                        }
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
