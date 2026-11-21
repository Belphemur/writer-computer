//! The one place `git` runs as a child process in phase 1: `git var GIT_AUTHOR_IDENT` /
//! `GIT_COMMITTER_IDENT`, so the commit identity is exactly the installed git's (includes, `includeIf`
//! and the rest of its config rules), whatever gix would resolve. Same environment rules as the
//! ADR's transport: a `PATH` that adds Homebrew and the standard install dirs (a GUI app's lacks
//! them), `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, a timeout. Only the name and email are read from the
//! output.
//!
//! `user.useConfigOnly=true` is forced for the call, so git answers only from configuration and the
//! environment, never with a name guessed from the system user and the host name.

use super::repo::Identity;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(5);

/// What `git var` said.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Found(Identity),
    /// git ran and has no identity for this repository.
    NoIdentity,
    /// git is not installed.
    Absent,
    /// git did not answer (timeout, unreadable output).
    Error(String),
}

/// The `PATH` for a child git: the app's, then the usual install dirs.
fn path_with_git_dirs() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        if !parts.iter().any(|p| p == dir) {
            parts.push(dir.to_string());
        }
    }
    parts.join(":")
}

/// `Name <email> 1700000000 +0000` to the name and the email.
fn parse(line: &str) -> Option<Identity> {
    let (name, rest) = line.trim().split_once(" <")?;
    let (email, _date) = rest.split_once('>')?;
    (!name.is_empty() && !email.is_empty()).then(|| Identity {
        name: name.to_string(),
        email: email.to_string(),
    })
}

fn var(root: &Path, which: &str) -> Outcome {
    let mut cmd = Command::new("git");
    cmd.args(["var", which])
        .current_dir(root)
        .env("PATH", path_with_git_dirs())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // add one config entry (user.useConfigOnly) after any the environment already carries
    let n: usize = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    cmd.env("GIT_CONFIG_COUNT", (n + 1).to_string())
        .env(format!("GIT_CONFIG_KEY_{n}"), "user.useConfigOnly")
        .env(format!("GIT_CONFIG_VALUE_{n}"), "true");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::Absent,
        Err(e) => return Outcome::Error(e.to_string()),
    };
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Outcome::Error("git did not answer in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Outcome::Error(e.to_string()),
        }
    };
    if !status.success() {
        return Outcome::NoIdentity;
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    match parse(&out) {
        Some(id) => Outcome::Found(id),
        None => Outcome::Error("unreadable git output".into()),
    }
}

/// The author and committer identity git itself resolves in `root`.
pub fn identities(root: &Path) -> Result<Option<(Identity, Identity)>, String> {
    let author = match var(root, "GIT_AUTHOR_IDENT") {
        Outcome::Found(i) => i,
        Outcome::NoIdentity => return Err("none".into()),
        Outcome::Absent => return Ok(None),
        Outcome::Error(e) => return Err(format!("git: {e}")),
    };
    let committer = match var(root, "GIT_COMMITTER_IDENT") {
        Outcome::Found(i) => i,
        Outcome::NoIdentity => return Err("none".into()),
        Outcome::Absent => return Ok(None),
        Outcome::Error(e) => return Err(format!("git: {e}")),
    };
    Ok(Some((author, committer)))
}
