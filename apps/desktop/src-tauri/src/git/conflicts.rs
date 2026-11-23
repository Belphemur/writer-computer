//! The files a sync could not settle (`.writer/git/conflicts.json`, device-local: the managed
//! ignore block keeps `.writer/git/` out of the repository). A conflicted file keeps the user's
//! version on disk (never conflict markers) and is never committed until the conflict is resolved
//! (the merge view clears it on Save, `resolve.rs`), so a later automatic version cannot silently
//! overwrite the other side. A binary that changed on both sides also leaves its conflict copy
//! listed here.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

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
    /// The blob both sides started from (`None`: there was no common version). The merge view
    /// merges it with the file as it is now and the other side's version.
    #[serde(default)]
    pub base: Option<String>,
    /// Where the other side's version lives when it is not at `path`: a file renamed on one side
    /// and edited (or renamed differently) on the other. `path` is always where mine is on disk.
    #[serde(default)]
    pub theirs_path: Option<String>,
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
    /// Paths a remote tree held that a sync refused to write (`.git` in any spelling, the
    /// device-local `.writer/git`, a path through a symlink): never written, listed for the user.
    #[serde(default)]
    pub refused: Vec<String>,
}

const FILE: &str = "conflicts.json";

pub fn read(root: &Path) -> Book {
    std::fs::read_to_string(super::local_path(root, FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Writes the book atomically (removes the file when it holds nothing). Callers hold the
/// repository's write lock (the app) or are the only writer (the CLI).
pub fn write(root: &Path, book: &Book) -> io::Result<()> {
    if book.files.is_empty()
        && book.copies.is_empty()
        && book.restored.is_empty()
        && book.refused.is_empty()
    {
        return super::remove_local(root, FILE);
    }
    super::write_local(
        root,
        FILE,
        &serde_json::to_string_pretty(book).map_err(io::Error::other)?,
    )
}

/// The records still open among `book`: a conflict the user settled (the file is back at HEAD's
/// version, or gone, so it is no longer among `pending`) is not. Read-only; [`forget_settled`]
/// is the write.
pub fn open_among(book: &Book, pending: &[super::Change]) -> Vec<Record> {
    book.files
        .iter()
        .filter(|r| pending.iter().any(|c| c.path() == r.path))
        .cloned()
        .collect()
}

/// Forgets the conflicts the user settled outside the merge view. Run under the write lock, by
/// the commits and the sync, never by a status read.
pub fn forget_settled(root: &Path, pending: &[super::Change]) -> io::Result<()> {
    let mut book = read(root);
    let open = open_among(&book, pending);
    if open.len() != book.files.len() {
        book.files = open;
        write(root, &book)?;
    }
    Ok(())
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

/// The record of one conflicted file.
pub fn find(root: &Path, path: &str) -> Option<Record> {
    read(root).files.into_iter().find(|r| r.path == path)
}

/// Forget one binary's copy notice (the user chose what to keep).
pub fn clear_copy(root: &Path, path: &str) -> io::Result<()> {
    let mut book = read(root);
    let before = book.copies.len();
    book.copies.retain(|(p, _)| p != path);
    if book.copies.len() != before {
        write(root, &book)?;
    }
    Ok(())
}

/// Forget the copies and restored notices ("Dismiss" in the panel).
pub fn dismiss_notices(root: &Path) -> io::Result<()> {
    let mut book = read(root);
    book.copies.clear();
    book.restored.clear();
    book.refused.clear();
    write(root, &book)
}
