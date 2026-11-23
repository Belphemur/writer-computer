//! Settling a conflict (spec `SPECs/git-sync-spec.md` "Merge view"): what the merge view and
//! `writer git:resolve` do. Tauri-free, so the app and the CLI share it.
//!
//! A conflicted file keeps the user's version on disk (never conflict markers) and is never
//! committed until it is settled here. Settling is one path for every way in:
//!
//! 1. the result is written through the app's one atomic write (`vault_ops`), after the editors
//!    that have the file open are told ([`Announce`]);
//! 2. the conflict is forgotten (`conflicts.json`), so the file is an ordinary change again;
//! 3. the file is committed on top of HEAD as `user(merge)`: that completes what the interrupted
//!    replay left out, and the next sync pushes it.
//!
//! Cancel is the absence of all of it: nothing is written, the file stays conflicted.

use super::conflicts::{self, Record};
use super::merge::{self, Part, PropertyConflict, Side};
use super::message::{Change, Message, Scope};
use super::repo::{self, Repo};
use crate::vault_ops;
use std::path::Path;

/// Called with the vault-relative files about to be written (the editors claim the watcher's events).
pub type Announce<'a> = &'a dyn Fn(&[String]);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("This file is not in conflict")]
    NotConflicted,
    #[error("This file is not text")]
    NotText,
    #[error("Choose a value for: {0}")]
    Undecided(String),
    #[error("Choose one of the file's two paths")]
    BadPath,
    #[error("The other version is gone")]
    Missing,
    #[error("The note changed; reopen")]
    Changed,
    #[error(transparent)]
    Git(#[from] repo::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

fn io(e: vault_ops::VaultOpError) -> Error {
    Error::Io(std::io::Error::other(e.to_string()))
}

/// What the merge view lays out for one conflicted text file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub path: String,
    /// Where the other side's version is when it is not at `path` (a rename).
    pub theirs_path: Option<String>,
    pub markdown: bool,
    /// The user's version as the view was opened (send it back to [`save`]).
    pub mine: String,
    pub properties: Vec<PropertyConflict>,
    /// The body: settled text and overlaps, in order.
    pub parts: Vec<Part>,
}

struct Versions {
    record: Record,
    base: String,
    theirs: String,
}

fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| Error::NotText)
}

fn head_bytes(repo: &Repo, path: &str) -> Result<Option<Vec<u8>>> {
    let Some(head) = repo.head_id_string() else {
        return Ok(None);
    };
    repo.entry_at(Some(&head), path)?
        .map(|e| repo.blob(&e.id).map_err(Error::from))
        .transpose()
}

fn versions(root: &Path, repo: &Repo, path: &str) -> Result<Versions> {
    let record = conflicts::find(root, path).ok_or(Error::NotConflicted)?;
    let theirs_at = record.theirs_path.as_deref().unwrap_or(path);
    let theirs = text(head_bytes(repo, theirs_at)?.ok_or(Error::Missing)?)?;
    let base = match &record.base {
        // an object that is gone (collected) leaves a two-way view: everything differing overlaps
        Some(id) => repo
            .blob(id)
            .ok()
            .map(text)
            .transpose()?
            .unwrap_or_default(),
        None => String::new(),
    };
    Ok(Versions {
        record,
        base,
        theirs,
    })
}

fn disk_text(root: &Path, path: &str) -> Result<String> {
    text(std::fs::read(place(root, path)?.abs)?)
}

/// The view of the conflicted file at `path`. `mine` is the user's buffer when the file is open
/// in an editor (the view must show what they see); `None` reads the file.
pub fn open(root: &Path, path: &str, mine: Option<&str>) -> Result<View> {
    let root = &root.canonicalize()?;
    let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
    let v = versions(root, &repo, path)?;
    let mine = match mine {
        Some(m) => m.to_string(),
        None => disk_text(root, path)?,
    };
    let parts = merge::view_parts(path, &v.base, &mine, &v.theirs);
    Ok(View {
        path: path.to_string(),
        theirs_path: v.record.theirs_path,
        markdown: parts.markdown,
        mine,
        properties: parts.properties,
        parts: parts.body.parts,
    })
}

/// Where a resolution may write: the sync's confinement (`.git` in any spelling, the device-local
/// `.writer/git`, nothing through a link).
fn place(root: &Path, rel: &str) -> Result<vault_ops::Confined> {
    vault_ops::confine_with(root, rel, super::sync::PROTECTED).map_err(io)
}

/// Writes `bytes` at `rel` through the one atomic write.
fn put(root: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    vault_ops::write_bytes_creating(&place(root, rel)?.abs, bytes).map_err(io)
}

fn remove(root: &Path, rel: &str) -> Result<()> {
    vault_ops::remove_file(&place(root, rel)?.abs).map_err(io)
}

fn title(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

/// Commits the pending changes of `paths` (nothing when they are as HEAD has them).
fn commit_paths(repo: &Repo, paths: &[&str], subject: &str, device: &str) -> Result<()> {
    let changes: Vec<Change> = repo
        .changes()?
        .into_iter()
        .filter(|c| {
            paths.contains(&c.path())
                || matches!(c, Change::Move { from, .. } if paths.contains(&from.as_str()))
        })
        .collect();
    if changes.is_empty() {
        return Ok(());
    }
    repo.commit(
        &changes,
        &Message::user_scoped(Scope::Merge, subject, device),
    )?;
    Ok(())
}

/// The shared tail of every resolution of a text file: write `bytes` at `final_path`, remove the
/// other path the conflict had, forget the conflict, commit.
fn finish(
    root: &Path,
    repo: &Repo,
    record: &Record,
    bytes: &[u8],
    final_path: &str,
    device: &str,
    announce: Option<Announce<'_>>,
) -> Result<()> {
    let mut paths = vec![record.path.clone()];
    paths.extend(record.theirs_path.clone());
    if !paths.iter().any(|p| p == final_path) {
        return Err(Error::BadPath);
    }
    if let Some(f) = announce {
        f(&paths);
    }
    put(root, final_path, bytes)?;
    for p in paths.iter().filter(|p| p.as_str() != final_path) {
        remove(root, p)?;
    }
    conflicts::clear(root, &record.path)?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    commit_paths(repo, &refs, &format!("Merge {}", title(final_path)), device)
}

/// What the user chose in the merge view.
pub struct Choice<'a> {
    /// The user's version as the view opened (`View::mine`).
    pub mine: &'a str,
    /// The result column.
    pub body: &'a str,
    /// The side taken for each conflicting property.
    pub picks: &'a [(String, Side)],
    /// Which path to keep when the conflict is a rename: `path` (mine) or the other. `None`: mine.
    pub final_path: Option<&'a str>,
}

/// "Save" in the merge view.
pub fn save(
    root: &Path,
    path: &str,
    choice: &Choice<'_>,
    device: &str,
    announce: Option<Announce<'_>>,
) -> Result<()> {
    let root = &root.canonicalize()?;
    let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
    let v = versions(root, &repo, path)?;
    let pick = |name: &str| {
        choice
            .picks
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, side)| *side)
    };
    let result = merge::compose(path, &v.base, choice.mine, &v.theirs, &pick, choice.body)
        .map_err(|left| {
            Error::Undecided(
                left.into_iter()
                    .map(|p| p.name)
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        })?;
    let result = with_later_edits(root, path, choice.mine, result)?;
    let final_path = choice.final_path.unwrap_or(path);
    finish(
        root,
        &repo,
        &v.record,
        result.as_bytes(),
        final_path,
        device,
        announce,
    )
}

/// The note may have changed on disk since the view opened (the editor kept saving, an agent
/// wrote it): those edits are merged into the result (`mine_at_open` the base, the disk now and
/// the result the two sides); when they overlap what the user resolved, nothing is written.
fn with_later_edits(root: &Path, path: &str, mine_at_open: &str, result: String) -> Result<String> {
    let now = match disk_text(root, path) {
        Ok(t) => t,
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(e),
    };
    if now == mine_at_open {
        return Ok(result);
    }
    match merge::merge_file(
        path,
        Some(mine_at_open.as_bytes()),
        Some(now.as_bytes()),
        Some(result.as_bytes()),
    ) {
        merge::Merged::Clean { bytes: Some(b), .. } => text(b),
        _ => Err(Error::Changed),
    }
}

/// How a whole file is settled without the merge view (`writer git:resolve`, the binary buttons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    Mine,
    Theirs,
    /// A binary: both stay, the conflict copy is kept beside the file.
    Both,
}

impl Take {
    pub fn parse(s: &str) -> Option<Take> {
        match s {
            "mine" => Some(Take::Mine),
            "theirs" => Some(Take::Theirs),
            "both" => Some(Take::Both),
            _ => None,
        }
    }
}

/// Settles `path` by taking a whole side: a text conflict takes mine (the file as it is, or its
/// path in a rename) or theirs (the other device's version); a binary takes mine (the conflict
/// copy goes over the file), theirs (the copy is dropped) or both (the copy stays).
pub fn take(
    root: &Path,
    path: &str,
    side: Take,
    device: &str,
    announce: Option<Announce<'_>>,
) -> Result<()> {
    let root = &root.canonicalize()?;
    let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
    if let Some(record) = conflicts::find(root, path) {
        let v = versions(root, &repo, path)?;
        return match side {
            Take::Mine => {
                let bytes = std::fs::read(place(root, path)?.abs)?;
                finish(root, &repo, &record, &bytes, path, device, announce)
            }
            Take::Theirs => {
                let at = record.theirs_path.as_deref().unwrap_or(path).to_string();
                finish(
                    root,
                    &repo,
                    &record,
                    v.theirs.as_bytes(),
                    &at,
                    device,
                    announce,
                )
            }
            Take::Both => Err(Error::NotText),
        };
    }
    let book = conflicts::read(root);
    let Some((file, copy)) = book.copies.iter().find(|(p, _)| p == path).cloned() else {
        return Err(Error::NotConflicted);
    };
    if let Some(f) = announce {
        f(&[file.clone(), copy.clone()]);
    }
    match side {
        Take::Mine => {
            let mine = std::fs::read(place(root, &copy)?.abs)?;
            put(root, &file, &mine)?;
            remove(root, &copy)?;
        }
        Take::Theirs => remove(root, &copy)?,
        Take::Both => {}
    }
    conflicts::clear_copy(root, path)?;
    commit_paths(
        &repo,
        &[file.as_str(), copy.as_str()],
        &format!("Merge {}", title(&file)),
        device,
    )
}

#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;
