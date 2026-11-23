//! Writer's binary as a git credential helper (ADR 2026-11-18 point 3, spec "Credentials"):
//! `writer git-credential --source <token|gh> --service <keychain service> get` speaks git's
//! credential protocol (key=value lines on stdin, a blank line ends the request) and answers with
//! the HTTPS password from the secret `features.git.token` or from `gh auth token`, read at the
//! moment of use and never copied. It answers only `get`, only over `https`, for the token only the
//! host it was saved for (`--host`, recorded when the token was saved), and for the `gh` source
//! only a GitHub host. It is registered as git's only helper for Writer's calls
//! (`transport::Helper::config_args`), so git never offers the token to the user's helpers.
//!
//! The answer is a [`Lookup`] away from the keychain and from `gh` (the helper process has no
//! app), so tests drive [`answer`] with plain closures. Nothing here logs.

use super::transport::{Exec, Source};
use std::io::{BufRead, Write};

/// What git asked about.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub protocol: String,
    pub host: String,
    pub username: Option<String>,
}

/// The key=value lines of a request, up to the blank line.
pub fn parse_request(input: impl BufRead) -> Request {
    let mut r = Request::default();
    for line in input.lines().map_while(Result::ok) {
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        match line.split_once('=') {
            Some(("protocol", v)) => r.protocol = v.to_string(),
            Some(("host", v)) => r.host = v.to_string(),
            Some(("username", v)) if !v.is_empty() => r.username = Some(v.to_string()),
            _ => {}
        }
    }
    r
}

/// Where passwords come from.
pub struct Lookup<'a> {
    /// The secret `features.git.token`.
    pub token: &'a dyn Fn() -> Option<String>,
    /// `gh auth token --hostname <host>`.
    pub gh: &'a dyn Fn(&str) -> Option<String>,
}

fn github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".ghe.com")
}

/// The helper's reply to `op` for `req`, or nothing (git then tries the next helper or fails).
/// `bound` is the host the token was saved for: the token answers that host only.
pub fn answer(
    op: &str,
    req: &Request,
    source: Source,
    bound: Option<&str>,
    lookup: &Lookup<'_>,
) -> Option<String> {
    if op != "get" || req.protocol != "https" || req.host.is_empty() {
        return None;
    }
    let password = match source {
        Source::Token if bound.is_some_and(|h| h.eq_ignore_ascii_case(&req.host)) => {
            (lookup.token)()
        }
        Source::Token => None,
        Source::Gh if github_host(&req.host) => (lookup.gh)(&req.host),
        Source::Gh => None,
    }?;
    let username = req.username.as_deref().unwrap_or("git");
    Some(format!("username={username}\npassword={password}\n\n"))
}

/// The helper process: reads the request from `input`, writes the reply to `out`. Exit code 0.
pub fn run(args: &[String], input: impl BufRead, out: &mut impl Write, lookup: &Lookup<'_>) -> u8 {
    let mut source = Source::Token;
    let mut host: Option<&str> = None;
    let mut op = "";
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--source" => {
                if let Some(s) = it.next().and_then(|v| Source::parse(v)) {
                    source = s;
                }
            }
            "--service" => {
                it.next();
            }
            "--host" => host = it.next().map(String::as_str),
            other if !other.starts_with("--") => op = other,
            _ => {}
        }
    }
    let req = parse_request(input);
    if let Some(reply) = answer(op, &req, source, host, lookup) {
        let _ = out.write_all(reply.as_bytes());
    }
    0
}

/// The value of `--service` in the helper's arguments.
pub fn service_of(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find(|w| w[0] == "--service")
        .map(|w| w[1].as_str())
}

/// Entry of the real helper process (`main.rs`): the keychain is the secret store of the build
/// named by `--service`, `gh` runs detached from any feature scope (this process has none).
pub fn run_process(args: &[String]) -> u8 {
    use crate::plugin_secrets::{KeyringBackend, PluginSecrets};
    let service = service_of(args)
        .map(str::to_string)
        .unwrap_or_else(|| PluginSecrets::service_name(crate::index::paths::RELEASE_IDENTIFIER));
    let store = PluginSecrets::new(Box::new(KeyringBackend::new(service)));
    let exec = Exec::new(crate::features::scope::Spawner::detached());
    let token = || {
        crate::features::secrets::secret_with(&store, "git", "features.git.token")
            .ok()
            .flatten()
            .map(|v| v.expose().to_string())
            .filter(|t| !t.is_empty())
    };
    let gh = |host: &str| super::gh::auth_token(&exec, host);
    let stdin = std::io::stdin();
    run(
        args,
        stdin.lock(),
        &mut std::io::stdout(),
        &Lookup {
            token: &token,
            gh: &gh,
        },
    )
}

#[cfg(test)]
#[path = "credential_tests.rs"]
mod tests;
