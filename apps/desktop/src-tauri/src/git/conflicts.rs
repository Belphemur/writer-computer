//! The files a sync could not settle (`.writer/git/conflicts.json`, device-local: the managed
//! ignore block keeps `.writer/git/` out of the repository). A conflicted file keeps the user's
//! version on disk (never conflict markers) and is never committed until the conflict is resolved
//! (phase 4's merge view clears it on Save), so a later automatic version cannot silently overwrite
//! the other side. A binary that changed on both sides also leaves its conflict copy listed here.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// One file that needs the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub path: String,
    /// Overlapping line hunks.
    #[serde(default)]
    pub hunks: u32,
    /// Front matter properties both sides changed differently.
    #[serde(default)]
    pub properties: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Book {
    #[serde(default)]
    pub files: Vec<Record>,
    /// Binary files kept beside the remote's version, `(path, conflict copy)`.
    #[serde(default)]
    pub copies: Vec<(String, String)>,
    /// Files restored because one side deleted what the other edited.
    #[serde(default)]
    pub restored: Vec<String>,
}

fn path(root: &Path) -> PathBuf {
    root.join(".writer/git/conflicts.json")
}

pub fn read(root: &Path) -> Book {
    std::fs::read_to_string(path(root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write(root: &Path, book: &Book) -> io::Result<()> {
    let file = path(root);
    if book.files.is_empty() && book.copies.is_empty() && book.restored.is_empty() {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        file,
        serde_json::to_string_pretty(book).map_err(io::Error::other)?,
    )
}

/// The conflicted paths (never committed).
pub fn paths(root: &Path) -> Vec<String> {
    read(root).files.into_iter().map(|r| r.path).collect()
}

/// The user resolved `path` (or it is gone): forget its conflict.
pub fn clear(root: &Path, path: &str) -> io::Result<()> {
    let mut book = read(root);
    let before = book.files.len();
    book.files.retain(|r| r.path != path);
    if book.files.len() != before {
        write(root, &book)?;
    }
    Ok(())
}

/// Forget the copies and restored notices ("Dismiss" in the panel).
pub fn dismiss_notices(root: &Path) -> io::Result<()> {
    let mut book = read(root);
    book.copies.clear();
    book.restored.clear();
    write(root, &book)
}
