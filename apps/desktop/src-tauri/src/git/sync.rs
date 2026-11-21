//! Sync with a remote (ADR 2026-11-18 points 7 and 8, spec `SPECs/git-sync-spec.md` "Sync"):
//! fetch, replay the unpushed local commits on top of the remote head, push. Tauri-free: the app's
//! scheduler and `writer git:sync` run this one function.
//!
//! ```text
//! recover an interrupted sync            (sync-state.json)
//! round 1..=3:
//!   fetch origin/<branch>                (system git, the scope's children)
//!   ahead only      -> push
//!   behind only     -> fast-forward the branch and the working tree
//!   diverged        -> replay: each unpushed local commit, in order, is re-made on top of the remote
//!                      head: per file merge(base = the commit's parent, mine = the commit,
//!                      theirs = the tree rebuilt so far), same message, author and date; then move
//!                      the branch, write the working tree, push
//!   rejected push   -> next round (the remote moved while we pushed)
//! ```
//!
//! **Atomic by construction.** The replay only writes objects; the branch moves once, after
//! `sync-state.json` records `{old head, new head}`, and then the working tree follows. A crash
//! before the move changes nothing (the record is dropped: rolled back); a crash after it is
//! finished from the record ([`recover`]: every file is written only when the disk still holds the
//! old version, merged when the user edited it meanwhile). The working tree is never left half
//! replayed.
//!
//! **Settling nothing silently.** A file whose merge overlaps (or that holds a token, see
//! `plugin_scan`) is skipped by the replay: the remote's version stays in the history, the user's
//! stays on disk and is recorded in `conflicts.json`, where it blocks automatic commits of that
//! file. The other files complete. A conflict never writes markers.

use super::conflicts::{self, Record};
use super::merge::{conflict_copy_name, merge_file, Merged, Note};
use super::plugin_scan::{self, Held};
use super::repo::{self, Entry, Mode, Repo, TreeChange, TreeEdit};
use super::transport::Exec;
use super::transport::{Fetched, Helper, Kind, Transport, TransportError, REMOTE};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Component, Path, PathBuf};

pub const MAX_ROUNDS: usize = 3;

pub struct Options<'a> {
    pub exec: &'a Exec,
    pub helper: Option<&'a Helper>,
    /// A token to mask in any output kept (the one the helper will answer with, when known).
    pub secrets: Vec<String>,
    pub device: &'a str,
    /// Called with the vault-relative files about to be written in the working tree, before they
    /// are (the app tells the open editors, which claim the watcher's events for them).
    pub announce: Option<Announce<'a>>,
}

/// The callback that is told which files are about to be written.
pub type Announce<'a> = &'a dyn Fn(&[String]);

/// What a sync did, for the status and the panel.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// Local commits pushed.
    pub pushed: usize,
    /// Remote commits taken in.
    pub pulled: usize,
    /// Vault-relative files the sync wrote or removed in the working tree.
    pub written: Vec<String>,
    /// Files that need the user (their version stayed on disk).
    pub conflicts: Vec<Record>,
    /// `(file, copy)` of binaries that changed on both sides.
    pub copies: Vec<(String, String)>,
    /// Files restored because one side deleted what the other edited.
    pub restored: Vec<String>,
    /// Plugin settings held back by the token scan.
    pub held: Vec<Held>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("No remote")]
    NoRemote,
    #[error("Sync is paused: {0}")]
    Operation(String),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("Sync failed: the remote keeps changing")]
    KeepsChanging,
    #[error("Local history has a merge commit; sync it with git")]
    MergeCommits,
    #[error(transparent)]
    Repo(#[from] repo::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// The current remote state without the network: what the status line and the panel show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteInfo {
    /// The remote's URL without credentials; `None` when there is no remote.
    pub url: Option<String>,
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

pub fn remote_info(root: &Path) -> RemoteInfo {
    let Ok(Some(repo)) = Repo::open(root) else {
        return RemoteInfo::default();
    };
    let url = repo
        .config_string(&format!("remote.{REMOTE}.url"))
        .map(|u| super::transport::sanitize(&u, root, &[]));
    let branch = repo.head_branch();
    let (mut ahead, mut behind) = (0, 0);
    if url.is_some() {
        if let (Some(b), Some(head)) = (&branch, repo.head_id_string()) {
            match repo.ref_id(&format!("refs/remotes/{REMOTE}/{b}")) {
                Some(remote) => {
                    (ahead, behind) = repo.ahead_behind(&head, &remote).unwrap_or((0, 0));
                }
                // never pushed: everything is ahead
                None => {
                    ahead = repo
                        .first_parent_not_in(&head, None)
                        .map_or(0, |(c, _)| c.len())
                }
            }
        }
    }
    RemoteInfo {
        url,
        branch,
        ahead,
        behind,
    }
}

// ---- the record of a sync in flight -----------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Progress {
    old_head: Option<String>,
    new_head: String,
    /// The files the working tree still has to follow (vault-relative).
    skip: Vec<String>,
}

fn progress_path(root: &Path) -> PathBuf {
    root.join(".writer/git/sync-state.json")
}

fn read_progress(root: &Path) -> Option<Progress> {
    serde_json::from_str(&std::fs::read_to_string(progress_path(root)).ok()?).ok()
}

fn write_progress(root: &Path, p: &Progress) -> io::Result<()> {
    let file = progress_path(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, serde_json::to_string(p).map_err(io::Error::other)?)
}

fn clear_progress(root: &Path) {
    let _ = std::fs::remove_file(progress_path(root));
}

/// Finishes or drops a sync that was interrupted (a crash, a quit). The branch still at the old
/// head: nothing had moved, the record is dropped (rolled back). At the new head: the working
/// tree is brought up to it. Neither: the branch moved on its own, the record is stale.
pub fn recover(root: &Path, announce: Option<Announce<'_>>) -> Result<bool, Error> {
    let Some(p) = read_progress(root) else {
        return Ok(false);
    };
    let Some(repo) = Repo::open(root)? else {
        clear_progress(root);
        return Ok(false);
    };
    let head = repo.head_id_string();
    if head.as_deref() == Some(p.new_head.as_str()) && head != p.old_head {
        let skip: BTreeSet<String> = p.skip.iter().cloned().collect();
        let changes = repo.tree_changes(p.old_head.as_deref(), Some(&p.new_head))?;
        let mut report = Report::default();
        tell(announce, &changes, &skip);
        follow_worktree(&repo, root, &changes, &skip, &mut report)?;
        repo.refresh_index(&report.written)?;
        record_conflicts(root, &report, Seen(0, 0, 0))?;
    }
    clear_progress(root);
    Ok(true)
}

// ---- the working tree ---------------------------------------------------------------------------

/// A vault-relative path from a tree: never absolute, never out of the vault, never `.git`.
fn safe_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.components()
            .next()
            .is_none_or(|c| c.as_os_str() != ".git")
}

fn read_disk(path: &Path) -> Option<Vec<u8>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => std::fs::read(path).ok(),
        _ => None,
    }
}

fn write_disk(path: &Path, bytes: &[u8], mode: Mode) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("writer-sync-tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let existing = std::fs::metadata(path)
            .map(|m| m.permissions().mode())
            .unwrap_or(0o644);
        let bits = if mode == Mode::Exec {
            existing | 0o111
        } else {
            existing & !0o111
        };
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(bits))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::rename(tmp, path)
}

fn stamp(seconds: i64) -> String {
    repo::format_local(seconds).replace(':', "")
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Brings the working tree to the new head for the files in `changes`: a file the disk still holds
/// at its old version is written (or removed); one the user edited meanwhile is merged with the
/// new version; an overlap or a file in `skip` stays as the user has it.
fn follow_worktree(
    repo: &Repo,
    root: &Path,
    changes: &[TreeChange],
    skip: &BTreeSet<String>,
    report: &mut Report,
) -> Result<(), Error> {
    for ch in changes {
        if skip.contains(&ch.path) || !safe_rel(&ch.path) {
            continue;
        }
        let link = |e: &Option<Entry>| e.as_ref().is_some_and(|e| e.mode == Mode::Link);
        if link(&ch.before) || link(&ch.after) {
            continue;
        }
        let abs = root.join(&ch.path);
        let blob = |e: &Option<Entry>| -> Result<Option<Vec<u8>>, Error> {
            e.as_ref().map(|e| Ok(repo.blob(&e.id)?)).transpose()
        };
        let (before, after) = (blob(&ch.before)?, blob(&ch.after)?);
        let disk = read_disk(&abs);
        let target = ch.after.as_ref().map_or(Mode::Blob, |e| e.mode);
        let put = |bytes: &Option<Vec<u8>>, report: &mut Report| -> Result<(), Error> {
            match bytes {
                Some(b) => write_disk(&abs, b, target)?,
                None => match std::fs::remove_file(&abs) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                    _ => {}
                },
            }
            report.written.push(ch.path.clone());
            Ok(())
        };
        if disk == before {
            put(&after, report)?;
        } else if disk == after {
            continue;
        } else {
            match merge_file(
                &ch.path,
                before.as_deref(),
                disk.as_deref(),
                after.as_deref(),
            ) {
                Merged::Clean { bytes, note } => {
                    if note == Some(Note::DeleteEdit) {
                        report.restored.push(ch.path.clone());
                    }
                    put(&bytes, report)?;
                }
                Merged::BinaryCopy => {
                    let copy = conflict_copy_name(&ch.path, "this device", &stamp(now_seconds()));
                    if let Some(mine) = &disk {
                        write_disk(&root.join(&copy), mine, Mode::Blob)?;
                        report.written.push(copy.clone());
                    }
                    put(&after, report)?;
                    report.copies.push((ch.path.clone(), copy));
                }
                Merged::Conflict(c) => report.conflicts.push(record_of(&ch.path, &c)),
            }
        }
    }
    Ok(())
}

// ---- the replay ---------------------------------------------------------------------------------

struct Replayed {
    /// The tip to move the branch to; `None` when nothing is left to keep and there is nothing
    /// to build on.
    head: Option<String>,
    /// Commits of the new chain (what gets pushed).
    kept: usize,
    skip: BTreeSet<String>,
    conflicts: Vec<(String, super::merge::Conflict)>,
    copies: Vec<(String, String)>,
    restored: Vec<String>,
    held: Vec<Held>,
}

fn is_link(e: &Option<Entry>) -> bool {
    e.as_ref().is_some_and(|e| e.mode == Mode::Link)
}

/// Re-makes `local` (oldest first) on top of `onto` (`None`: an empty tree).
fn replay(
    repo: &Repo,
    root: &Path,
    onto: Option<&str>,
    local: &[String],
    device: &str,
) -> Result<Replayed, Error> {
    let mut edits: BTreeMap<String, Option<Entry>> = BTreeMap::new();
    let mut out = Replayed {
        head: onto.map(str::to_string),
        kept: 0,
        skip: BTreeSet::new(),
        conflicts: Vec::new(),
        copies: Vec::new(),
        restored: Vec::new(),
        held: Vec::new(),
    };
    let mut prev_tree = repo.write_tree(onto, &[])?;
    for id in local {
        let data = repo.commit_data(id)?;
        let parent = data.parents.first().map(String::as_str);
        for ch in repo.tree_changes(parent, Some(id))? {
            if out.skip.contains(&ch.path) || !safe_rel(&ch.path) {
                continue;
            }
            let theirs = match edits.get(&ch.path) {
                Some(e) => e.clone(),
                None => repo.entry_at(onto, &ch.path)?,
            };
            // already the same on both sides
            if theirs == ch.after {
                continue;
            }
            if let Some(after) = &ch.after {
                if after.mode != Mode::Link && plugin_scan::plugin_of(&ch.path).is_some() {
                    let bytes = repo.blob(&after.id)?;
                    if plugin_scan::flagged(root, &ch.path, &bytes) {
                        out.skip.insert(ch.path.clone());
                        out.held
                            .extend(plugin_scan::held_among(root, [ch.path.as_str()]));
                        continue;
                    }
                }
            }
            // untouched on the other side: this commit's version goes in as it is
            if theirs == ch.before || is_link(&ch.before) || is_link(&ch.after) || is_link(&theirs)
            {
                if theirs == ch.before || theirs.is_none() {
                    edits.insert(ch.path.clone(), ch.after.clone());
                }
                continue;
            }
            let bytes = |e: &Option<Entry>| -> Result<Option<Vec<u8>>, Error> {
                e.as_ref().map(|e| Ok(repo.blob(&e.id)?)).transpose()
            };
            let (b, m, t) = (bytes(&ch.before)?, bytes(&ch.after)?, bytes(&theirs)?);
            match merge_file(&ch.path, b.as_deref(), m.as_deref(), t.as_deref()) {
                Merged::Clean {
                    bytes: merged,
                    note,
                } => {
                    if note == Some(Note::DeleteEdit) {
                        out.restored.push(ch.path.clone());
                    }
                    let entry = match merged {
                        None => None,
                        Some(bytes) if Some(&bytes) == m.as_ref() => ch.after.clone(),
                        Some(bytes) if Some(&bytes) == t.as_ref() => theirs.clone(),
                        Some(bytes) => Some(Entry {
                            id: repo.write_blob(&bytes)?,
                            mode: ch
                                .after
                                .as_ref()
                                .or(theirs.as_ref())
                                .map_or(Mode::Blob, |e| e.mode),
                        }),
                    };
                    edits.insert(ch.path.clone(), entry);
                }
                Merged::BinaryCopy => {
                    let copy = conflict_copy_name(&ch.path, device, &stamp(data.author.seconds));
                    edits.insert(copy.clone(), ch.after.clone());
                    out.copies.push((ch.path.clone(), copy));
                }
                Merged::Conflict(c) => {
                    out.skip.insert(ch.path.clone());
                    out.conflicts.push((ch.path.clone(), c));
                }
            }
        }
        let list: Vec<TreeEdit> = edits
            .iter()
            .map(|(path, e)| match e {
                Some(entry) => TreeEdit::Upsert {
                    path: path.clone(),
                    entry: entry.clone(),
                },
                None => TreeEdit::Remove { path: path.clone() },
            })
            .collect();
        let tree = repo.write_tree(onto, &list)?;
        if tree == prev_tree {
            // everything this commit did is already there (or was set aside): nothing to record
            continue;
        }
        let parents: Vec<String> = out.head.iter().cloned().collect();
        let new = repo.write_commit(
            &tree,
            &parents,
            &data.message,
            &data.author,
            &data.committer,
        )?;
        out.head = Some(new);
        out.kept += 1;
        prev_tree = tree;
    }
    Ok(out)
}

fn record_of(path: &str, c: &super::merge::Conflict) -> Record {
    Record {
        path: path.to_string(),
        hunks: c.hunks.len() as u32,
        properties: c.properties.iter().map(|p| p.name.clone()).collect(),
    }
}

/// Writes what a sync could not settle into `conflicts.json` (a file already there is replaced).
fn record_conflicts(root: &Path, report: &Report, since: Seen) -> io::Result<()> {
    let mut book = conflicts::read(root);
    for r in &report.conflicts[since.0..] {
        book.files.retain(|f| f.path != r.path);
        book.files.push(r.clone());
    }
    book.copies.extend(report.copies[since.1..].iter().cloned());
    book.restored
        .extend(report.restored[since.2..].iter().cloned());
    conflicts::write(root, &book)
}

/// How much of a report was already recorded: conflicts, copies, restored.
#[derive(Clone, Copy)]
struct Seen(usize, usize, usize);

impl Seen {
    fn of(r: &Report) -> Seen {
        Seen(r.conflicts.len(), r.copies.len(), r.restored.len())
    }
}

// ---- the sync -------------------------------------------------------------------------------------

fn held_in(repo: &Repo, root: &Path, local: &[String]) -> Result<bool, Error> {
    for id in local {
        let parent = repo.parent_of(id)?;
        for ch in repo.tree_changes(parent.as_deref(), Some(id))? {
            let Some(after) = ch.after.filter(|a| a.mode != Mode::Link) else {
                continue;
            };
            if plugin_scan::plugin_of(&ch.path).is_some()
                && plugin_scan::flagged(root, &ch.path, &repo.blob(&after.id)?)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Tells the app which files the working tree is about to change.
fn tell(announce: Option<Announce<'_>>, changes: &[TreeChange], skip: &BTreeSet<String>) {
    let Some(f) = announce else { return };
    let paths: Vec<String> = changes
        .iter()
        .filter(|c| !skip.contains(&c.path) && safe_rel(&c.path))
        .map(|c| c.path.clone())
        .collect();
    if !paths.is_empty() {
        f(&paths);
    }
}

/// Moves the branch to `new`, then brings the working tree and the index along, recording the
/// move first so a crash can be finished (see the module docs).
fn adopt(
    repo: &Repo,
    root: &Path,
    old: Option<&str>,
    new: &str,
    skip: &BTreeSet<String>,
    report: &mut Report,
    announce: Option<Announce<'_>>,
) -> Result<(), Error> {
    if old == Some(new) {
        return Ok(());
    }
    write_progress(
        root,
        &Progress {
            old_head: old.map(str::to_string),
            new_head: new.to_string(),
            skip: skip.iter().cloned().collect(),
        },
    )?;
    repo.move_head(new, old)?;
    let changes = repo.tree_changes(old, Some(new))?;
    tell(announce, &changes, skip);
    follow_worktree(repo, root, &changes, skip, report)?;
    repo.refresh_index(&report.written)?;
    Ok(())
}

/// One whole sync of the vault at `root`. Commit the pending changes first (the caller does:
/// step 1 of the spec); this is steps 2 to 4.
pub fn sync(root: &Path, opts: &Options<'_>) -> Outcome {
    let mut report = Report::default();
    let error = run(root, opts, &mut report).err();
    report.written.sort();
    report.written.dedup();
    Outcome { report, error }
}

/// What a sync did and, when it stopped early, why: the report is complete up to there (files it
/// wrote must still be announced to the editors).
pub struct Outcome {
    pub report: Report,
    pub error: Option<Error>,
}

fn run(root: &Path, opts: &Options<'_>, report: &mut Report) -> Result<(), Error> {
    if let Some(op) = super::operation(root) {
        return Err(Error::Operation(op.label().into()));
    }
    recover(root, opts.announce)?;
    let transport = Transport {
        exec: opts.exec,
        root,
        helper: opts.helper,
        secrets: opts.secrets.clone(),
    };
    for _ in 0..MAX_ROUNDS {
        let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
        if repo
            .config_string(&format!("remote.{REMOTE}.url"))
            .is_none()
        {
            return Err(Error::NoRemote);
        }
        let branch = repo
            .head_branch()
            .ok_or_else(|| Error::Operation("detached HEAD".into()))?;
        let fetched = transport.fetch(&branch)?;
        let remote = match fetched {
            Fetched::Updated => repo.ref_id(&format!("refs/remotes/{REMOTE}/{branch}")),
            Fetched::BranchMissing => None,
        };
        let head = repo.head_id_string();
        let (local, merges) = match &head {
            Some(h) => repo.first_parent_not_in(h, remote.as_deref())?,
            None => (Vec::new(), false),
        };
        let (_, behind) = match (&head, &remote) {
            (Some(h), Some(r)) => repo.ahead_behind(h, r)?,
            (None, Some(r)) => (0, repo.first_parent_not_in(r, None)?.0.len()),
            _ => (0, 0),
        };
        if merges && behind > 0 {
            return Err(Error::MergeCommits);
        }
        let mut oldest_first = local.clone();
        oldest_first.reverse();
        let hold = !oldest_first.is_empty() && held_in(&repo, root, &oldest_first)?;
        let seen = Seen::of(report);
        if behind > 0 || hold {
            match &remote {
                Some(r) if head.is_none() || (oldest_first.is_empty() && !hold) => {
                    // fast-forward
                    adopt(
                        &repo,
                        root,
                        head.as_deref(),
                        r,
                        &BTreeSet::new(),
                        report,
                        opts.announce,
                    )?;
                    report.pulled += behind;
                }
                _ => {
                    let replayed =
                        replay(&repo, root, remote.as_deref(), &oldest_first, opts.device)?;
                    report.pulled += behind;
                    report
                        .conflicts
                        .extend(replayed.conflicts.iter().map(|(p, c)| record_of(p, c)));
                    report.copies.extend(replayed.copies);
                    report.restored.extend(replayed.restored);
                    for h in replayed.held {
                        if !report.held.iter().any(|x| x.path == h.path) {
                            report.held.push(h);
                        }
                    }
                    if let Some(new) = &replayed.head {
                        adopt(
                            &repo,
                            root,
                            head.as_deref(),
                            new,
                            &replayed.skip,
                            report,
                            opts.announce,
                        )?;
                    }
                }
            }
        }
        record_conflicts(root, report, seen)?;
        // push
        let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
        let (head, remote) = (
            repo.head_id_string(),
            repo.ref_id(&format!("refs/remotes/{REMOTE}/{branch}")),
        );
        let ahead = match (&head, &remote) {
            (None, _) => 0,
            (Some(h), Some(r)) => repo.ahead_behind(h, r)?.0,
            (Some(h), None) => repo.first_parent_not_in(h, None)?.0.len(),
        };
        if ahead == 0 {
            clear_progress(root);
            return Ok(());
        }
        match transport.push(&branch) {
            Ok(()) => {
                report.pushed += ahead;
                clear_progress(root);
                return Ok(());
            }
            // the remote moved while we pushed: fetch and replay again
            Err(e) if e.kind == Kind::Rejected => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::KeepsChanging)
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
