//! The GitHub CLI, when the user has it: "Sign in with GitHub" is `gh repo create <name> --private`
//! with the remote linked over HTTPS, and the credential helper's `gh` source is `gh auth token`
//! read at the moment of use. Both run through [`Exec`] (the feature scope's children). Without
//! `gh` the page offers "Install GitHub CLI": the device flow needs an OAuth App client id that
//! does not exist yet (spec "Setup", open item), so nothing here invents one.

use super::transport::{classify, Exec, Output, RunError, TransportError, QUICK_TIMEOUT};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// `gh` is not installed.
    Missing,
    SignedOut,
    SignedIn,
}

pub fn state(exec: &Exec) -> State {
    match exec.run(exec.gh(&["--version"]), QUICK_TIMEOUT) {
        Err(RunError::Absent) => return State::Missing,
        Err(_) => return State::SignedOut,
        Ok(_) => {}
    }
    match exec.run(exec.gh(&["auth", "status"]), QUICK_TIMEOUT) {
        Ok(o) if o.ok() => State::SignedIn,
        _ => State::SignedOut,
    }
}

/// The token `gh` holds for `host`; never stored by Writer.
pub fn auth_token(exec: &Exec, host: &str) -> Option<String> {
    let out = exec
        .run(
            exec.gh(&["auth", "token", "--hostname", host]),
            QUICK_TIMEOUT,
        )
        .ok()?;
    let token = out.stdout.trim();
    (out.ok() && !token.is_empty()).then(|| token.to_string())
}

/// A GitHub repository name from a vault folder name: letters, digits, `-`, `_` and `.`.
pub fn repo_name(vault: &str) -> String {
    let name: String = vault
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches(['-', '.']).to_string();
    if name.is_empty() {
        "vault".into()
    } else {
        name
    }
}

fn url_in(out: &Output) -> Option<String> {
    out.stdout
        .split_whitespace()
        .chain(out.stderr.split_whitespace())
        .rev()
        .find(|w| w.starts_with("https://"))
        .map(|w| w.trim_end_matches(['.', ',']).to_string())
}

/// Creates the private repository `name` on the signed-in account and returns its HTTPS URL.
pub fn create_repo(exec: &Exec, root: &Path, name: &str) -> Result<String, TransportError> {
    let out = exec
        .run(
            exec.gh(&["repo", "create", name, "--private"]),
            std::time::Duration::from_secs(60),
        )
        .map_err(|e| match e {
            RunError::Absent => TransportError {
                kind: super::transport::Kind::NoGit,
                line: "GitHub CLI is not installed".into(),
                details: String::new(),
            },
            other => classify(
                &Output {
                    code: None,
                    stdout: String::new(),
                    stderr: format!("{other:?}"),
                },
                root,
                &[],
            ),
        })?;
    if !out.ok() {
        return Err(classify(&out, root, &[]));
    }
    url_in(&out).ok_or(TransportError {
        kind: super::transport::Kind::Other,
        line: "GitHub did not return the repository URL".into(),
        details: String::new(),
    })
}
