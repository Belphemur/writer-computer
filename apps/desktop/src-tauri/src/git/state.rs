//! Device-local state of the feature in a vault: `.writer/git/state.json` (the managed ignore
//! block keeps `.writer/git/` out of the repository). Only the pause flag today.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct State {
    #[serde(default)]
    paused: bool,
}

fn path(root: &Path) -> PathBuf {
    root.join(".writer/git/state.json")
}

pub fn paused(root: &Path) -> bool {
    std::fs::read_to_string(path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<State>(&t).ok())
        .is_some_and(|s| s.paused)
}

pub fn set_paused(root: &Path, paused: bool) -> io::Result<()> {
    let file = path(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(&State { paused }).map_err(io::Error::other)?;
    std::fs::write(file, text)
}
