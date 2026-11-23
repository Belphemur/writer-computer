//! Device-local state of the feature in a vault: `.writer/git/state.json` (the managed ignore
//! block keeps `.writer/git/` out of the repository, so it never syncs): the pause flag and
//! "stopped", Writer's setup record seen from the other side. Stopping version history for a
//! vault never touches `.git`; it only records that Writer must not set the vault up again by
//! itself.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct State {
    #[serde(default)]
    paused: bool,
    /// The user chose "Stop version history": no automatic setup, no automatic commit.
    #[serde(default)]
    stopped: bool,
    /// "Pause sync": versions go on, nothing is fetched or pushed.
    #[serde(default)]
    sync_paused: bool,
    /// Where HTTPS passwords come from (`token` or `gh`), the choice of Settings > Git.
    #[serde(default)]
    credentials: Option<String>,
    /// The host the token was saved for: Writer's helper answers no other.
    #[serde(default)]
    token_host: Option<String>,
}

const FILE: &str = "state.json";

fn read(root: &Path) -> State {
    std::fs::read_to_string(super::local_path(root, FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<State>(&t).ok())
        .unwrap_or_default()
}

fn write(root: &Path, state: &State) -> io::Result<()> {
    let text = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    super::write_local(root, FILE, &text)
}

pub fn paused(root: &Path) -> bool {
    read(root).paused
}

pub fn stopped(root: &Path) -> bool {
    read(root).stopped
}

pub fn set_paused(root: &Path, paused: bool) -> io::Result<()> {
    write(
        root,
        &State {
            paused,
            ..read(root)
        },
    )
}

pub fn set_stopped(root: &Path, stopped: bool) -> io::Result<()> {
    write(
        root,
        &State {
            stopped,
            ..read(root)
        },
    )
}

pub fn sync_paused(root: &Path) -> bool {
    read(root).sync_paused
}

pub fn set_sync_paused(root: &Path, sync_paused: bool) -> io::Result<()> {
    write(
        root,
        &State {
            sync_paused,
            ..read(root)
        },
    )
}

/// The credential source the user chose for this vault's remote (the token by default).
pub fn credential_source(root: &Path) -> super::transport::Source {
    read(root)
        .credentials
        .as_deref()
        .and_then(super::transport::Source::parse)
        .unwrap_or(super::transport::Source::Token)
}

pub fn set_credential_source(root: &Path, source: super::transport::Source) -> io::Result<()> {
    write(
        root,
        &State {
            credentials: Some(source.arg().to_string()),
            ..read(root)
        },
    )
}

/// The host the saved token belongs to.
pub fn token_host(root: &Path) -> Option<String> {
    read(root).token_host
}

pub fn set_token_host(root: &Path, host: Option<String>) -> io::Result<()> {
    write(
        root,
        &State {
            token_host: host,
            ..read(root)
        },
    )
}
