// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Process spawn for plugins that shell out (obsidian-copilot's Agent Mode,
//! `child_process`, Claude Code sessions). Desktop only, high risk, so every
//! start is gated:
//!  - the vault must be trusted (checked by the command layer, and again after
//!    the consent dialog returns, since the user may have revoked trust or
//!    switched vault while it was open);
//!  - the user is asked through a native dialog (see `Consent`) that shows the
//!    plugin id, the resolved program, all arguments, the cwd and env var
//!    names. The answer is "Run once", "Always allow this program in this
//!    vault" (remembered per vault, plugin and resolved program path in
//!    `ConsentStore`) or "Deny". A remembered program skips the dialog, but
//!    the command layer still tells the window about every spawn;
//!  - the cwd (default: the vault root) must be inside the workspace root;
//!  - at most `MAX_PROCS` live processes app-wide;
//!  - a window's processes die with the window, and a vault's die when its
//!    trust is revoked or the window leaves that vault (`kill_window` /
//!    `kill_root`). On unix each child leads its own process group and the
//!    whole group is signalled, so grandchildren go too.
//!
//! Events: `spawn{pid}` first, then `stdout`/`stderr` chunks, then exactly one
//! terminal event, always last: `exit{code,signal}` (after BOTH pipes drained,
//! like Node's `close`) or `error{code,message}` when the program could not be
//! started (no exit follows).
//!
//! Differences from opensidian's `desk_proc.rs`: bytes cross IPC as base64
//! (not latin1), output is delivered as events instead of polled buffers, and
//! the consent is a trait so the dialog is the only part that is not unit
//! tested.

use crate::plugin_consent::ConsentStore;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const MAX_PROCS: usize = 8;
pub const ENV_MAX_VARS: usize = 64;
pub const ENV_MAX_BYTES: usize = 16 * 1024;
/// program + args + cwd, bytes
pub const RUN_MAX_BYTES: usize = 64 * 1024;
pub const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;
const READ_CHUNK: usize = 32 * 1024;
/// After the child exits, how long to wait for its pipes to hit EOF. Only a
/// grandchild that inherited the pipe and outlives the child can reach it.
const DRAIN_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StdinMode {
    #[default]
    Pipe,
    Ignore,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpawnRequest {
    /// Shown in the consent dialog; must be a well-formed plugin id.
    pub plugin_id: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    /// Must be inside the workspace root. Default: the root.
    pub cwd: Option<String>,
    /// Laid over the app's own environment (or over nothing, see `inherit_env`).
    pub env: Option<HashMap<String, String>>,
    /// Default pipe.
    pub stdin: Option<StdinMode>,
    /// Default true: the child gets the app's real environment.
    pub inherit_env: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProcEvent {
    /// First event, after a successful exec.
    Spawn {
        pid: u32,
    },
    Stdout {
        data_base64: String,
    },
    Stderr {
        data_base64: String,
    },
    /// Terminal. `code` is None when killed by a signal (`signal` is then its
    /// name, e.g. "SIGTERM", on unix).
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
    /// Terminal: the program could not be started (or its status not read).
    /// `code` is one of ENOENT, EACCES, EPERM, UNKNOWN. No `exit` follows.
    Error {
        code: String,
        message: String,
    },
}

/// Returns false once the receiver is gone.
pub type Emit = Arc<dyn Fn(ProcEvent) -> bool + Send + Sync>;

/// What the user is asked to approve. Built from Rust-side, resolved values.
#[derive(Debug, Clone)]
pub struct ConsentRequest {
    pub plugin_id: String,
    pub vault: PathBuf,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env_keys: Vec<String>,
    pub inherit_env: bool,
}

impl ConsentRequest {
    /// The dialog body. Every page-supplied value is Debug-quoted so a newline
    /// cannot fake a line of the dialog, and nothing is truncated.
    pub fn message(&self) -> String {
        let mut cmd = format!("{:?}", self.program.to_string_lossy());
        for a in &self.args {
            cmd.push(' ');
            cmd.push_str(&format!("{a:?}"));
        }
        let env = if self.env_keys.is_empty() {
            "(none)".to_string()
        } else {
            self.env_keys.join(", ")
        };
        let inherit = if self.inherit_env {
            "Writer's own environment is passed on."
        } else {
            "Writer's own environment is NOT passed on."
        };
        format!(
            "The plugin {:?} wants to run a program on this computer.\n\n\
             Command:\n{cmd}\n\n\
             Working directory:\n{:?}\n\n\
             Extra environment variables: {env}\n{inherit}\n\n\
             Vault: {:?}\n\n\
             Only allow this if you trust the plugin and recognise the command. \
             The program runs with your own permissions. \"Always allow\" \
             remembers this program (any arguments) for this plugin in this vault.",
            self.plugin_id,
            self.cwd.to_string_lossy(),
            self.vault.to_string_lossy(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Once,
    Always,
    Deny,
}

/// The user's answer. Production: a native dialog. Tests: a double.
pub trait Consent: Send + Sync {
    fn ask(&self, req: &ConsentRequest) -> Decision;
}

/// A validated, resolved spawn.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub stdin_pipe: bool,
    pub inherit_env: bool,
}

/// Validate a request. `cwd` is already authorized and confined by the caller.
pub fn prepare(req: &SpawnRequest, cwd: PathBuf) -> Result<Prepared, String> {
    if !crate::plugins::valid_id(&req.plugin_id) {
        return Err("refused: bad plugin id".into());
    }
    let args = req.args.clone().unwrap_or_default();
    let has_nul = |s: &str| s.contains('\0');
    if req.command.trim().is_empty() || has_nul(&req.command) || args.iter().any(|a| has_nul(a)) {
        return Err("refused: empty command or NUL byte in command line".into());
    }
    let size =
        req.command.len() + args.iter().map(|a| a.len() + 1).sum::<usize>() + cwd.as_os_str().len();
    if size > RUN_MAX_BYTES {
        return Err("refused: command line too large".into());
    }
    let mut env = Vec::new();
    let mut bytes = 0;
    for (k, v) in req.env.iter().flatten() {
        if k.is_empty() || k.contains(['=', '\0']) || v.contains('\0') {
            return Err(format!("refused: bad environment variable {k:?}"));
        }
        bytes += k.len() + v.len() + 2;
        env.push((k.clone(), v.clone()));
    }
    if env.len() > ENV_MAX_VARS || bytes > ENV_MAX_BYTES {
        return Err("refused: environment too large".into());
    }
    env.sort();
    let path_override = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str());
    let program = resolve_program(&req.command, &cwd, path_override)?;
    Ok(Prepared {
        program,
        args,
        cwd,
        env,
        stdin_pipe: req.stdin.unwrap_or_default() == StdinMode::Pipe,
        inherit_env: req.inherit_env.unwrap_or(true),
    })
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// The absolute program that will be exec'd, so the dialog shows exactly that.
/// A bare name is looked up in the request's PATH, else the app's PATH plus
/// the well-known install dirs (a Finder-launched app has a minimal PATH).
fn resolve_program(command: &str, cwd: &Path, path_env: Option<&str>) -> Result<PathBuf, String> {
    let found = if command.contains(['/', '\\']) {
        let p = Path::new(command);
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        };
        is_executable(&p).then_some(p)
    } else {
        let dirs: Vec<PathBuf> = match path_env {
            Some(p) => std::env::split_paths(p).collect(),
            None => crate::plugin_env::search_dirs(
                "",
                &std::env::var("PATH").unwrap_or_default(),
                crate::plugin_env::home_dir().as_deref(),
            ),
        };
        dirs.into_iter()
            .filter(|d| d.is_absolute())
            .map(|d| d.join(command))
            .find(|c| is_executable(c))
    };
    let found = found.ok_or_else(|| format!("ENOENT: program {command:?} not found"))?;
    found.canonicalize().map_err(|e| format!("ENOENT: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
    Int,
    Hup,
}

impl Sig {
    pub fn parse(s: &str) -> Result<Sig, String> {
        match s {
            "SIGTERM" => Ok(Sig::Term),
            "SIGKILL" => Ok(Sig::Kill),
            "SIGINT" => Ok(Sig::Int),
            "SIGHUP" => Ok(Sig::Hup),
            other => Err(format!("EINVAL: unsupported signal {other:?}")),
        }
    }
}

fn error_event(e: &std::io::Error) -> ProcEvent {
    use std::io::ErrorKind::*;
    let code = match (e.kind(), e.raw_os_error()) {
        (NotFound, _) => "ENOENT",
        (PermissionDenied, _) => "EACCES",
        (_, Some(1)) => "EPERM",
        _ => "UNKNOWN",
    };
    ProcEvent::Error {
        code: code.into(),
        message: e.to_string(),
    }
}

struct Proc {
    label: String,
    root: PathBuf,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Default)]
pub struct ProcManager {
    next: AtomicU64,
    procs: Arc<Mutex<HashMap<u64, Proc>>>,
}

impl ProcManager {
    pub fn active(&self) -> usize {
        self.procs.lock().len()
    }

    pub fn has_capacity(&self) -> bool {
        self.active() < MAX_PROCS
    }

    /// A process id for a spawn that never got off the ground: the terminal
    /// `error` event is delivered through `emit` and nothing is registered.
    pub fn fail(&self, emit: &Emit, code: &str, message: String) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        emit(ProcEvent::Error {
            code: code.into(),
            message,
        });
        id
    }

    /// The full gated start: capacity, consent (or a remembered "always"),
    /// trust re-check, then spawn. `still_ok` is asked again after the dialog
    /// returns (trust revoked or vault switched meanwhile = refuse).
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_with_consent(
        &self,
        consent: &dyn Consent,
        store: &ConsentStore,
        label: &str,
        root: &Path,
        plugin_id: &str,
        p: &Prepared,
        still_ok: &dyn Fn() -> bool,
        emit: Emit,
    ) -> Result<u64, String> {
        if !self.has_capacity() {
            return Err(format!("EBUSY: {MAX_PROCS} processes are already running"));
        }
        if !store.is_allowed(root, plugin_id, &p.program) {
            let ask = ConsentRequest {
                plugin_id: plugin_id.to_string(),
                vault: root.to_path_buf(),
                program: p.program.clone(),
                args: p.args.clone(),
                cwd: p.cwd.clone(),
                env_keys: p.env.iter().map(|(k, _)| k.clone()).collect(),
                inherit_env: p.inherit_env,
            };
            match consent.ask(&ask) {
                Decision::Deny => return Err("EACCES: the user denied this program".into()),
                Decision::Once => {}
                Decision::Always => {
                    if !still_ok() {
                        return Err("EACCES: trust or vault changed while asking".into());
                    }
                    if let Err(e) = store.allow(root, plugin_id, &p.program) {
                        log::warn!("plugin consent not remembered: {e}");
                    }
                }
            }
        }
        if !still_ok() {
            return Err("EACCES: trust or vault changed while asking".into());
        }
        self.spawn(label, root, p, emit)
    }

    /// Spawn WITHOUT asking: callers must have obtained consent. Private to
    /// the module family on purpose. An exec failure is NOT an `Err`: it is
    /// delivered as the terminal `error` event of the returned id.
    fn spawn(&self, label: &str, root: &Path, p: &Prepared, emit: Emit) -> Result<u64, String> {
        let mut procs = self.procs.lock();
        if procs.len() >= MAX_PROCS {
            return Err(format!("EBUSY: {MAX_PROCS} processes are already running"));
        }
        let mut cmd = Command::new(&p.program);
        if !p.inherit_env {
            cmd.env_clear();
        }
        cmd.args(&p.args)
            .current_dir(&p.cwd)
            .envs(p.env.iter().map(|(k, v)| (k, v)))
            .stdin(if p.stdin_pipe {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                drop(procs);
                emit(error_event(&e));
                return Ok(id);
            }
        };
        let pid = child.id();
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let out = child.stdout.take();
        let err = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        procs.insert(
            id,
            Proc {
                label: label.to_string(),
                root: root.to_path_buf(),
                stdin: Arc::clone(&stdin),
                child: Arc::clone(&child),
            },
        );
        drop(procs);
        emit(ProcEvent::Spawn { pid });

        let pump = |stream: Option<Box<dyn Read + Send>>, stderr: bool| {
            let emit = Arc::clone(&emit);
            std::thread::spawn(move || {
                let Some(mut s) = stream else { return };
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            let data_base64 =
                                base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            let ev = if stderr {
                                ProcEvent::Stderr { data_base64 }
                            } else {
                                ProcEvent::Stdout { data_base64 }
                            };
                            if !emit(ev) {
                                return;
                            }
                        }
                    }
                }
            })
        };
        let t_out = pump(out.map(|s| Box::new(s) as Box<dyn Read + Send>), false);
        let t_err = pump(err.map(|s| Box::new(s) as Box<dyn Read + Send>), true);

        let registry = Arc::clone(&self.procs);
        std::thread::spawn(move || {
            let status = loop {
                match child.lock().try_wait() {
                    Ok(Some(s)) => break Ok(s),
                    Ok(None) => {}
                    Err(e) => break Err(e),
                }
                std::thread::sleep(Duration::from_millis(15));
            };
            // Both pipes to EOF first, then the one terminal event, so a
            // consumer sees every byte (Node's 'close'). A killed group closes
            // its pipes; a grandchild that kept them open past a natural exit
            // is waited for only up to `DRAIN_GRACE`.
            let deadline = std::time::Instant::now() + DRAIN_GRACE;
            for t in [t_out, t_err] {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                let _ = join_with_timeout(t, left);
            }
            registry.lock().remove(&id);
            match status {
                Ok(s) => emit(ProcEvent::Exit {
                    code: s.code(),
                    signal: exit_signal(&s).map(signal_name),
                }),
                Err(e) => emit(ProcEvent::Error {
                    code: "UNKNOWN".into(),
                    message: format!("wait failed: {e}"),
                }),
            };
        });
        Ok(id)
    }

    fn with_proc<T>(&self, label: &str, id: u64, f: impl FnOnce(&Proc) -> T) -> Result<T, String> {
        let procs = self.procs.lock();
        match procs.get(&id) {
            Some(p) if p.label == label => Ok(f(p)),
            _ => Err("ESRCH: no such process".into()),
        }
    }

    /// Write to stdin. Blocks while the pipe is full: call off the async pool.
    pub fn write(&self, label: &str, id: u64, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err("E2BIG: write over the 8 MiB cap".into());
        }
        let stdin = self.with_proc(label, id, |p| Arc::clone(&p.stdin))?;
        let mut g = stdin.lock();
        let w = g.as_mut().ok_or("EPIPE: stdin is closed")?;
        w.write_all(data)
            .and_then(|_| w.flush())
            .map_err(|e| format!("EPIPE: {e}"))
    }

    pub fn close_stdin(&self, label: &str, id: u64) -> Result<(), String> {
        let stdin = self.with_proc(label, id, |p| Arc::clone(&p.stdin))?;
        stdin.lock().take();
        Ok(())
    }

    fn signal_proc(p: &Proc, sig: Sig, group: bool) {
        let mut child = p.child.lock();
        // Only signal a child that has not been reaped: its pid is still ours.
        if matches!(child.try_wait(), Ok(None)) {
            send_signal(&mut child, sig, group);
        }
    }

    /// Signal one process (its whole group when `group`). The terminal event
    /// follows once it is gone. Unsupported signals are rejected before this.
    pub fn kill(&self, label: &str, id: u64, sig: Sig, group: bool) -> Result<(), String> {
        self.with_proc(label, id, |p| Self::signal_proc(p, sig, group))
    }

    pub fn kill_window(&self, label: &str) {
        self.kill_where(|p| p.label == label);
    }

    /// Trust revoked or the vault was left: kill everything that vault spawned.
    pub fn kill_root(&self, root: &Path) {
        self.kill_where(|p| p.root == root);
    }

    pub fn kill_all(&self) {
        self.kill_where(|_| true);
    }

    fn kill_where(&self, pred: impl Fn(&Proc) -> bool) {
        for p in self.procs.lock().values().filter(|p| pred(p)) {
            Self::signal_proc(p, Sig::Kill, true);
        }
    }
}

fn join_with_timeout(t: std::thread::JoinHandle<()>, limit: Duration) -> bool {
    let start = std::time::Instant::now();
    while !t.is_finished() {
        if start.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = t.join();
    true
}

#[cfg(unix)]
fn send_signal(child: &mut Child, sig: Sig, group: bool) {
    let signo = match sig {
        Sig::Term => libc::SIGTERM,
        Sig::Kill => libc::SIGKILL,
        Sig::Int => libc::SIGINT,
        Sig::Hup => libc::SIGHUP,
    };
    // `process_group(0)` made the child its own group leader: pgid == pid.
    let pid = child.id() as i32;
    unsafe {
        libc::kill(if group { -pid } else { pid }, signo);
    }
    if sig == Sig::Kill {
        let _ = child.kill();
    }
}

#[cfg(not(unix))]
fn send_signal(child: &mut Child, _sig: Sig, _group: bool) {
    let _ = child.kill();
}

#[cfg(unix)]
fn exit_signal(s: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    s.signal()
}

#[cfg(not(unix))]
fn exit_signal(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// POSIX signal number -> name ("SIGTERM"), as Node reports `signal`.
fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("SIG{n}"),
    }
    .to_string()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    struct Double {
        decision: Mutex<Decision>,
        asked: AtomicUsize,
        last: Mutex<Option<ConsentRequest>>,
    }

    impl Double {
        fn new(allow: bool) -> Self {
            Self::with(if allow {
                Decision::Once
            } else {
                Decision::Deny
            })
        }

        fn with(d: Decision) -> Self {
            Self {
                decision: Mutex::new(d),
                asked: AtomicUsize::new(0),
                last: Mutex::new(None),
            }
        }
    }

    impl Consent for Double {
        fn ask(&self, req: &ConsentRequest) -> Decision {
            self.asked.fetch_add(1, Ordering::SeqCst);
            *self.last.lock() = Some(req.clone());
            *self.decision.lock()
        }
    }

    fn req(command: &str, args: &[&str]) -> SpawnRequest {
        SpawnRequest {
            plugin_id: "copilot".into(),
            command: command.into(),
            args: Some(args.iter().map(|s| s.to_string()).collect()),
            cwd: None,
            env: None,
            stdin: None,
            inherit_env: None,
        }
    }

    fn events() -> (Emit, mpsc::Receiver<ProcEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (Arc::new(move |ev| tx.lock().send(ev).is_ok()), rx)
    }

    fn store(dir: &Path) -> ConsentStore {
        ConsentStore::new(dir.join("consent.json"))
    }

    fn b64(s: &str) -> String {
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap()
    }

    /// (pid from the spawn ack, stdout, stderr, terminal event). Asserts the
    /// spawn ack came first and that nothing follows the terminal event.
    fn run_collect(rx: &mpsc::Receiver<ProcEvent>) -> (u32, String, String, ProcEvent) {
        let (mut out, mut err) = (String::new(), String::new());
        let ProcEvent::Spawn { pid } = rx.recv_timeout(Duration::from_secs(10)).unwrap() else {
            panic!("first event must be spawn")
        };
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                ProcEvent::Spawn { .. } => panic!("second spawn event"),
                ProcEvent::Stdout { data_base64 } => out.push_str(&b64(&data_base64)),
                ProcEvent::Stderr { data_base64 } => err.push_str(&b64(&data_base64)),
                t @ (ProcEvent::Exit { .. } | ProcEvent::Error { .. }) => {
                    assert!(
                        rx.recv_timeout(Duration::from_millis(150)).is_err(),
                        "nothing may follow the terminal event"
                    );
                    return (pid, out, err, t);
                }
            }
        }
    }

    fn go(
        m: &ProcManager,
        c: &Double,
        label: &str,
        root: &Path,
        r: &SpawnRequest,
        emit: Emit,
    ) -> Result<u64, String> {
        let p = prepare(r, root.to_path_buf())?;
        m.spawn_with_consent(
            c,
            &store(root),
            label,
            root,
            &r.plugin_id,
            &p,
            &|| true,
            emit,
        )
    }

    fn wait_idle(m: &ProcManager) {
        for _ in 0..100 {
            if m.active() == 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("processes still registered");
    }

    #[test]
    fn spawn_streams_output_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        let mut r = req(
            "sh",
            &["-c", "echo out; echo err >&2; echo $FOO; pwd; exit 3"],
        );
        r.env = Some(HashMap::from([("FOO".to_string(), "bar".to_string())]));
        go(&m, &c, "w", &root, &r, emit).unwrap();
        let (_, out, err, exit) = run_collect(&rx);
        // cwd defaults to what the command layer passes: the vault root
        assert_eq!(out, format!("out\nbar\n{}\n", root.display()));
        assert_eq!(err, "err\n");
        assert_eq!(
            exit,
            ProcEvent::Exit {
                code: Some(3),
                signal: None
            }
        );
        assert_eq!(c.asked.load(Ordering::SeqCst), 1);
        let shown = c.last.lock().clone().unwrap().message();
        assert!(shown.contains("\"copilot\"") && shown.contains("echo out"));
        assert!(shown.contains("FOO") && !shown.contains("bar\n\nVault"));
        wait_idle(&m);
    }

    #[test]
    fn spawn_ack_carries_the_real_pid() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        go(
            &m,
            &c,
            "w",
            dir.path(),
            &req("sh", &["-c", "echo $$"]),
            emit,
        )
        .unwrap();
        let (pid, out, _, _) = run_collect(&rx);
        assert_eq!(out.trim().parse::<u32>().unwrap(), pid);
    }

    #[test]
    fn exec_failure_is_a_terminal_error_event() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let m = ProcManager::default();
        let c = Double::new(true);
        let prep = |program: PathBuf| Prepared {
            program,
            args: vec![],
            cwd: root.clone(),
            env: vec![],
            stdin_pipe: true,
            inherit_env: true,
        };
        // ENOENT (resolution succeeded earlier, the file vanished) and EACCES
        let plain = root.join("plain");
        std::fs::write(&plain, "x").unwrap();
        for (program, want) in [(root.join("gone"), "ENOENT"), (plain, "EACCES")] {
            let (emit, rx) = events();
            let id = m
                .spawn_with_consent(
                    &c,
                    &store(&root),
                    "w",
                    &root,
                    "copilot",
                    &prep(program),
                    &|| true,
                    emit,
                )
                .unwrap();
            assert!(id > 0);
            let ProcEvent::Error { code, message } =
                rx.recv_timeout(Duration::from_secs(5)).unwrap()
            else {
                panic!("expected error event")
            };
            assert_eq!(code, want);
            assert!(!message.is_empty());
            assert!(
                rx.recv_timeout(Duration::from_millis(200)).is_err(),
                "no exit after an error"
            );
            assert_eq!(m.active(), 0);
        }
        let (emit, rx) = events();
        let id = m.fail(&emit, "ENOENT", "nope".into());
        assert!(id > 0);
        assert!(matches!(rx.try_recv().unwrap(), ProcEvent::Error { .. }));
    }

    #[test]
    fn exit_reports_signal_name() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        go(
            &m,
            &c,
            "w",
            dir.path(),
            &req("sh", &["-c", "kill -TERM $$; sleep 5"]),
            emit,
        )
        .unwrap();
        let (_, _, _, exit) = run_collect(&rx);
        assert_eq!(
            exit,
            ProcEvent::Exit {
                code: None,
                signal: Some("SIGTERM".into())
            }
        );
        assert_eq!(signal_name(9), "SIGKILL");
        assert_eq!(signal_name(2), "SIGINT");
        assert_eq!(signal_name(1), "SIGHUP");
        assert_eq!(signal_name(99), "SIG99");
    }

    #[test]
    fn exit_comes_after_all_output_is_drained() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        for _ in 0..3 {
            let (emit, rx) = events();
            // ~6 MB on stdout and ~3 MB on stderr, then an immediate exit
            go(
                &m,
                &c,
                "w",
                dir.path(),
                &req(
                    "sh",
                    &[
                        "-c",
                        "head -c 6000000 /dev/zero | tr '\\0' a; head -c 3000000 /dev/zero | tr '\\0' b >&2; exit 0",
                    ],
                ),
                emit,
            )
            .unwrap();
            let (_, out, err, exit) = run_collect(&rx);
            assert_eq!(out.len(), 6_000_000);
            assert_eq!(err.len(), 3_000_000);
            assert!(matches!(exit, ProcEvent::Exit { code: Some(0), .. }));
        }
    }

    #[test]
    fn inherit_env_true_and_false() {
        std::env::set_var("WRITER_PROC_TEST_INHERIT", "from-app");
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let run = |inherit: Option<bool>| {
            let (emit, rx) = events();
            let mut r = req("/usr/bin/env", &[]);
            r.env = Some(HashMap::from([("FOO".to_string(), "bar".to_string())]));
            r.inherit_env = inherit;
            go(&m, &c, "w", dir.path(), &r, emit).unwrap();
            run_collect(&rx).1
        };
        for inherit in [None, Some(true)] {
            let out = run(inherit);
            assert!(out.contains("WRITER_PROC_TEST_INHERIT=from-app"), "{out}");
            assert!(out.contains("FOO=bar"));
            assert!(out.contains("HOME="), "real app environment");
        }
        let out = run(Some(false));
        assert!(!out.contains("WRITER_PROC_TEST_INHERIT"), "{out}");
        assert!(!out.contains("HOME="));
        assert!(out.contains("FOO=bar"), "request env is still applied");
        let shown = c.last.lock().clone().unwrap();
        assert!(!shown.inherit_env && shown.message().contains("NOT passed"));
    }

    #[test]
    fn stdin_ignore_gives_eof_and_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        let mut r = req("cat", &[]);
        r.stdin = Some(StdinMode::Ignore);
        let id = go(&m, &c, "w", dir.path(), &r, emit).unwrap();
        assert!(m.write("w", id, b"x").is_err());
        let (_, out, _, exit) = run_collect(&rx);
        assert_eq!(out, "");
        assert!(matches!(exit, ProcEvent::Exit { code: Some(0), .. }));
    }

    #[test]
    fn denied_consent_forks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let m = ProcManager::default();
        let c = Double::new(false);
        let (emit, _rx) = events();
        let r = req("touch", &[marker.to_str().unwrap()]);
        let err = go(&m, &c, "w", dir.path(), &r, emit).unwrap_err();
        assert!(err.starts_with("EACCES"));
        assert_eq!(c.asked.load(Ordering::SeqCst), 1);
        std::thread::sleep(Duration::from_millis(200));
        assert!(!marker.exists());
        assert_eq!(m.active(), 0);
    }

    #[test]
    fn run_once_asks_every_time() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        for _ in 0..3 {
            let (emit, rx) = events();
            go(&m, &c, "w", dir.path(), &req("true", &[]), emit).unwrap();
            run_collect(&rx);
        }
        assert_eq!(c.asked.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn always_is_remembered_per_program_then_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let st = store(&root);
        let m = ProcManager::default();
        let c = Double::with(Decision::Always);
        let run = |cmd: &str, args: &[&str], plugin: &str| {
            let (emit, rx) = events();
            let mut r = req(cmd, args);
            r.plugin_id = plugin.into();
            let p = prepare(&r, root.clone()).unwrap();
            m.spawn_with_consent(&c, &st, "w", &root, plugin, &p, &|| true, emit)
                .unwrap();
            run_collect(&rx);
            p.program
        };
        let sh = run("sh", &["-c", "true"], "copilot");
        assert_eq!(c.asked.load(Ordering::SeqCst), 1);
        // same program, different args: no dialog
        run("sh", &["-c", "echo other args"], "copilot");
        assert_eq!(c.asked.load(Ordering::SeqCst), 1);
        // another plugin, another program: asked
        run("sh", &["-c", "true"], "other-plugin");
        run("true", &[], "copilot");
        assert_eq!(c.asked.load(Ordering::SeqCst), 3);
        st.revoke(&root, "copilot", &sh.to_string_lossy()).unwrap();
        run("sh", &["-c", "true"], "copilot");
        assert_eq!(c.asked.load(Ordering::SeqCst), 4);
        // trust revoke path: clear the vault, everything is asked again
        st.clear_vault(&root).unwrap();
        run("true", &[], "copilot");
        assert_eq!(c.asked.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn always_is_not_persisted_when_trust_vanished() {
        let dir = tempfile::tempdir().unwrap();
        let st = store(dir.path());
        let m = ProcManager::default();
        let c = Double::with(Decision::Always);
        let (emit, _rx) = events();
        let p = prepare(&req("true", &[]), dir.path().to_path_buf()).unwrap();
        let err = m
            .spawn_with_consent(&c, &st, "w", dir.path(), "copilot", &p, &|| false, emit)
            .unwrap_err();
        assert!(err.starts_with("EACCES"));
        assert!(st.list(dir.path()).is_empty());
    }

    #[test]
    fn trust_revoked_during_dialog_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, _rx) = events();
        let r = req("true", &[]);
        let p = prepare(&r, dir.path().to_path_buf()).unwrap();
        let err = m
            .spawn_with_consent(
                &c,
                &store(dir.path()),
                "w",
                dir.path(),
                "copilot",
                &p,
                &|| false,
                emit,
            )
            .unwrap_err();
        assert!(err.starts_with("EACCES"));
        assert_eq!(m.active(), 0);
    }

    #[test]
    fn stdin_roundtrip_and_close() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        let id = go(&m, &c, "w", dir.path(), &req("cat", &[]), emit).unwrap();
        assert!(m.write("other", id, b"x").is_err(), "foreign window");
        m.write("w", id, b"hello\n").unwrap();
        m.close_stdin("w", id).unwrap();
        assert!(m.write("w", id, b"more").is_err());
        let (_, out, _, exit) = run_collect(&rx);
        assert_eq!(out, "hello\n");
        assert_eq!(
            exit,
            ProcEvent::Exit {
                code: Some(0),
                signal: None
            }
        );
    }

    /// A shell that forks a grandchild, prints its pid, and waits.
    fn spawn_with_grandchild(m: &ProcManager, dir: &Path) -> (u64, i32, mpsc::Receiver<ProcEvent>) {
        let c = Double::new(true);
        let (emit, rx) = events();
        let id = go(
            m,
            &c,
            "w",
            dir,
            &req("sh", &["-c", "sleep 300 & echo $!; wait"]),
            emit,
        )
        .unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            ProcEvent::Spawn { .. }
        ));
        let ProcEvent::Stdout { data_base64 } = rx.recv_timeout(Duration::from_secs(5)).unwrap()
        else {
            panic!("expected pid")
        };
        (id, b64(&data_base64).trim().parse().unwrap(), rx)
    }

    fn gone(pid: i32) -> bool {
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn wait_exit(rx: &mpsc::Receiver<ProcEvent>) -> ProcEvent {
        loop {
            let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if matches!(e, ProcEvent::Exit { .. } | ProcEvent::Error { .. }) {
                return e;
            }
        }
    }

    #[test]
    fn kill_reaches_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let (id, pid, rx) = spawn_with_grandchild(&m, dir.path());
        assert!(
            m.kill("other", id, Sig::Kill, true).is_err(),
            "foreign window cannot kill"
        );
        m.kill("w", id, Sig::Kill, true).unwrap();
        assert_eq!(
            wait_exit(&rx),
            ProcEvent::Exit {
                code: None,
                signal: Some("SIGKILL".into())
            }
        );
        assert!(gone(pid), "grandchild {pid} survived");
    }

    #[test]
    fn sigterm_group_kill_reaps_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let (id, pid, rx) = spawn_with_grandchild(&m, dir.path());
        m.kill("w", id, Sig::Term, true).unwrap();
        assert_eq!(
            wait_exit(&rx),
            ProcEvent::Exit {
                code: None,
                signal: Some("SIGTERM".into())
            }
        );
        assert!(gone(pid), "grandchild {pid} survived SIGTERM to the group");
    }

    #[test]
    fn non_group_kill_spares_the_grandchild() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let (id, pid, rx) = spawn_with_grandchild(&m, dir.path());
        m.kill("w", id, Sig::Term, false).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "grandchild still alive");
        // it holds the pipes open, so the terminal event waits for it
        unsafe { libc::kill(pid, libc::SIGKILL) };
        wait_exit(&rx);
        assert!(Sig::parse("SIGUSR1").is_err());
        assert_eq!(Sig::parse("SIGINT"), Ok(Sig::Int));
    }

    #[test]
    fn concurrency_cap_and_sweeps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let m = ProcManager::default();
        let c = Double::new(true);
        let mut rxs = Vec::new();
        for i in 0..MAX_PROCS {
            let (emit, rx) = events();
            let label = if i % 2 == 0 { "a" } else { "b" };
            go(&m, &c, label, &root, &req("sleep", &["300"]), emit).unwrap();
            rxs.push(rx);
        }
        assert_eq!(m.active(), MAX_PROCS);
        let (emit, _rx) = events();
        let asked = c.asked.load(Ordering::SeqCst);
        let err = go(&m, &c, "a", &root, &req("sleep", &["1"]), emit).unwrap_err();
        assert!(err.starts_with("EBUSY"));
        assert_eq!(c.asked.load(Ordering::SeqCst), asked, "no prompt when full");

        m.kill_window("a");
        for rx in rxs.iter().step_by(2) {
            assert!(matches!(wait_exit(rx), ProcEvent::Exit { .. }));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(m.active(), MAX_PROCS / 2);
        m.kill_root(&root);
        for rx in rxs.iter().skip(1).step_by(2) {
            assert!(matches!(wait_exit(rx), ProcEvent::Exit { .. }));
        }
        wait_idle(&m);
    }

    #[test]
    fn prepare_rejects_bad_requests() {
        let cwd = std::env::temp_dir();
        assert!(prepare(&req("", &[]), cwd.clone()).is_err());
        assert!(prepare(&req("sh\0", &[]), cwd.clone()).is_err());
        assert!(
            prepare(&req("definitely-not-a-program-xyz", &[]), cwd.clone())
                .unwrap_err()
                .starts_with("ENOENT")
        );
        let mut r = req("true", &[]);
        r.plugin_id = "../evil".into();
        assert!(prepare(&r, cwd.clone()).is_err());
        let mut r = req("true", &[]);
        r.env = Some(HashMap::from([("A=B".to_string(), "x".to_string())]));
        assert!(prepare(&r, cwd.clone()).is_err());
        let mut r = req("true", &[]);
        r.env = Some(
            (0..=ENV_MAX_VARS)
                .map(|i| (format!("K{i}"), "v".to_string()))
                .collect(),
        );
        assert!(prepare(&r, cwd.clone()).is_err());
        let big = "a".repeat(RUN_MAX_BYTES);
        assert!(prepare(&req("true", &[&big]), cwd.clone()).is_err());
        // a bare name resolves to an absolute path
        let p = prepare(&req("sh", &[]), cwd).unwrap();
        assert!(p.program.is_absolute() && p.stdin_pipe && p.inherit_env);
    }

    #[test]
    fn request_deserializes_new_fields() {
        let r: SpawnRequest = serde_json::from_str(
            r#"{"plugin_id":"p","command":"x","stdin":"ignore","inherit_env":false}"#,
        )
        .unwrap();
        assert_eq!(r.stdin, Some(StdinMode::Ignore));
        assert_eq!(r.inherit_env, Some(false));
        assert!(r.cwd.is_none());
        let ev = serde_json::to_value(ProcEvent::Exit {
            code: None,
            signal: Some("SIGTERM".into()),
        })
        .unwrap();
        assert_eq!(
            ev,
            serde_json::json!({"type":"exit","code":null,"signal":"SIGTERM"})
        );
        let ev = serde_json::to_value(ProcEvent::Spawn { pid: 7 }).unwrap();
        assert_eq!(ev, serde_json::json!({"type":"spawn","pid":7}));
    }

    #[test]
    fn consent_message_quotes_control_characters() {
        let r = ConsentRequest {
            plugin_id: "p".into(),
            vault: PathBuf::from("/v"),
            program: PathBuf::from("/bin/sh"),
            args: vec!["a\nFAKE LINE".into()],
            cwd: PathBuf::from("/v"),
            env_keys: vec![],
            inherit_env: true,
        };
        let m = r.message();
        assert!(m.contains("a\\nFAKE LINE") && !m.contains("a\nFAKE"));
    }
}
