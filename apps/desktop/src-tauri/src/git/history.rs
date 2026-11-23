//! History reads and Restore (spec `SPECs/git-sync-spec.md` "History"), on top of the repository
//! reads of `repo.rs` (which alone names `gix`): the versions of a file with their line counts,
//! the deleted files, what a version changed (against its parent, against the file now, or
//! against another version) and Restore as a new commit. Tauri-free, shared by the app's History
//! tab and the `writer git:*` commands.
//!
//! Every diff is the shared text diff ([`crate::text_diff`]), the same one the agent's Changes
//! card shows: a note gets the rendered view too, other text files the line diff, an image its
//! before and after, any other binary its sizes.

use super::lfs;
use super::message::{Change, Message, Scope};
use super::repo::{Deleted, Error, Repo, Result, Version, VersionKind};
use crate::text_diff::{self, TextDiff};
use crate::vault_ops;
use base64::Engine as _;
use serde::Serialize;
use std::path::Path;

/// Versions looked up for one file at most (a page of the History tab, a `git:log`).
pub const MAX_VERSIONS: usize = 1_000;
/// A side bigger than this has no line counts in the list.
const COUNT_MAX_BYTES: usize = 512 * 1024;
/// A text file bigger than this is shown as a binary (sizes only).
const TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// An image bigger than this is shown as its sizes only.
const IMAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Commits looked back for the deleted files.
pub const DELETED_LOOKBACK: usize = 3_000;

/// A version with the line counts of what it changed (text files only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub version: Version,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// The text of a blob, when it is text (`text_diff::as_text`, the one rule) and not huge.
pub fn as_text(bytes: &[u8]) -> Option<&str> {
    if bytes.len() > TEXT_MAX_BYTES {
        return None;
    }
    crate::text_diff::as_text(bytes)
}

fn blob(repo: &Repo, id: &Option<String>) -> Result<Option<Vec<u8>>> {
    id.as_deref().map(|i| repo.content(i)).transpose()
}

/// The size of a version's side, from its pointer when it is a large file and its header
/// otherwise: no object is read.
fn side_size(repo: &Repo, id: &Option<String>) -> Option<u32> {
    let i = id.as_deref()?;
    let size = match repo.pointer_of_blob(i) {
        Some(p) => p.size,
        None => repo.blob_size(i)?,
    };
    Some(size.min(u32::MAX as u64) as u32)
}

fn is_large(repo: &Repo, id: &Option<String>) -> bool {
    id.as_deref()
        .is_some_and(|i| repo.pointer_of_blob(i).is_some())
}

fn counts(repo: &Repo, v: &Version) -> (Option<u32>, Option<u32>) {
    // a large file has no line counts: its objects are not read for a list
    if is_large(repo, &v.before) || is_large(repo, &v.after) {
        return (None, None);
    }
    let side = |id: &Option<String>| -> Option<String> {
        match id {
            None => Some(String::new()),
            Some(i) => {
                let bytes = repo.content(i).ok()?;
                (bytes.len() <= COUNT_MAX_BYTES)
                    .then(|| as_text(&bytes).map(str::to_string))
                    .flatten()
            }
        }
    };
    let (Some(a), Some(b)) = (side(&v.before), side(&v.after)) else {
        return (None, None);
    };
    match text_diff::compare(&a, &b, false) {
        Some(d) => (Some(d.added), Some(d.removed)),
        None => (None, None),
    }
}

/// The file logs already built, per repository and HEAD: a click on a version, a reload of the
/// tab or two tabs of one file read the same list once. Owned by the caller (the feature's
/// `Vaults`), never a static; each repository forgets its lists when its HEAD moves (a second
/// vault does not evict the first) and holds at most [`CACHE_ENTRIES`] lists.
#[derive(Default)]
pub struct Cache {
    inner: parking_lot::Mutex<Cached>,
}

/// Per repository root: the HEAD its lists were built at, and the lists.
type Cached = std::collections::HashMap<
    std::path::PathBuf,
    (Option<String>, std::collections::HashMap<String, Vec<Row>>),
>;

const CACHE_ENTRIES: usize = 32;

impl Cache {
    /// [`versions`], from the cache while HEAD is the same.
    pub fn versions(&self, repo: &Repo, path: &str, limit: usize) -> Result<Vec<Row>> {
        let head = repo.head_id_string();
        let key = format!("{path}\0{limit}");
        let root = repo.root().to_path_buf();
        {
            let mut g = self.inner.lock();
            let slot = g.entry(root.clone()).or_default();
            if slot.0 != head {
                *slot = (head.clone(), Default::default());
            }
            if let Some(rows) = slot.1.get(&key) {
                return Ok(rows.clone());
            }
        }
        let rows = versions(repo, path, limit)?;
        let mut g = self.inner.lock();
        let slot = g.entry(root).or_default();
        if slot.0 == head {
            if slot.1.len() >= CACHE_ENTRIES {
                slot.1.clear();
            }
            slot.1.insert(key, rows.clone());
        }
        Ok(rows)
    }
}

/// The versions of `path`, newest first, with their line counts.
pub fn versions(repo: &Repo, path: &str, limit: usize) -> Result<Vec<Row>> {
    Ok(repo
        .file_versions(path, limit.min(MAX_VERSIONS))?
        .into_iter()
        .map(|version| {
            let (added, removed) = counts(repo, &version);
            Row {
                version,
                added,
                removed,
            }
        })
        .collect())
}

/// Where git is with an agent turn's commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnCommit {
    pub rev: Option<String>,
    /// No need to ask again: the commit is found, or git has moved on past the turn without one
    /// (a turn that changed nothing, or whose files were committed with the user's).
    pub settled: bool,
}

/// How far past a turn's end git may still commit it: the cadence thread ticks once a second.
const TURN_GRACE_SECONDS: i64 = 3;
/// How many recent commits are looked at: a turn's commit is the newest or close to it.
const TURN_LOOKBACK: usize = 50;

/// The commit of an agent turn, found exactly by its chat id and turn id (the `Writer-Chat` and
/// `Writer-Turn` trailers), never by time. `finished_at` (seconds) lets the answer settle when
/// git has made a commit that is not the turn's after the turn ended.
pub fn turn_commit(
    repo: &Repo,
    chat: &str,
    turn_id: &str,
    finished_at: Option<i64>,
) -> Result<TurnCommit> {
    let log = repo.log(None, TURN_LOOKBACK)?;
    let found = log.iter().find(|e| {
        e.message.chat.as_deref() == Some(chat) && e.message.turn.as_deref() == Some(turn_id)
    });
    if let Some(e) = found {
        return Ok(TurnCommit {
            rev: Some(e.id.clone()),
            settled: true,
        });
    }
    let moved_on = match (finished_at, log.first()) {
        (Some(done), Some(head)) => head.time > done + TURN_GRACE_SECONDS,
        _ => false,
    };
    Ok(TurnCommit {
        rev: None,
        settled: moved_on,
    })
}

pub fn deleted(repo: &Repo) -> Result<Vec<Deleted>> {
    repo.deleted_files(DELETED_LOOKBACK)
}

/// The version of `path` named by `rev` (an id or a prefix of one).
pub fn find(repo: &Repo, path: &str, rev: &str) -> Result<Version> {
    let id = repo.resolve(rev)?;
    // the common case: the file has this path in that commit, and one commit is looked at
    if let Some(v) = repo.version_in_commit(&id, path)? {
        return Ok(v);
    }
    // a version from before a rename: the file's history is followed back to it
    repo.file_versions(path, MAX_VERSIONS)?
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| Error::Git("that version did not change this file".into()))
}

/// What a version holds: the file as it was after the commit; for a deletion, `None`.
pub fn content(repo: &Repo, v: &Version) -> Result<Option<Vec<u8>>> {
    blob(repo, &v.after)
}

/// A side of a comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Against {
    /// The version's own change: it against the file's previous version.
    Parent,
    /// The version against the file now (what Restore would change).
    Current,
    /// The version against another version of the file.
    Version(String),
}

/// An image side of a diff: inline when small enough to send, its size always.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub mime: String,
    /// Base64 of the bytes, `None` over the size the view loads.
    pub data: Option<String>,
    pub size: u32,
}

/// What a version changed, in the form its kind of file shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FileDiff {
    /// A text file: the line diff, and for a note the rendered view.
    #[serde(rename_all = "camelCase")]
    Text { diff: TextDiff },
    #[serde(rename_all = "camelCase")]
    Image {
        before: Option<Preview>,
        after: Option<Preview>,
    },
    /// Any other file, or one too large to diff: the sizes, `None` for a side that is absent.
    #[serde(rename_all = "camelCase")]
    Binary {
        before_size: Option<u32>,
        after_size: Option<u32>,
    },
}

fn preview(path: &str, bytes: &[u8]) -> Preview {
    let mime = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .and_then(crate::attachments::mime_for_extension)
        .unwrap_or("application/octet-stream");
    Preview {
        mime: mime.into(),
        data: (bytes.len() <= IMAGE_MAX_BYTES)
            .then(|| base64::engine::general_purpose::STANDARD.encode(bytes)),
        size: bytes.len() as u32,
    }
}

/// `before` against `after` as the file at `path` shows them.
pub fn diff_bytes(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> FileDiff {
    let is_note = vault_ops::is_markdown_rel(path);
    if crate::attachments::is_render_name(path) && !path.to_ascii_lowercase().ends_with(".svg") {
        return FileDiff::Image {
            before: before.map(|b| preview(path, b)),
            after: after.map(|b| preview(path, b)),
        };
    }
    fn text(side: Option<&[u8]>) -> Option<&str> {
        match side {
            None => Some(""),
            Some(b) => as_text(b),
        }
    }
    if let (Some(a), Some(b)) = (text(before), text(after)) {
        if let Some(diff) = text_diff::compare(a, b, is_note) {
            return FileDiff::Text { diff };
        }
    }
    FileDiff::Binary {
        before_size: before.map(|b| b.len() as u32),
        after_size: after.map(|b| b.len() as u32),
    }
}

/// What the version `rev` of `path` changed, against `against`. `root` is the vault, read for
/// "the file now".
pub fn diff(
    repo: &Repo,
    root: &Path,
    path: &str,
    rev: &str,
    against: &Against,
) -> Result<FileDiff> {
    let v = find(repo, path, rev)?;
    let other: Option<Version> = match against {
        Against::Version(o) => Some(find(repo, path, o)?),
        _ => None,
    };
    // a large file diffs as its two sizes, from the pointers: no object is read
    let (left, right): (&Option<String>, Option<&Option<String>>) = match (against, &other) {
        (Against::Parent, _) => (&v.before, Some(&v.after)),
        (Against::Current, _) => (&v.after, None),
        (_, Some(w)) => (&v.after, Some(&w.after)),
        (_, None) => unreachable!("a version comparison reads the other version"),
    };
    if is_large(repo, left) || right.is_some_and(|r| is_large(repo, r)) {
        let now = std::fs::metadata(root.join(path))
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len().min(u32::MAX as u64) as u32);
        return Ok(FileDiff::Binary {
            before_size: side_size(repo, left),
            after_size: right.map_or(now, |r| side_size(repo, r)),
        });
    }
    let (before, after) = match against {
        Against::Parent => (blob(repo, &v.before)?, blob(repo, &v.after)?),
        Against::Current => (blob(repo, &v.after)?, read_current(root, path)),
        Against::Version(_) => (
            blob(repo, &v.after)?,
            blob(repo, &other.as_ref().and_then(|w| w.after.clone()))?,
        ),
    };
    Ok(diff_bytes(path, before.as_deref(), after.as_deref()))
}

/// The file as it is in the vault now, read the way the rest of the app reads entries
/// (`fs_entry`): a symlink is followed only to a target inside the vault, never out of it.
fn read_current(root: &Path, rel: &str) -> Option<Vec<u8>> {
    let abs = root.join(rel);
    let root_real = crate::fs_entry::canonical_root(Some(root))?;
    let parent_real = abs.parent()?.canonicalize().ok()?;
    if !parent_real.starts_with(&root_real) {
        return None;
    }
    let entry = crate::fs_entry::resolve_path(&abs, &parent_real, Some(&root_real))?;
    if entry.kind != crate::fs_entry::EntryKind::File || !entry.real.starts_with(&root_real) {
        return None;
    }
    std::fs::read(&entry.real).ok()
}

/// `2026-11-19 14:03` in the local time zone.
fn when(seconds: i64) -> String {
    super::repo::format_local(seconds)
}

/// A name beside `rel` that no file has: `Plan (restored).md`, `Plan (restored 2).md`.
fn free_name(root: &Path, rel: &str) -> String {
    let (dir, file) = rel.rsplit_once('/').map_or(("", rel), |(d, f)| (d, f));
    let (stem, ext) = file.rsplit_once('.').map_or((file, ""), |(s, e)| (s, e));
    let ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    for n in 1.. {
        let tag = if n == 1 {
            "restored".to_string()
        } else {
            format!("restored {n}")
        };
        let name = format!("{stem} ({tag}){ext}");
        let candidate = if dir.is_empty() {
            name
        } else {
            format!("{dir}/{name}")
        };
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// What a restore did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    /// The vault-relative path that now holds the content (a free name beside the old one when a
    /// different file took the path of a deleted one).
    pub path: String,
    pub commit: String,
}

/// Writes the version `rev` of `path` back as a new change, committed as
/// `user(restore): <note> to <date time>`. A deletion's version restores what it removed. Edits
/// not saved yet in that file are committed first, so nothing is lost; history is never
/// rewritten. The write is the app's one atomic write (`vault_ops`).
pub fn restore(repo: &Repo, root: &Path, path: &str, rev: &str, device: &str) -> Result<Restored> {
    if let Some(op) = super::operation(repo.root()) {
        return Err(Error::Operation(op.label().into()));
    }
    repo.identities()?;
    let root = &root.canonicalize()?;
    let v = find(repo, path, rev)?;
    let wanted = match v.kind {
        VersionKind::Delete => v.before.clone(),
        _ => v.after.clone(),
    };
    let wanted_id = wanted
        .clone()
        .ok_or_else(|| Error::Git("nothing to restore".into()))?;
    let pointer = repo.pointer_of_blob(&wanted_id);
    if let Some(p) = &pointer {
        if !lfs::has_object(repo.common_dir(), p) {
            // never write a pointer over the user's file
            return Err(Error::Git("This large file is not downloaded here".into()));
        }
    }
    // a path a different file took since the deletion is never overwritten
    let taken = root.join(path).exists()
        && repo
            .file_versions(path, 1)?
            .first()
            .is_some_and(|latest| latest.kind == VersionKind::Delete);
    // keep what is not in history yet
    let pending: Vec<Change> = repo
        .changes()?
        .into_iter()
        .filter(|c| c.path() == path)
        .collect();
    if !pending.is_empty() {
        let ctx = super::template_ctx(device);
        let msg = Message::user(&pending, super::message::DEFAULT_TEMPLATE, &ctx, device);
        repo.commit(&pending, &msg)?;
    }
    let target = if taken {
        free_name(root, path)
    } else {
        path.to_string()
    };
    let confined = vault_ops::confine(root, &target).map_err(|e| Error::Git(e.to_string()))?;
    if let Some(dir) = confined.abs.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match &pointer {
        Some(p) => {
            // a large file that would then not be versioned is refused, not silently left out
            if !repo.can_version(&confined.rel, p.size) {
                return Err(Error::Git(
                    "Turn on large files (LFS) to restore this file".into(),
                ));
            }
            lfs::materialize(repo.common_dir(), &confined.abs, p)?;
        }
        None => {
            let bytes = repo.blob(&wanted_id)?;
            vault_ops::write_bytes(&confined.abs, &bytes).map_err(|e| Error::Git(e.to_string()))?;
        }
    }
    let title = confined
        .rel
        .rsplit('/')
        .next()
        .unwrap_or(&confined.rel)
        .trim_end_matches(".md")
        .to_string();
    let changes: Vec<Change> = repo
        .changes()?
        .into_iter()
        .filter(|c| c.path() == confined.rel)
        .collect();
    if changes.is_empty() {
        // the file already held this content: no new version
        return Ok(Restored {
            path: confined.rel,
            commit: String::new(),
        });
    }
    let msg = Message::user_scoped(
        Scope::Restore,
        &format!("{title} to {}", when(v.time)),
        device,
    );
    let commit = repo.commit(&changes, &msg)?;
    Ok(Restored {
        path: confined.rel,
        commit,
    })
}
