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
    /// git says it has no name or email for the commit: the no-identity error, not a signing one.
    pub no_identity: bool,
}

impl SignError {
    fn new(details: impl Into<String>) -> SignError {
        SignError {
            details: details.into(),
            no_identity: false,
        }
    }
}

/// One value of git's effective configuration for `root`, `None` when unset or git failed.
fn config(exec: &Exec, root: &Path, args: &[&str]) -> Option<String> {
    let mut all = vec!["config", "--get"];
    all.extend_from_slice(args);
    let out = exec.run(exec.git(root, None, &all), CONFIG_TIMEOUT).ok()?;
    out.ok().then(|| out.stdout.trim().to_string())
}

/// Whether git's configuration says commits are signed, failing closed: `Ok(false)` only when git
/// says the setting is unset (exit 1) or is not installed; a read that fails, times out, is cut by
/// a deadline or is stopped is an error, and the caller makes no commit (never an unsigned one
/// because the question could not be answered).
pub fn mode(exec: &Exec, root: &Path) -> Result<bool, SignError> {
    let cmd = exec.git(
        root,
        None,
        &["config", "--get", "--type=bool", "commit.gpgsign"],
    );
    match exec.run(cmd, CONFIG_TIMEOUT) {
        Err(RunError::Absent) => Ok(false),
        Err(e) => Err(run_failed(e)),
        Ok(out) if out.ok() => match out.stdout.trim() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(SignError::new("unreadable commit.gpgsign")),
        },
        Ok(out) if out.code == Some(1) => Ok(false),
        Ok(out) => Err(failed(&out.stderr, root)),
    }
}

/// [`mode`] for the status: a question that cannot be answered reads as off there (a commit asks
/// again and fails closed).
pub fn enabled(exec: &Exec, root: &Path) -> bool {
    mode(exec, root).unwrap_or(false)
}

/// Whether git resolves a key to sign with, without reading it: `user.signingkey`, an ssh default
/// key command, or OpenPGP's own default (`gpg.format` unset or `openpgp`: the first signature
/// decides, Writer never runs the signer to find out).
pub fn key_resolves(exec: &Exec, root: &Path) -> bool {
    let openpgp =
        config(exec, root, &["gpg.format"]).is_none_or(|f| f.is_empty() || f == "openpgp");
    openpgp
        || ["user.signingkey", "gpg.ssh.defaultKeyCommand"]
            .iter()
            .any(|k| config(exec, root, &[k]).is_some_and(|v| !v.is_empty()))
}

/// Writes `commit.gpgsign` to the repository's own config, never the global one.
pub fn set_local(exec: &Exec, root: &Path, on: bool) -> Result<(), SignError> {
    match exec.config_local(root, "commit.gpgsign", if on { "true" } else { "false" }) {
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
    SignError::new(sanitize(text, root, &[]))
}

fn run_failed(e: RunError) -> SignError {
    SignError::new(match e {
        RunError::Absent => "git is not installed".into(),
        RunError::Timeout => "git or the signer did not answer in time".to_string(),
        RunError::Cancelled => "stopped".into(),
        RunError::Io(k) => k,
    })
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
    // git re-encodes a message that is not UTF-8 on its way in (guessing Latin-1) and so writes
    // another message than the one given: refused, not altered
    if std::str::from_utf8(message).is_err() {
        return Err(SignError::new(
            "git would re-encode this commit message, which is not UTF-8",
        ));
    }
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
    let out = exec
        .run_with(cmd, SIGN_TIMEOUT, Some(message.to_vec()))
        .map_err(run_failed)?;
    let id = out.stdout.trim();
    if out.ok() && !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return same_identities(exec, root, id, author, committer).map(|()| id.to_string());
    }
    let mut e = failed(&format!("{}\n{}", out.stderr, out.stdout), root);
    e.no_identity = super::system::is_identity_error(&out.stderr);
    Err(e)
}

/// git cleans a name or email on its way in (what it strips depends on its version) and would
/// write the commit differently from the one Writer means to make: read back what it wrote and
/// refuse a commit whose author or committer line is not the one asked for, rather than diverge.
/// The object stays unreferenced.
fn same_identities(
    exec: &Exec,
    root: &Path,
    id: &str,
    author: &Sig,
    committer: &Sig,
) -> Result<(), SignError> {
    let line = |who: &Sig| format!("{} <{}> {}", who.name, who.email, raw_date(who));
    let cmd = exec.git(root, None, &["cat-file", "commit", id]);
    let out = exec.run(cmd, CONFIG_TIMEOUT).map_err(run_failed)?;
    let header = |key: &str| {
        out.stdout
            .lines()
            .take_while(|l| !l.is_empty())
            .find_map(|l| l.strip_prefix(key))
            .map(str::to_string)
    };
    if out.ok()
        && header("author ").as_deref() == Some(&line(author))
        && header("committer ").as_deref() == Some(&line(committer))
    {
        Ok(())
    } else {
        Err(SignError::new(
            "git would change the author or committer name or email of this commit",
        ))
    }
}
