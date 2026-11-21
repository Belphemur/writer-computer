//! `git var GIT_AUTHOR_IDENT` /
//! `GIT_COMMITTER_IDENT`, so the commit identity is exactly the installed git's (includes, `includeIf`
//! and the rest of its config rules), whatever gix would resolve. Same environment rules as the
//! ADR's transport: a `PATH` that adds Homebrew and the standard install dirs (a GUI app's lacks
//! them), `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, a timeout. Only the name and email are read from the
//! output.
//!
//! `user.useConfigOnly=true` is forced for the call, so git answers only from configuration and the
//! environment, never with a name guessed from the system user and the host name.

use super::repo::Identity;
use super::transport::{Exec, RunError};
use crate::features::scope::Spawner;
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);

/// What `git var` said.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Found(Identity),
    /// git ran and says it has no identity for this repository (and only that).
    NoIdentity,
    /// git is not installed.
    Absent,
    /// git failed for another reason (a timeout, unreadable output, a broken install): the caller
    /// asks gix instead, it is not "no identity".
    Error(String),
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

/// git's own words for "I have no name or email for you" (`user.useConfigOnly` makes it die with
/// the first two; the advice line is the older wording).
fn is_identity_error(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    [
        "no name was given",
        "no email was given",
        "please tell me who you are",
        "unable to auto-detect",
        "empty ident name",
    ]
    .iter()
    .any(|m| s.contains(m))
}

fn var(exec: &Exec, root: &Path, which: &str) -> Outcome {
    let mut cmd = exec.git(root, None, &["var", which]);
    // add one config entry (user.useConfigOnly) after any the environment already carries
    let n: usize = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    cmd.env("GIT_CONFIG_COUNT", (n + 1).to_string())
        .env(format!("GIT_CONFIG_KEY_{n}"), "user.useConfigOnly")
        .env(format!("GIT_CONFIG_VALUE_{n}"), "true");
    let out = match exec.run(cmd, TIMEOUT) {
        Ok(o) => o,
        Err(RunError::Absent) => return Outcome::Absent,
        Err(RunError::Timeout) => return Outcome::Error("git did not answer in time".into()),
        Err(e) => return Outcome::Error(format!("{e:?}")),
    };
    if !out.ok() {
        return if is_identity_error(&out.stderr) {
            Outcome::NoIdentity
        } else {
            Outcome::Error(format!("git exited with {:?}", out.code))
        };
    }
    match parse(&out.stdout) {
        Some(id) => Outcome::Found(id),
        None => Outcome::Error("unreadable git output".into()),
    }
}

/// The author and committer identity git itself resolves in `root`: `Ok(None)` when git cannot say
/// (not installed, a failure that is not "no identity"), so the caller asks gix; `Err("none")` only
/// when git itself says there is no identity.
pub fn identities(root: &Path) -> Result<Option<(Identity, Identity)>, String> {
    // a short child with no scope of its own (called from commits anywhere, the CLI included):
    // bounded by `TIMEOUT` and killed with its process group
    identities_with(&Exec::new(Spawner::detached()), root)
}

pub fn identities_with(exec: &Exec, root: &Path) -> Result<Option<(Identity, Identity)>, String> {
    let mut both = Vec::new();
    for which in ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] {
        match var(exec, root, which) {
            Outcome::Found(i) => both.push(i),
            Outcome::NoIdentity => return Err("none".into()),
            Outcome::Absent | Outcome::Error(_) => return Ok(None),
        }
    }
    let committer = both.pop().expect("two");
    let author = both.pop().expect("two");
    Ok(Some((author, committer)))
}
