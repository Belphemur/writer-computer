//! "Sign in with GitHub" / "Sign in with Forgejo" as one action (ADR 2026-11-18, note of
//! 2026-11-23): everything a hand-made setup needed, in three steps, each reported, the first
//! failure stopping the action (the steps after it stay pending):
//!
//! 1. **Remote**: a remote already linked on the chosen host is used as it is; with none, the
//!    forge CLI creates `<vault name>` as a private repository and it is linked as `origin` over
//!    HTTPS. A name already taken is reported as such ([`Outcome::taken`]), so the panel can offer
//!    "Link existing <name>" (`link_existing`: the repository of that name under the signed-in
//!    user's own login, never another owner's) or another name. A remote on another host or over
//!    SSH is never overwritten: the step fails.
//! 2. **Credential**: the source becomes the forge CLI, bound to the remote's host. Writer creates
//!    no token and touches no keychain.
//! 3. **First push**: the branch tracks `origin/<branch>` (`branch.<b>.remote` / `.merge`, the
//!    repository's own config through git), then `push` runs a whole sync (fetch, replay, push).
//!
//! Tauri-free: the app gives the sync as a closure. Every failed step carries its kind
//! ([`super::transport::Kind::name`]), so a "Show logs" button is one line in the panel.

use super::forge::{self, Forge};
use super::state;
use super::transport::{self, Exec, Helper, Kind, Source, Transport, TransportError};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepId {
    Remote,
    Credential,
    Push,
}

impl StepId {
    pub const ALL: [StepId; 3] = [StepId::Remote, StepId::Credential, StepId::Push];

    pub fn name(self) -> &'static str {
        match self {
            StepId::Remote => "remote",
            StepId::Credential => "credential",
            StepId::Push => "push",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    Done,
    Failed,
    /// Not reached: an earlier step failed.
    Pending,
}

impl StepState {
    pub fn name(self) -> &'static str {
        match self {
            StepState::Done => "done",
            StepState::Failed => "failed",
            StepState::Pending => "pending",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub id: StepId,
    pub state: StepState,
    /// Terse: what was linked, who answers, "Synced", or why it failed (no path, no secret).
    pub line: String,
    /// [`Kind::name`] of a failure, empty otherwise.
    pub kind: &'static str,
}

/// A failed step's words and kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepError {
    pub line: String,
    pub kind: &'static str,
}

impl From<TransportError> for StepError {
    fn from(e: TransportError) -> StepError {
        StepError {
            line: e.line,
            kind: e.kind.name(),
        }
    }
}

fn failed(line: &str) -> StepError {
    StepError {
        line: line.into(),
        kind: Kind::Other.name(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// The three steps in order.
    pub steps: Vec<Step>,
    /// The name the host already has: offer "Link existing <name>" or another name.
    pub taken: Option<String>,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.steps.iter().all(|s| s.state == StepState::Done)
    }
}

pub struct Request<'a> {
    pub forge: &'static Forge,
    /// The host chosen (for a CLI signed in to several), `None` for one with a default host.
    pub host: Option<&'a str>,
    /// The repository name when the user typed one; the vault's name otherwise.
    pub name: Option<&'a str>,
    /// Link the repository of that name under the signed-in user instead of creating it.
    pub link_existing: bool,
}

/// Runs the action in the vault at `root`. `helper` is the credential helper of the vault, asked
/// after step 2 (the source has changed by then); `push` is one whole sync.
pub fn run(
    exec: &Exec,
    root: &Path,
    req: &Request<'_>,
    helper: &dyn Fn() -> Option<Helper>,
    push: &dyn Fn() -> Result<(), StepError>,
) -> Outcome {
    let mut out = Outcome {
        steps: Vec::new(),
        taken: None,
    };
    let step = |out: &mut Outcome, id, result: Result<String, StepError>| {
        let ok = result.is_ok();
        out.steps.push(match result {
            Ok(line) => Step {
                id,
                state: StepState::Done,
                line,
                kind: "",
            },
            Err(e) => Step {
                id,
                state: StepState::Failed,
                line: e.line,
                kind: e.kind,
            },
        });
        ok
    };

    let remote = remote_step(exec, root, req, &mut out.taken);
    let url = remote.as_ref().ok().cloned();
    let ok = step(
        &mut out,
        StepId::Remote,
        remote.map(|u| transport::display_url(&u)),
    );
    let url = url.filter(|_| ok);
    if let Some(url) = url {
        let credential = credential_step(root, req.forge, &url);
        if step(&mut out, StepId::Credential, credential) {
            let pushed = push_step(exec, root, helper().as_ref(), push);
            step(&mut out, StepId::Push, pushed);
        }
    }
    for id in StepId::ALL {
        if !out.steps.iter().any(|s| s.id == id) {
            out.steps.push(Step {
                id,
                state: StepState::Pending,
                line: String::new(),
                kind: "",
            });
        }
    }
    out
}

fn remote_step(
    exec: &Exec,
    root: &Path,
    req: &Request<'_>,
    taken: &mut Option<String>,
) -> Result<String, StepError> {
    let f = req.forge;
    let t = Transport {
        exec,
        root,
        helper: None,
        secrets: Vec::new(),
    };
    if let Some(existing) = t.remote_url() {
        // used as it is when it is on the chosen host, never replaced by another
        return match transport::https_host(&existing) {
            Some(h) if (f.accepts)(&h, req.host) => Ok(existing),
            _ => Err(failed("A remote is already linked: remove it first")),
        };
    }
    let name = forge::repo_name(&match req.name {
        Some(n) if !n.trim().is_empty() => n.to_string(),
        _ => root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    });
    let url = if req.link_existing {
        own_url(exec, f, req.host, &name)?
    } else {
        match forge::create_repo(exec, root, f, req.host, &name) {
            // the URL the CLI prints is the forge's own idea of its address (Forgejo's ROOT_URL may
            // differ from the host the user is signed in to): only one on the chosen host is
            // linked, otherwise the address is built from the host, the owner and the name, so the
            // credential stays bound to the host the CLI is signed in to
            Ok(url) if transport::https_host(&url).is_some_and(|h| (f.accepts)(&h, req.host)) => {
                url
            }
            Ok(_) => own_url(exec, f, req.host, &name)?,
            Err(e) => {
                if e.kind == Kind::Taken {
                    *taken = Some(name);
                }
                return Err(e.into());
            }
        }
    };
    t.set_remote(&url)?;
    Ok(url)
}

/// `https://<host>/<owner>/<name>.git`: the repository of that name under the signed-in account on
/// the chosen host (never another owner's).
fn own_url(
    exec: &Exec,
    f: &'static Forge,
    host: Option<&str>,
    name: &str,
) -> Result<String, StepError> {
    let host = host
        .or(f.default_host)
        .ok_or_else(|| failed("Choose a host"))?;
    let owner = (f.owner)(exec, Some(host)).ok_or_else(|| failed("Could not read the account"))?;
    Ok(format!("https://{host}/{owner}/{name}.git"))
}

fn credential_step(root: &Path, f: &'static Forge, url: &str) -> Result<String, StepError> {
    state::set_credential_source(root, Source::Cli(f))
        .and_then(|()| state::set_token_host(root, transport::https_host(url)))
        .map_err(|_| failed("Could not save the sign-in"))?;
    Ok(f.label.to_string())
}

fn push_step(
    exec: &Exec,
    root: &Path,
    helper: Option<&Helper>,
    push: &dyn Fn() -> Result<(), StepError>,
) -> Result<String, StepError> {
    let branch = super::Repo::open(root)
        .ok()
        .flatten()
        .and_then(|r| r.head_branch())
        .ok_or_else(|| failed("No branch to sync"))?;
    Transport {
        exec,
        root,
        helper,
        secrets: Vec::new(),
    }
    .set_tracking(&branch)?;
    push()?;
    Ok("Synced".into())
}

#[cfg(test)]
#[path = "signin_tests.rs"]
mod tests;
