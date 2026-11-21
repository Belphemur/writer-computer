//! The network half of the engine: system `git` for `fetch`, `push`, `ls-remote` and the local
//! `remote` bookkeeping (ADR 2026-11-18 point 2), and the one place `gh` runs too. Every child is
//! started through the feature scope's [`Spawner`] (`process`), so turning the feature off kills
//! it and the escape-hatch scan stays green; nothing here names `std::process::Child`.
//!
//! Environment of every child: a `PATH` that adds Homebrew and the standard install dirs (a GUI
//! app's lacks them), `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GH_PROMPT_DISABLED=1`,
//! `LC_ALL=C` and `-c core.quotepath=off`, so the output is parsed from exit codes and stable
//! English fragments only. HTTPS credentials come from Writer's own binary registered per call as a
//! credential helper (`credential.helper=!...`, after the user's own helpers, which git tries
//! first); the helper's command line names the binary, the source (`token` or `gh`) and the
//! keychain service, never a token. SSH is the user's agent, untouched.
//!
//! Errors are classified once ([`classify`]) into a short line and sanitized details: URLs lose
//! their credentials, the vault path is hidden, known secrets are masked.

use crate::features::scope::{ScopedChild, Spawner};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The remote Writer manages.
pub const REMOTE: &str = "origin";

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
pub const QUICK_TIMEOUT: Duration = Duration::from_secs(15);

/// Where git and gh run: the scope's process starter and, for tests, directories searched first
/// (a fake `gh`, a missing `git`).
#[derive(Clone)]
pub struct Exec {
    spawner: Spawner,
    prefix: Vec<PathBuf>,
    /// Replace the inherited PATH entirely (tests of a missing `git`).
    only_prefix: bool,
    /// Extra environment for every child (tests isolate git's config with it).
    env: Vec<(String, String)>,
    /// No call waits longer than this (the sync on window close is short).
    cap: Option<Duration>,
}

impl Exec {
    pub fn new(spawner: Spawner) -> Exec {
        Exec {
            spawner,
            prefix: Vec::new(),
            only_prefix: false,
            env: Vec::new(),
            cap: None,
        }
    }

    /// Caps every call's timeout.
    pub fn with_timeout_cap(mut self, cap: Duration) -> Exec {
        self.cap = Some(cap);
        self
    }

    /// Environment added to every child.
    pub fn with_env(mut self, env: Vec<(String, String)>) -> Exec {
        self.env = env;
        self
    }

    /// Directories searched before the usual ones.
    pub fn with_path_prefix(mut self, dirs: Vec<PathBuf>) -> Exec {
        self.prefix = dirs;
        self
    }

    /// The search path is exactly these directories.
    pub fn with_only_path(mut self, dirs: Vec<PathBuf>) -> Exec {
        self.prefix = dirs;
        self.only_prefix = true;
        self
    }

    pub fn spawner(&self) -> &Spawner {
        &self.spawner
    }

    /// The `PATH` of a child: tests' directories, then Homebrew's (before `/usr/bin`, where macOS
    /// keeps a `git` stub that only asks to install the Command Line Tools), then the app's own.
    pub(crate) fn path(&self) -> std::ffi::OsString {
        let mut parts: Vec<PathBuf> = self.prefix.clone();
        if !self.only_prefix {
            for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
                parts.push(PathBuf::from(dir));
            }
            parts.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            for dir in ["/usr/bin", "/bin"] {
                let dir = PathBuf::from(dir);
                if !parts.contains(&dir) {
                    parts.push(dir);
                }
            }
        }
        let mut seen = Vec::new();
        parts.retain(|p| {
            let fresh = !seen.contains(p);
            seen.push(p.clone());
            fresh
        });
        std::env::join_paths(parts).unwrap_or_default()
    }

    /// The `git` to run: the one the user's login shell finds first (`plugin_env::which`, the
    /// same lookup the plugin host and the agent use), `git` on [`Exec::path`] when it finds none
    /// or when this runner's search path was set by hand.
    fn git_program(&self) -> std::ffi::OsString {
        if self.prefix.is_empty() {
            if let Ok(Some(p)) = crate::plugin_env::which("git") {
                return p.into_os_string();
            }
        }
        "git".into()
    }

    fn command(&self, program: &str, cwd: Option<&Path>) -> Command {
        let mut cmd = Command::new(program);
        cmd.env("PATH", self.path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        cmd
    }

    /// `git` in `root`, with `core.quotepath=off` and, when given, Writer's credential helper.
    pub fn git(&self, root: &Path, helper: Option<&Helper>, args: &[&str]) -> Command {
        let program = self.git_program();
        let mut cmd = self.command(&program.to_string_lossy(), Some(root));
        cmd.args(["-c", "core.quotepath=off"]);
        if let Some(h) = helper {
            cmd.arg("-c").arg(h.config());
        }
        cmd.args(args);
        cmd
    }

    /// Any other tool with the same environment (`xcode-select`).
    pub fn program(&self, program: &str, args: &[&str]) -> Command {
        let mut cmd = self.command(program, None);
        cmd.args(args);
        cmd
    }

    pub fn gh(&self, args: &[&str]) -> Command {
        let mut cmd = self.command("gh", None);
        cmd.args(args);
        cmd
    }

    /// Runs a prepared command to its end, to `timeout`, or until the scope stops.
    pub fn run(&self, mut cmd: Command, timeout: Duration) -> Result<Output, RunError> {
        let mut child: ScopedChild = match self.spawner.process(&mut cmd) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunError::Absent),
            Err(e) if self.spawner.token().is_cancelled() => {
                let _ = e;
                return Err(RunError::Cancelled);
            }
            Err(e) => return Err(RunError::Io(e.kind().to_string())),
        };
        let (tx, rx) = mpsc::channel::<(bool, String)>();
        let drain = |is_err: bool, mut pipe: Box<dyn Read + Send>| {
            let tx = tx.clone();
            self.spawner.spawn("git-io", move |_| {
                let mut buf = Vec::new();
                let _ = pipe.by_ref().take(4 << 20).read_to_end(&mut buf);
                let _ = tx.send((is_err, String::from_utf8_lossy(&buf).into_owned()));
            })
        };
        let mut pending = 0;
        if let Some(out) = child.take_stdout() {
            if drain(false, Box::new(out)).is_err() {
                child.kill();
                return Err(RunError::Cancelled);
            }
            pending += 1;
        }
        if let Some(err) = child.take_stderr() {
            if drain(true, Box::new(err)).is_err() {
                child.kill();
                return Err(RunError::Cancelled);
            }
            pending += 1;
        }
        drop(tx);
        let timeout = self.cap.map_or(timeout, |c| c.min(timeout));
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {}
                Err(e) => return Err(RunError::Io(e.kind().to_string())),
            }
            if self.spawner.token().is_cancelled() {
                child.kill();
                return Err(RunError::Cancelled);
            }
            if start.elapsed() > timeout {
                child.kill();
                return Err(RunError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        if self.spawner.token().is_cancelled() {
            // the scope stopped and killed the child's group under us
            return Err(RunError::Cancelled);
        }
        let (mut stdout, mut stderr) = (String::new(), String::new());
        for _ in 0..pending {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok((false, t)) => stdout = t,
                Ok((true, t)) => stderr = t,
                Err(_) => break,
            }
        }
        Ok(Output {
            code: status.code(),
            stdout,
            stderr,
        })
    }
}

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// The program is not installed.
    Absent,
    Timeout,
    /// The scope stopped (the feature was turned off or the app quits).
    Cancelled,
    Io(String),
}

// ---- credential helper -------------------------------------------------------------------------

/// Where the helper finds the HTTPS password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The secret `features.git.token`.
    Token,
    /// `gh auth token`, read at the moment of use.
    Gh,
}

impl Source {
    pub fn arg(self) -> &'static str {
        match self {
            Source::Token => "token",
            Source::Gh => "gh",
        }
    }

    pub fn parse(s: &str) -> Option<Source> {
        match s {
            "token" => Some(Source::Token),
            "gh" => Some(Source::Gh),
            _ => None,
        }
    }
}

/// Writer's binary as a git credential helper: what `-c credential.helper=` is given.
#[derive(Debug, Clone)]
pub struct Helper {
    pub exe: PathBuf,
    pub source: Source,
    /// The keychain service the secret is stored under (it names the build, not a secret).
    pub service: String,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl Helper {
    /// `credential.helper=!'<exe>' git-credential --source token --service <service>`: git appends
    /// the operation (`get`). No token, only where to find it.
    pub fn config(&self) -> String {
        format!(
            "credential.helper=!{} {} --source {} --service {}",
            shell_quote(&self.exe.to_string_lossy()),
            CREDENTIAL_ARG,
            self.source.arg(),
            shell_quote(&self.service)
        )
    }
}

/// The first argument of Writer's binary in credential-helper mode.
pub const CREDENTIAL_ARG: &str = "git-credential";

// ---- errors -------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// No network or the host did not answer.
    Offline,
    /// The remote refused our credentials.
    Auth,
    /// The remote has moved: a push was not a fast-forward.
    Rejected,
    /// The remote repository does not exist (or is not visible to us).
    NotFound,
    Timeout,
    /// `git` is not installed.
    NoGit,
    /// The scope stopped while git ran.
    Cancelled,
    Other,
}

/// A failed network call: a short line for the status and the sanitized output for "Details".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub kind: Kind,
    pub line: String,
    pub details: String,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.line)
    }
}

impl std::error::Error for TransportError {}

impl TransportError {
    fn new(kind: Kind, line: &str, details: String) -> TransportError {
        TransportError {
            kind,
            line: line.to_string(),
            details,
        }
    }
}

/// The text of git's or gh's output with credentials gone: `user:password@` in a URL, the vault
/// path and any of `secrets`.
pub fn sanitize(text: &str, root: &Path, secrets: &[&str]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let (url, after) = tail.split_at(end);
        let host_start = url.find('/').unwrap_or(url.len());
        match url[..host_start].rfind('@') {
            Some(at) => out.push_str(&url[at + 1..]),
            None => out.push_str(url),
        }
        rest = after;
    }
    out.push_str(rest);
    let root_text = root.to_string_lossy();
    if !root_text.is_empty() {
        out = out.replace(root_text.as_ref(), "<vault>");
    }
    for s in secrets.iter().filter(|s| s.len() >= 4) {
        out = out.replace(s, "***");
    }
    out.trim().to_string()
}

/// A failed git call in words. `push` makes "rejected" mean the remote moved.
pub fn classify(out: &Output, root: &Path, secrets: &[&str]) -> TransportError {
    let text = format!("{}\n{}", out.stderr, out.stdout);
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    let (kind, line) = if has(&[
        "authentication failed",
        "permission denied",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "invalid username or password",
        "bad credentials",
        "http 401",
        "http 403",
        "requested url returned error: 401",
        "requested url returned error: 403",
    ]) {
        (Kind::Auth, "Authentication failed")
    } else if has(&[
        "repository not found",
        "does not appear to be a git repository",
    ]) && !has(&["could not resolve host"])
    {
        (Kind::NotFound, "Remote repository not found")
    } else if has(&[
        "could not resolve host",
        "connection refused",
        "network is unreachable",
        "connection timed out",
        "operation timed out",
        "unable to access",
        "failed to connect",
        "could not read from remote repository",
        "connection reset",
        "temporary failure in name resolution",
    ]) {
        (Kind::Offline, "Offline")
    } else if has(&[
        "[rejected]",
        "non-fast-forward",
        "fetch first",
        "stale info",
        "incorrect old value",
        "cannot lock ref",
    ]) {
        (Kind::Rejected, "Push rejected: the remote moved")
    } else if has(&["[remote rejected]", "protected branch"]) {
        (Kind::Other, "Push rejected by the remote")
    } else {
        (Kind::Other, "Git failed")
    };
    TransportError::new(kind, line, sanitize(&text, root, secrets))
}

fn run_error(e: RunError) -> TransportError {
    match e {
        RunError::Absent => TransportError::new(Kind::NoGit, "Git is not installed", String::new()),
        RunError::Timeout => {
            TransportError::new(Kind::Timeout, "Git did not answer in time", String::new())
        }
        RunError::Cancelled => TransportError::new(Kind::Cancelled, "Stopped", String::new()),
        RunError::Io(k) => TransportError::new(Kind::Other, "Git failed", k),
    }
}

// ---- operations ---------------------------------------------------------------------------------

pub struct Transport<'a> {
    pub exec: &'a Exec,
    pub root: &'a Path,
    pub helper: Option<&'a Helper>,
    /// Values to mask in any output we keep (a token read for this call).
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fetched {
    Updated,
    /// The remote has no such branch yet (an empty repository): the first push creates it.
    BranchMissing,
}

impl Transport<'_> {
    fn secrets(&self) -> Vec<&str> {
        self.secrets.iter().map(String::as_str).collect()
    }

    fn run(&self, args: &[&str], timeout: Duration) -> Result<Output, TransportError> {
        self.exec
            .run(self.exec.git(self.root, self.helper, args), timeout)
            .map_err(run_error)
    }

    fn fail(&self, out: &Output) -> TransportError {
        classify(out, self.root, &self.secrets())
    }

    /// The URL of the remote, credentials removed, `None` when there is none.
    pub fn remote_url(&self) -> Option<String> {
        let out = self
            .run(&["remote", "get-url", REMOTE], QUICK_TIMEOUT)
            .ok()?;
        out.ok()
            .then(|| sanitize(out.stdout.trim(), self.root, &[]))
            .filter(|u| !u.is_empty())
    }

    /// Links `url` as the remote (adds it, or changes the one there). The URL is checked first
    /// ([`check_url`]).
    pub fn set_remote(&self, url: &str) -> Result<(), TransportError> {
        let url = check_url(url).map_err(|m| TransportError::new(Kind::Other, m, String::new()))?;
        let verb = if self.remote_url().is_some() {
            "set-url"
        } else {
            "add"
        };
        let out = self.run(&["remote", verb, "--", REMOTE, &url], QUICK_TIMEOUT)?;
        if out.ok() {
            Ok(())
        } else {
            Err(self.fail(&out))
        }
    }

    /// Unlinks the remote and forgets its tracking refs.
    pub fn remove_remote(&self) -> Result<(), TransportError> {
        if self.remote_url().is_none() {
            return Ok(());
        }
        let out = self.run(&["remote", "remove", REMOTE], QUICK_TIMEOUT)?;
        if out.ok() {
            Ok(())
        } else {
            Err(self.fail(&out))
        }
    }

    /// Can the remote be reached with our credentials? (`ls-remote` of its HEAD.)
    pub fn check_reachable(&self) -> Result<(), TransportError> {
        let out = self.run(&["ls-remote", "--quiet", REMOTE, "HEAD"], FETCH_TIMEOUT)?;
        if out.ok() {
            Ok(())
        } else {
            Err(self.fail(&out))
        }
    }

    /// `git fetch` of one branch into `refs/remotes/origin/<branch>`.
    pub fn fetch(&self, branch: &str) -> Result<Fetched, TransportError> {
        let spec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}");
        let out = self.run(
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                REMOTE,
                &spec,
            ],
            FETCH_TIMEOUT,
        )?;
        if out.ok() {
            return Ok(Fetched::Updated);
        }
        if out.stderr.contains("couldn't find remote ref") {
            return Ok(Fetched::BranchMissing);
        }
        Err(self.fail(&out))
    }

    /// `git push` of the branch (a fast-forward only: never forced).
    pub fn push(&self, branch: &str) -> Result<(), TransportError> {
        let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let out = self.run(
            &["push", "--porcelain", "--quiet", REMOTE, &spec],
            PUSH_TIMEOUT,
        )?;
        if out.ok() {
            Ok(())
        } else {
            Err(self.fail(&out))
        }
    }
}

/// A remote URL Writer accepts, normalised: SSH (`git@host:owner/repo`, `ssh://`), HTTPS, a
/// `file://` URL or an absolute path. Refused: an option (leading `-`), a password in the URL (the
/// token goes in Sign in, not in the vault's `.git/config`), whitespace and other schemes.
pub fn check_url(url: &str) -> Result<String, &'static str> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter a remote URL");
    }
    if url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That is not a remote URL");
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "ssh" | "file" | "git") {
            return Err("Use an https, ssh or git@ URL");
        }
        let authority = rest.split('/').next().unwrap_or("");
        if scheme != "file" && authority.contains('@') {
            let userinfo = authority.rsplit_once('@').map_or("", |(u, _)| u);
            if userinfo.contains(':') {
                return Err("Remove the password from the URL; add a token under Sign in");
            }
        }
        return Ok(url.to_string());
    }
    // scp-like `git@host:owner/repo.git`
    if let Some((host, path)) = url.split_once(':') {
        if host.contains('@') && !host.contains('/') && !path.is_empty() {
            return Ok(url.to_string());
        }
    }
    if url.starts_with('/') {
        return Ok(url.to_string());
    }
    Err("Use an https, ssh or git@ URL")
}

/// A short, display-safe name for a remote URL: the host and path, no scheme and no user.
pub fn display_url(url: &str) -> String {
    let clean = sanitize(url, Path::new(""), &[]);
    let s = clean
        .strip_prefix("https://")
        .or_else(|| clean.strip_prefix("ssh://"))
        .or_else(|| clean.strip_prefix("file://"))
        .unwrap_or(&clean);
    let s = s.rsplit_once('@').map_or(s, |(_, r)| r);
    s.trim_end_matches(".git").replacen(':', "/", 1)
}
