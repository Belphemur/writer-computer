//! Device-local state of the feature in a vault: `.writer/git/state.json` (the managed ignore
//! block keeps `.writer/git/` out of the repository, so it never syncs): the pause flag and
//! "stopped", Writer's setup record seen from the other side. Stopping version history for a
//! vault never touches `.git`; it only records that Writer must not set the vault up again by
//! itself.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct State {
    #[serde(default)]
    paused: bool,
    /// The user chose "Stop version history": no automatic setup, no automatic commit.
    #[serde(default)]
    stopped: bool,
}

fn path(root: &Path) -> PathBuf {
    root.join(".writer/git/state.json")
}

fn read(root: &Path) -> State {
    std::fs::read_to_string(path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<State>(&t).ok())
        .unwrap_or_default()
}

fn write(root: &Path, state: &State) -> io::Result<()> {
    let file = path(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    std::fs::write(file, text)
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
