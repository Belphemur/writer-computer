//! The network half of the engine: system `git` for `fetch`, `push`, `ls-remote` and the local
//! `remote` bookkeeping (ADR 2026-11-18 point 2), and the one place `gh` runs too. Every child is
//! started through the feature scope's [`Spawner`] (`process`), so turning the feature off kills
//! it and the escape-hatch scan stays green; nothing here names `std::process::Child`.
//!
//! Environment of every child: a `PATH` that adds Homebrew and the standard install dirs (a GUI
//! app's lacks them), `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GH_PROMPT_DISABLED=1`,
//! `LC_ALL=C` and `-c core.quotepath=off`, so the output is parsed from exit codes and stable
//! English fragments only. HTTPS credentials come from Writer's own binary registered per call as
//! the ONLY credential helper (`-c credential.helper=` resets the user's list first, so git's
//! `store` after a success never hands Writer's token to the user's helpers), and only when Writer
//! has a credential for the vault (a saved token, or the GitHub CLI source); otherwise git runs
//! with the user's own helpers untouched. The helper's command line names the binary, the source
//! (`token` or `gh`), the keychain service and the host the token was saved for, never a token.
//! SSH is the user's agent, untouched.
//!
//! Errors are classified once ([`classify`]) into a short line and sanitized details: URLs lose
//! their credentials, the vault path is hidden, known secrets are masked.

use crate::features::scope::Spawner;
use crate::process_run::{run as run_bounded, RunOptions};
pub use crate::process_run::{Output, RunError};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The remote Writer manages.
pub const REMOTE: &str = "origin";

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
pub const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
pub const QUICK_TIMEOUT: Duration = Duration::from_secs(15);
/// A large-file transfer may legitimately take long (the app's close-time sync caps every call).
pub const LFS_TIMEOUT: Duration = Duration::from_secs(1800);

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
    /// No call runs past this instant (the sync on window close has one budget for all its
    /// rounds).
    deadline: Option<Instant>,
    /// Where `git-lfs` is installed, looked up once (the login shell is not free). Its folder is
    /// on every child's `PATH`, so git's own hooks (`pre-push`) find the tool too.
    lfs_dir: std::sync::Arc<std::sync::OnceLock<Option<PathBuf>>>,
}

impl Exec {
    pub fn new(spawner: Spawner) -> Exec {
        Exec {
            spawner,
            prefix: Vec::new(),
            only_prefix: false,
            env: Vec::new(),
            deadline: None,
            lfs_dir: Default::default(),
        }
    }

    /// Every call ends by `deadline` at the latest, whatever its own timeout: one budget for a
    /// whole sync, however many calls and rounds it takes.
    pub fn with_deadline(mut self, deadline: Instant) -> Exec {
        self.deadline = Some(deadline);
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

    /// The directories searched after a test's own: `plugin_env::search_dirs` (the login shell's
    /// PATH, the app's, Homebrew and the version-manager dirs: the one list the plugin host and
    /// the agent search too), nothing when this runner's path was set by hand.
    fn search_dirs(&self) -> Vec<PathBuf> {
        if self.only_prefix {
            return Vec::new();
        }
        crate::plugin_env::search_dirs(
            &crate::plugin_env::login_path(),
            &std::env::var("PATH").unwrap_or_default(),
            crate::plugin_env::home_dir().as_deref(),
        )
    }

    /// The `PATH` of a child: tests' directories, the folder `git-lfs` was found in (so git's own
    /// hooks find it), then [`Exec::search_dirs`], with `/usr/bin` and `/bin` last (macOS keeps a
    /// `git` stub in `/usr/bin` that only asks to install the Command Line Tools).
    pub(crate) fn path(&self) -> std::ffi::OsString {
        let mut prefix = self.prefix.clone();
        prefix.extend(self.lfs_dir());
        join_path(&prefix, self.search_dirs(), !self.only_prefix)
    }

    /// The `git` to run: the one the user's login shell finds first (`plugin_env::which`, the
    /// same lookup the plugin host and the agent use), `git` on [`Exec::path`] when it finds none
    /// or when this runner's search path was set by hand.
    fn git_program(&self) -> std::ffi::OsString {
        self.tool_program("git")
    }

    /// `name` as `plugin_env::which` finds it; the bare name when it finds none or when this
    /// runner's search path was set by hand (tests).
    fn tool_program(&self, name: &str) -> std::ffi::OsString {
        if self.prefix.is_empty() {
            if let Ok(Some(p)) = crate::plugin_env::which(name) {
                return p.into_os_string();
            }
        }
        name.into()
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
            cmd.args(h.config_args());
        }
        cmd.args(args);
        cmd
    }

    /// The folder `git-lfs` is installed in, `None` when it is not: found the way `git` is (the
    /// user's login shell first, `plugin_env::which`; this runner's own search path when it was
    /// set by hand, as in tests). Asked once per runner.
    pub fn lfs_dir(&self) -> Option<PathBuf> {
        self.lfs_dir
            .get_or_init(|| {
                let found = if self.prefix.is_empty() {
                    crate::plugin_env::which("git-lfs").ok().flatten()
                } else {
                    let dirs: Vec<PathBuf> = std::env::split_paths(&join_path(
                        &self.prefix,
                        self.search_dirs(),
                        !self.only_prefix,
                    ))
                    .collect();
                    crate::plugin_env::which_in("git-lfs", &dirs).ok().flatten()
                };
                found.and_then(|p| p.parent().map(Path::to_path_buf))
            })
            .clone()
    }

    pub fn lfs_installed(&self) -> bool {
        self.lfs_dir().is_some()
    }

    /// `git lfs <args>` in `root`. `endpoint` pins the LFS server to the remote's own
    /// (`-c lfs.url`, which outranks the repository's `.lfsconfig`: a vault file must not be able
    /// to send the credentials Writer's helper answers with to another host).
    pub fn git_lfs(
        &self,
        root: &Path,
        helper: Option<&Helper>,
        endpoint: Option<&str>,
        args: &[&str],
    ) -> Command {
        let pins: Vec<String> = endpoint
            .map(|e| {
                vec![
                    "-c".into(),
                    format!("lfs.url={e}"),
                    "-c".into(),
                    format!("lfs.pushurl={e}"),
                ]
            })
            .unwrap_or_default();
        let mut all: Vec<&str> = pins.iter().map(String::as_str).collect();
        all.push("lfs");
        all.extend_from_slice(args);
        self.git(root, helper, &all)
    }

    /// Any other tool with the same environment (`xcode-select`).
    pub fn program(&self, program: &str, args: &[&str]) -> Command {
        let mut cmd = self.command(program, None);
        cmd.args(args);
        cmd
    }

    /// `gh`, found the way [`Exec::git_program`] finds `git`.
    pub fn gh(&self, args: &[&str]) -> Command {
        let mut cmd = self.command(&self.tool_program("gh").to_string_lossy(), None);
        cmd.args(args);
        cmd
    }

    /// Runs a prepared command to its end, to `timeout` (and the [`Exec::with_deadline`]), or
    /// until the scope stops: [`crate::process_run::run`].
    pub fn run(&self, cmd: Command, timeout: Duration) -> Result<Output, RunError> {
        let timeout = match self.deadline {
            Some(d) => {
                let left = d.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(RunError::Timeout);
                }
                left.min(timeout)
            }
            None => timeout,
        };
        run_bounded(&self.spawner, cmd, &RunOptions::new(timeout))
    }
}

/// `prefix`, then `dirs`, de-duplicated; `/usr/bin` and `/bin` last when `system` is set.
fn join_path(prefix: &[PathBuf], dirs: Vec<PathBuf>, system: bool) -> std::ffi::OsString {
    let system_dirs = [PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
    let mut parts: Vec<PathBuf> = prefix.to_vec();
    parts.extend(
        dirs.into_iter()
            .filter(|d| !(system && system_dirs.contains(d))),
    );
    if system {
        parts.extend(system_dirs);
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| seen.insert(p.clone()));
    std::env::join_paths(parts).unwrap_or_default()
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
    /// The host the token was saved for (`Source::Token`): the helper answers no other host.
    pub host: Option<String>,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl Helper {
    /// The helper of the vault at `root`, `None` when Writer has no credential for it (source
    /// `token` with no token saved): git then runs with the user's own helpers alone.
    pub fn for_vault(
        root: &Path,
        exe: PathBuf,
        service: String,
        token_saved: bool,
    ) -> Option<Helper> {
        let source = super::state::credential_source(root);
        (source == Source::Gh || token_saved).then(|| Helper {
            exe,
            source,
            service,
            host: super::state::token_host(root),
        })
    }

    /// `-c credential.helper= -c credential.helper=!'<exe>' git-credential --source token
    /// --service <service> --host <host>`: the empty value clears the user's helpers for this call
    /// (git would otherwise `store` our token in them), then Writer's is the one helper; git
    /// appends the operation (`get`). No token, only where to find it.
    pub fn config_args(&self) -> Vec<String> {
        let mut helper = format!(
            "credential.helper=!{} {} --source {} --service {}",
            shell_quote(&self.exe.to_string_lossy()),
            CREDENTIAL_ARG,
            self.source.arg(),
            shell_quote(&self.service)
        );
        if let Some(host) = &self.host {
            helper.push_str(&format!(" --host {}", shell_quote(host)));
        }
        vec![
            "-c".into(),
            "credential.helper=".into(),
            "-c".into(),
            helper,
        ]
    }
}

/// The host of an `https` remote URL (lower case, no user, port kept), `None` for any other kind.
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
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
    /// `git-lfs` is not installed (or not on git's path).
    NoLfs,
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
        "'lfs' is not a git command",
        "git-lfs was not found",
        "git-lfs: command not found",
        "git-lfs: not found",
    ]) {
        (Kind::NoLfs, "Install git-lfs to sync large files")
    } else if has(&[
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

    fn lfs_run(&self, args: &[&str]) -> Result<(), TransportError> {
        let endpoint = self.remote_url().as_deref().and_then(lfs_endpoint);
        let cmd = self
            .exec
            .git_lfs(self.root, self.helper, endpoint.as_deref(), args);
        let out = self.exec.run(cmd, LFS_TIMEOUT).map_err(run_error)?;
        if out.ok() {
            return Ok(());
        }
        let mut e = self.fail(&out);
        if e.kind == Kind::Other && e.line == "Git failed" {
            e.line = "Large file transfer failed".into();
        }
        Err(e)
    }

    /// `git lfs install --local`: the filters and hooks in this repository's own config only (the
    /// user's global git config is never touched). Idempotent.
    pub fn lfs_install(&self) -> Result<(), TransportError> {
        self.lfs_run(&["install", "--local"])
    }

    /// `git lfs push` of what `branch` holds (objects the remote lacks; the pre-push hook would
    /// do the same, this does not depend on hooks).
    pub fn lfs_push(&self, branch: &str) -> Result<(), TransportError> {
        self.lfs_run(&["push", REMOTE, &format!("refs/heads/{branch}")])
    }

    /// `git lfs fetch` of the objects the remote's `branch` points at into the local store.
    pub fn lfs_fetch(&self, branch: &str) -> Result<(), TransportError> {
        self.lfs_run(&["fetch", REMOTE, &format!("refs/remotes/{REMOTE}/{branch}")])
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

/// The LFS server of an HTTPS remote, derived the way git-lfs derives it (`<remote>.git/info/lfs`).
/// SSH remotes authenticate through `git-lfs-authenticate` and `file://` ones use git-lfs's own
/// local transfer: neither gets an endpoint pinned.
pub fn lfs_endpoint(remote: &str) -> Option<String> {
    let url = remote.trim_end_matches('/');
    url.starts_with("https://").then(|| {
        if url.ends_with(".git") {
            format!("{url}/info/lfs")
        } else {
            format!("{url}.git/info/lfs")
        }
    })
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

#[cfg(test)]
mod path_tests {
    use super::*;

    fn dirs(os: std::ffi::OsString) -> Vec<String> {
        std::env::split_paths(&os)
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_child_path_is_the_shared_search_dirs_with_the_system_dirs_last() {
        let home = PathBuf::from("/home/w");
        let shared = crate::plugin_env::search_dirs("/usr/bin:/login/bin", "/app/bin", Some(&home));
        let path = dirs(join_path(
            &[PathBuf::from("/test/bin")],
            shared.clone(),
            true,
        ));
        // tests' dirs, then login, app and the known install dirs in search_dirs order
        assert_eq!(path[0], "/test/bin");
        let pos = |d: &str| path.iter().position(|p| p == d).unwrap();
        assert!(pos("/login/bin") < pos("/app/bin"));
        assert!(pos("/app/bin") < pos("/opt/homebrew/bin"));
        assert!(pos("/home/w/.local/bin") < pos("/opt/homebrew/bin"));
        // `/usr/bin` listed first by the login PATH still comes after Homebrew, once
        assert!(pos("/opt/homebrew/bin") < pos("/usr/bin"));
        assert_eq!(path[path.len() - 2..], ["/usr/bin", "/bin"]);
        assert_eq!(path.iter().filter(|p| *p == "/usr/bin").count(), 1);
        for d in &shared {
            if d != Path::new("/usr/bin") {
                assert!(path.contains(&d.to_string_lossy().into_owned()));
            }
        }
    }

    #[test]
    fn only_prefix_replaces_everything() {
        let path = dirs(join_path(&[PathBuf::from("/only")], Vec::new(), false));
        assert_eq!(path, ["/only"]);
    }
}
