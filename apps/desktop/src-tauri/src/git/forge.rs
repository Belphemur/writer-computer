//! The forge CLIs, when the user has one: the one table of them ([`FORGES`], GitHub's `gh` and
//! Forgejo's `fj` are its entries) and the code every entry shares. A forge CLI gives Writer three
//! things, each an entry's own function: the hosts it is signed in to, the token for one host
//! read at the moment of use (never stored by Writer), and the command that creates a private
//! repository, which is then linked over HTTPS ("Sign in with GitHub", "Sign in with Forgejo").
//! Everything runs through [`Exec`] (the feature scope's children, bounded). Without the CLI the
//! page offers "Install <CLI>": the device flow needs an OAuth App client id that does not exist
//! yet (spec "Setup", open item), so nothing here invents one.
//!
//! Adding a forge is one more entry: a `static FORGE` in its own file and a line in [`FORGES`].

use super::transport::{classify, Exec, Kind, Output, RunError, TransportError, QUICK_TIMEOUT};
use std::path::Path;

/// Every forge CLI Writer can sign in through, in the order the settings page lists them. A third
/// one is its own file with a `static FORGE` and one line here.
pub static FORGES: &[&Forge] = &[&super::github::FORGE, &super::forgejo::FORGE];

pub fn by_id(id: &str) -> Option<&'static Forge> {
    FORGES.iter().copied().find(|f| f.id == id)
}

/// One forge CLI. The strings are the one place its labels are written.
pub struct Forge {
    /// The credential source's name (`gh`, `fj`): the helper's `--source` and the device-local
    /// state. Also the binary's name.
    pub id: &'static str,
    /// The program to run.
    pub binary: &'static str,
    /// Arguments that make it print its version and nothing else (the "is it installed" probe).
    pub version: &'static [&'static str],
    /// The forge's name, "GitHub".
    pub site: &'static str,
    /// The CLI's name, "GitHub CLI".
    pub label: &'static str,
    /// The command that signs the user in, "gh auth login".
    pub login: &'static str,
    /// Where "Install <CLI>" goes.
    pub install_url: &'static str,
    /// Its saved login expires: a refused push says "Sign in again: <login>".
    pub expires: bool,
    /// The hosts it is signed in to (empty: its own default host), `None` when it is signed out.
    pub signed_in: fn(&Exec) -> Option<Vec<String>>,
    /// The token it holds for `host`.
    pub token: fn(&Exec, &str) -> Option<String>,
    /// Whether the credential helper answers `host` (git's `host=`), given the host the user
    /// bound this vault to.
    pub accepts: fn(host: &str, bound: Option<&str>) -> bool,
    /// The arguments of "create the private repository `name`" (on `host` when given).
    pub create: fn(host: Option<&str>, name: &str) -> Vec<String>,
    /// The login of the signed-in account on `host`: the owner of a repository to link.
    pub owner: fn(&Exec, host: Option<&str>) -> Option<String>,
    /// The host of a CLI that has one default and lists none.
    pub default_host: Option<&'static str>,
}

impl Forge {
    /// "Sign in with GitHub".
    pub fn sign_in(&self) -> String {
        format!("Sign in with {}", self.site)
    }

    /// "Install GitHub CLI".
    pub fn install(&self) -> String {
        format!("Install {}", self.label)
    }
}

impl PartialEq for Forge {
    fn eq(&self, other: &Forge) -> bool {
        self.id == other.id
    }
}

impl Eq for Forge {}

impl std::fmt::Debug for Forge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// The CLI is not installed.
    Missing,
    SignedOut,
    SignedIn,
}

impl State {
    /// The word the settings page switches on.
    pub fn arg(self) -> &'static str {
        match self {
            State::Missing => "missing",
            State::SignedOut => "signed-out",
            State::SignedIn => "signed-in",
        }
    }
}

/// What the machine has for one forge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub state: State,
    /// The hosts it is signed in to; empty when signed out or when the CLI has one default host.
    pub hosts: Vec<String>,
}

pub fn probe(exec: &Exec, forge: &Forge) -> Probe {
    let state = |state| Probe {
        state,
        hosts: Vec::new(),
    };
    match exec.run(exec.tool(forge.binary, forge.version), QUICK_TIMEOUT) {
        Err(RunError::Absent) => return state(State::Missing),
        Err(_) => return state(State::SignedOut),
        Ok(_) => {}
    }
    match (forge.signed_in)(exec) {
        Some(hosts) => Probe {
            state: State::SignedIn,
            hosts,
        },
        None => state(State::SignedOut),
    }
}

/// A repository name from a vault folder name: letters, digits, `-`, `_` and `.` (the rule of
/// every forge Writer signs in through).
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

/// Creates the private repository `name` on the signed-in account (of `host`, for a forge with
/// several) and returns its HTTPS URL.
pub fn create_repo(
    exec: &Exec,
    root: &Path,
    forge: &Forge,
    host: Option<&str>,
    name: &str,
) -> Result<String, TransportError> {
    let args = (forge.create)(host, name);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = exec
        .run(
            exec.tool(forge.binary, &args),
            std::time::Duration::from_secs(60),
        )
        .map_err(|e| match e {
            RunError::Absent => TransportError {
                kind: Kind::NoGit,
                line: format!("{} is not installed", forge.label),
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
        let mut e = classify(&out, root, &[]);
        // both CLIs relay the forge's "already exists" for a repository name in use
        if format!("{}{}", out.stdout, out.stderr)
            .to_ascii_lowercase()
            .contains("already exist")
        {
            e.kind = Kind::Taken;
            e.line = format!("Name taken: {name}");
        }
        return Err(e);
    }
    url_in(&out).ok_or(TransportError {
        kind: Kind::Other,
        line: format!("{} did not return the repository URL", forge.site),
        details: String::new(),
    })
}

#[cfg(test)]
#[path = "forge_tests.rs"]
pub(crate) mod tests;
