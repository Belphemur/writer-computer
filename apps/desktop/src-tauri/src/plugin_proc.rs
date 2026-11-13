// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Process spawn for plugins that shell out (obsidian-copilot's Agent Mode,
//! `child_process`). Desktop only, high risk, so every start is gated:
//!  - the vault must be trusted (checked by the command layer, and again after
//!    the consent dialog returns, since the user may have revoked trust or
//!    switched vault while it was open);
//!  - EVERY spawn asks the user through a native dialog (see `Consent`) that
//!    shows the plugin id, the resolved program, all arguments and the cwd.
//!    There is no "remember": nothing is cached between two spawns;
//!  - the cwd must be inside the workspace root (`authorize_path`);
//!  - at most `MAX_PROCS` live processes app-wide;
//!  - a window's processes die with the window, and a vault's die when its
//!    trust is revoked or the window leaves that vault (`kill_window` /
//!    `kill_root`). On unix each child leads its own process group and the
//!    whole group is killed, so grandchildren go too.
//!
//! Differences from opensidian's `desk_proc.rs`: bytes cross IPC as base64
//! (not latin1), output is delivered as events instead of polled buffers, and
//! the consent is a trait so the dialog is the only part that is not unit
//! tested.

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

#[derive(Debug, Clone, Deserialize)]
pub struct SpawnRequest {
    /// Shown in the consent dialog; must be a well-formed plugin id.
    pub plugin_id: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    /// Must be inside the workspace root. Default: the root.
    pub cwd: Option<String>,
    /// Laid over the app's own environment.
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProcEvent {
    Stdout {
        data_base64: String,
    },
    Stderr {
        data_base64: String,
    },
    /// Last event. `code` is None when killed by a signal (`signal` then set on unix).
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
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
        format!(
            "The plugin {:?} wants to run a program on this computer.\n\n\
             Command:\n{cmd}\n\n\
             Working directory:\n{:?}\n\n\
             Extra environment variables: {env}\n\n\
             Vault: {:?}\n\n\
             Only allow this if you trust the plugin and recognise the command. \
             The program runs with your own permissions.",
            self.plugin_id,
            self.cwd.to_string_lossy(),
            self.vault.to_string_lossy(),
        )
    }
}

/// The user's answer. Production: a native dialog. Tests: a double.
pub trait Consent: Send + Sync {
    fn ask(&self, req: &ConsentRequest) -> bool;
}

/// A validated, resolved spawn.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
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
        let path = path_env
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        std::env::split_paths(&path)
            .filter(|d| d.is_absolute())
            .map(|d| d.join(command))
            .find(|c| is_executable(c))
    };
    let found = found.ok_or_else(|| format!("ENOENT: program {command:?} not found"))?;
    found.canonicalize().map_err(|e| format!("ENOENT: {e}"))
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

    /// The full gated start: capacity, consent, trust re-check, then spawn.
    /// `still_ok` is asked again after the dialog returns (trust revoked or
    /// vault switched meanwhile = refuse).
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_with_consent(
        &self,
        consent: &dyn Consent,
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
        let ask = ConsentRequest {
            plugin_id: plugin_id.to_string(),
            vault: root.to_path_buf(),
            program: p.program.clone(),
            args: p.args.clone(),
            cwd: p.cwd.clone(),
            env_keys: p.env.iter().map(|(k, _)| k.clone()).collect(),
        };
        if !consent.ask(&ask) {
            return Err("EACCES: the user denied this program".into());
        }
        if !still_ok() {
            return Err("EACCES: trust or vault changed while asking".into());
        }
        self.spawn(label, root, p, emit)
    }

    /// Spawn WITHOUT asking: callers must have obtained consent. Private to
    /// the module family on purpose.
    fn spawn(&self, label: &str, root: &Path, p: &Prepared, emit: Emit) -> Result<u64, String> {
        let mut procs = self.procs.lock();
        if procs.len() >= MAX_PROCS {
            return Err(format!("EBUSY: {MAX_PROCS} processes are already running"));
        }
        let mut cmd = Command::new(&p.program);
        cmd.args(&p.args)
            .current_dir(&p.cwd)
            .envs(p.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
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
        let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let out = child.stdout.take();
        let err = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
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
                    Ok(Some(s)) => break Some(s),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                std::thread::sleep(Duration::from_millis(15));
            };
            // Output first, then the exit event, so a consumer sees all bytes.
            // A grandchild holding the pipe open would block the join: the
            // group is killed by `kill`, and for a natural exit we only wait
            // briefly.
            for t in [t_out, t_err] {
                let _ = join_with_timeout(t, Duration::from_secs(2));
            }
            registry.lock().remove(&id);
            let (code, signal) = match status {
                Some(s) => (s.code(), exit_signal(&s)),
                None => (None, None),
            };
            emit(ProcEvent::Exit { code, signal });
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

    fn kill_proc(p: &Proc) {
        let mut child = p.child.lock();
        // Only signal a child that has not been reaped: its pid is still ours.
        if matches!(child.try_wait(), Ok(None)) {
            kill_group(&mut child);
        }
    }

    /// Kill one process (and its group). The `Exit` event follows.
    pub fn kill(&self, label: &str, id: u64) -> Result<(), String> {
        self.with_proc(label, id, Self::kill_proc)
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
            Self::kill_proc(p);
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
fn kill_group(child: &mut Child) {
    // `process_group(0)` made the child its own group leader: pgid == pid.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn kill_group(child: &mut Child) {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    struct Double {
        allow: bool,
        asked: AtomicUsize,
        last: Mutex<Option<ConsentRequest>>,
    }

    impl Double {
        fn new(allow: bool) -> Self {
            Self {
                allow,
                asked: AtomicUsize::new(0),
                last: Mutex::new(None),
            }
        }
    }

    impl Consent for Double {
        fn ask(&self, req: &ConsentRequest) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            *self.last.lock() = Some(req.clone());
            self.allow
        }
    }

    fn req(command: &str, args: &[&str]) -> SpawnRequest {
        SpawnRequest {
            plugin_id: "copilot".into(),
            command: command.into(),
            args: Some(args.iter().map(|s| s.to_string()).collect()),
            cwd: None,
            env: None,
        }
    }

    fn events() -> (Emit, mpsc::Receiver<ProcEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (Arc::new(move |ev| tx.lock().send(ev).is_ok()), rx)
    }

    fn run_collect(rx: &mpsc::Receiver<ProcEvent>) -> (String, String, ProcEvent) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                ProcEvent::Stdout { data_base64 } => out.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data_base64)
                        .unwrap(),
                ),
                ProcEvent::Stderr { data_base64 } => err.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data_base64)
                        .unwrap(),
                ),
                exit @ ProcEvent::Exit { .. } => {
                    return (
                        String::from_utf8(out).unwrap(),
                        String::from_utf8(err).unwrap(),
                        exit,
                    )
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
        m.spawn_with_consent(c, label, root, &r.plugin_id, &p, &|| true, emit)
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
        let (out, err, exit) = run_collect(&rx);
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
        for _ in 0..50 {
            if m.active() == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(m.active(), 0);
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
    fn every_spawn_asks_again() {
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
    fn trust_revoked_during_dialog_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, _rx) = events();
        let r = req("true", &[]);
        let p = prepare(&r, dir.path().to_path_buf()).unwrap();
        let err = m
            .spawn_with_consent(&c, "w", dir.path(), "copilot", &p, &|| false, emit)
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
        let (out, _, exit) = run_collect(&rx);
        assert_eq!(out, "hello\n");
        assert_eq!(
            exit,
            ProcEvent::Exit {
                code: Some(0),
                signal: None
            }
        );
    }

    #[test]
    fn kill_reaches_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let m = ProcManager::default();
        let c = Double::new(true);
        let (emit, rx) = events();
        // a shell that forks a grandchild, prints its pid, and sleeps
        let id = go(
            &m,
            &c,
            "w",
            dir.path(),
            &req("sh", &["-c", "sleep 300 & echo $!; wait"]),
            emit,
        )
        .unwrap();
        let ProcEvent::Stdout { data_base64 } = rx.recv_timeout(Duration::from_secs(5)).unwrap()
        else {
            panic!("expected pid")
        };
        let pid: i32 = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(data_base64)
                .unwrap(),
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        assert!(m.kill("other", id).is_err(), "foreign window cannot kill");
        m.kill("w", id).unwrap();
        let (_, _, exit) = run_collect(&rx);
        assert!(matches!(
            exit,
            ProcEvent::Exit {
                code: None,
                signal: Some(9)
            }
        ));
        // the grandchild is gone too
        let mut gone = false;
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "grandchild {pid} survived");
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
            assert!(matches!(
                rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                ProcEvent::Exit { .. }
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(m.active(), MAX_PROCS / 2);
        m.kill_root(&root);
        for rx in rxs.iter().skip(1).step_by(2) {
            assert!(matches!(
                rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                ProcEvent::Exit { .. }
            ));
        }
        for _ in 0..50 {
            if m.active() == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(m.active(), 0);
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
        assert!(prepare(&req("sh", &[]), cwd).unwrap().program.is_absolute());
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
        };
        let m = r.message();
        assert!(m.contains("a\\nFAKE LINE") && !m.contains("a\nFAKE"));
    }
}
