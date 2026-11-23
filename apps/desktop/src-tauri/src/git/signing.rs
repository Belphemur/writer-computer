//! Commit signing through the installed `git` (ADR 2026-11-18, the 2026-11-23 notes): when git's
//! effective configuration says commits are signed (`commit.gpgsign`, as `git commit` resolves
//! it: global, includes, the repository's own), every commit Writer makes is written by
//! `git commit-tree -S`, which applies `gpg.format`, `user.signingkey` and `gpg.program` /
//! `gpg.ssh.program` exactly as `git commit` would. Writer reads no key and runs no signer itself;
//! gix only moves the branch afterwards (`Repo::move_head`, compare-and-swap).
//!
//! Never unsigned: when signing is on and git cannot sign, the caller gets [`SignError`] and makes
//! no commit. Same environment rules as the other git children (`transport::Exec`).

use super::repo::Sig;
use super::transport::{sanitize, Exec, RunError};
use crate::process_run::{run as run_bounded, RunOptions};
use std::path::Path;
use std::time::Duration;

/// The signer may wait for the user (a 1Password approval, a pinentry).
pub const SIGN_TIMEOUT: Duration = Duration::from_secs(120);
const CONFIG_TIMEOUT: Duration = Duration::from_secs(5);

/// What the status and Settings > Git say about signing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Signing {
    /// git's effective `commit.gpgsign`: Writer signs.
    pub on: bool,
    /// git resolves a signing key (`user.signingkey`, or an ssh default key command).
    pub key: bool,
    /// Signed commits among the branch's recent ones.
    pub signed_history: bool,
}

impl Signing {
    /// The repository looks like it signs while the configuration does not say so.
    pub fn suggested(&self) -> bool {
        !self.on && self.signed_history
    }
}

/// Why git could not sign: git's own words, sanitized (no vault path, no credentials).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignError {
    pub details: String,
}

/// One value of git's effective configuration for `root`, `None` when unset or git failed.
fn config(exec: &Exec, root: &Path, args: &[&str]) -> Option<String> {
    let mut all = vec!["config", "--get"];
    all.extend_from_slice(args);
    let out = exec.run(exec.git(root, None, &all), CONFIG_TIMEOUT).ok()?;
    out.ok().then(|| out.stdout.trim().to_string())
}

/// Whether git's configuration says commits are signed. Git absent or a failed read is "off": the
/// gix path is unchanged then.
pub fn enabled(exec: &Exec, root: &Path) -> bool {
    config(exec, root, &["--type=bool", "commit.gpgsign"]).as_deref() == Some("true")
}

/// Whether git resolves a key to sign with, without reading it.
pub fn key_resolves(exec: &Exec, root: &Path) -> bool {
    ["user.signingkey", "gpg.ssh.defaultKeyCommand"]
        .iter()
        .any(|k| config(exec, root, &[k]).is_some_and(|v| !v.is_empty()))
}

/// Writes `commit.gpgsign` to the repository's own config, never the global one.
pub fn set_local(exec: &Exec, root: &Path, on: bool) -> Result<(), SignError> {
    let value = if on { "true" } else { "false" };
    let cmd = exec.git(root, None, &["config", "--local", "commit.gpgsign", value]);
    match exec.run(cmd, CONFIG_TIMEOUT) {
        Ok(out) if out.ok() => Ok(()),
        Ok(out) => Err(failed(&out.stderr, root)),
        Err(e) => Err(run_failed(e)),
    }
}

/// A date as git reads it raw: `<seconds> <+hhmm>`.
fn raw_date(s: &Sig) -> String {
    let (sign, abs) = if s.offset < 0 {
        ('-', -s.offset)
    } else {
        ('+', s.offset)
    };
    format!(
        "{} {sign}{:02}{:02}",
        s.seconds,
        abs / 3600,
        (abs % 3600) / 60
    )
}

fn failed(text: &str, root: &Path) -> SignError {
    SignError {
        details: sanitize(text, root, &[]),
    }
}

fn run_failed(e: RunError) -> SignError {
    SignError {
        details: match e {
            RunError::Absent => "git is not installed".into(),
            RunError::Timeout => "the signer did not answer in time".into(),
            RunError::Cancelled => "stopped".into(),
            RunError::Io(k) => k,
        },
    }
}

/// The commit object for `tree` with `parents`, signed by git. The message goes on stdin, the
/// author and committer (with their dates) through the environment, so the commit is exactly the
/// one Writer would have written unsigned. Returns the commit id; no reference moves.
pub fn commit_tree(
    exec: &Exec,
    root: &Path,
    tree: &str,
    parents: &[String],
    message: &[u8],
    author: &Sig,
    committer: &Sig,
) -> Result<String, SignError> {
    let mut args: Vec<&str> = vec!["commit-tree", "-S"];
    for p in parents {
        args.extend(["-p", p]);
    }
    args.push(tree);
    let mut cmd = exec.git(root, None, &args);
    cmd.env("GIT_AUTHOR_NAME", &author.name)
        .env("GIT_AUTHOR_EMAIL", &author.email)
        .env("GIT_AUTHOR_DATE", raw_date(author))
        .env("GIT_COMMITTER_NAME", &committer.name)
        .env("GIT_COMMITTER_EMAIL", &committer.email)
        .env("GIT_COMMITTER_DATE", raw_date(committer));
    let opts = RunOptions::new(exec.budget(SIGN_TIMEOUT).map_err(run_failed)?)
        .stdin(String::from_utf8_lossy(message).into_owned());
    let out = run_bounded(exec.spawner(), cmd, &opts).map_err(run_failed)?;
    let id = out.stdout.trim();
    if out.ok() && !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(id.to_string())
    } else {
        Err(failed(&format!("{}\n{}", out.stderr, out.stdout), root))
    }
}
