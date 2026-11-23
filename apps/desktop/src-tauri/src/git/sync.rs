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
//!
//! **Confined.** A remote tree is not trusted: every working-tree write and removal goes through
//! `vault_ops::confine_with` ([`PROTECTED`]): `.git` in any spelling (a case variant on APFS is
//! the same folder), the device-local `.writer/git` (a remote `plugin-scan.json` must never
//! pre-approve a token) and any path through a symlink are refused, listed in [`Report::refused`]
//! and never written. `.obsidian` syncs.

use super::conflicts::{self, Record};
use super::lfs::{self, Pointer};
use super::merge::{conflict_copy_name, merge_file, Merged, Note};
use super::plugin_scan::{self, Held};
use super::renames::Similar;
use super::repo::{self, Entry, Mode, Repo, TreeChange, TreeEdit};
use super::transport::Exec;
use super::transport::{Fetched, Helper, Kind, Transport, TransportError, REMOTE};
use crate::vault_ops::{self, Confined};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::Path;

pub const MAX_ROUNDS: usize = 3;

/// What a synced tree may never write besides `.git` (which `confine_with` always refuses).
pub const PROTECTED: &[&str] = &[super::LOCAL_DIR];

/// Why a commit is refused while `sync-state.json` exists.
pub const INTERRUPTED: &str = "interrupted sync";

pub struct Options<'a> {
    pub exec: &'a Exec,
    pub helper: Option<&'a Helper>,
    /// A token to mask in any output kept (the one the helper will answer with, when known).
    pub secrets: Vec<String>,
    pub device: &'a str,
    /// Runs a closure with the caller's repository lock released (the app holds one lock per
    /// vault for the whole sync). Large-file transfers can take minutes and only append to the
    /// object store, so they run through it; the sync re-reads the repository after each and
    /// starts the round again when a commit landed meanwhile. `None`: nothing is held.
    pub unlocked: Option<Unlocked<'a>>,
    /// Called with the vault-relative files about to be written in the working tree, before they
    /// are (the app tells the open editors, which claim the watcher's events for them).
    pub announce: Option<Announce<'a>>,
}

/// See [`Options::unlocked`].
pub type Unlocked<'a> = &'a dyn Fn(&mut dyn FnMut());

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
    /// Paths of a remote tree the working tree refused (see the module docs): never written.
    pub refused: Vec<String>,
    /// Large files still pointers on disk: their content could not be downloaded (`git-lfs`
    /// missing, or the fetch failed); the sync went on without them.
    pub lfs_missing: Vec<String>,
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

const PROGRESS: &str = "sync-state.json";

fn read_progress(root: &Path) -> Option<Progress> {
    serde_json::from_str(&std::fs::read_to_string(super::local_path(root, PROGRESS)).ok()?).ok()
}

fn write_progress(root: &Path, p: &Progress) -> io::Result<()> {
    super::write_local(
        root,
        PROGRESS,
        &serde_json::to_string(p).map_err(io::Error::other)?,
    )
}

fn clear_progress(root: &Path) -> io::Result<()> {
    super::remove_local(root, PROGRESS)
}

/// A sync moved (or was about to move) the branch and did not finish: nothing may be committed
/// until [`recover`] runs (`Repo::commit` refuses).
pub fn interrupted(root: &Path) -> bool {
    super::local_path(root, PROGRESS).exists()
}

/// Finishes or drops a sync that was interrupted (a crash, a quit). The branch still at the old
/// head: nothing had moved, the record is dropped (rolled back). At the new head: the working
/// tree is brought up to it. Neither: the branch moved on its own, the record is stale. `None`
/// when there was no record; else what the working tree went through (its files must be told to
/// the editors). Every commit runs this first, under the write lock.
pub fn recover(
    root: &Path,
    announce: Option<Announce<'_>>,
    device: &str,
) -> Result<Option<Report>, Error> {
    let Some(p) = read_progress(root) else {
        return Ok(None);
    };
    let root = &root.canonicalize()?;
    let mut report = Report::default();
    let Some(repo) = Repo::open(root)? else {
        clear_progress(root)?;
        return Ok(Some(report));
    };
    let head = repo.head_id_string();
    if head.as_deref() == Some(p.new_head.as_str()) && head != p.old_head {
        let skip: BTreeSet<String> = p.skip.iter().cloned().collect();
        let changes = repo.tree_changes(p.old_head.as_deref(), Some(&p.new_head))?;
        tell(announce, &changes, &skip);
        follow_worktree(&repo, root, &changes, &skip, device, &mut report)?;
        repo.refresh_index(&report.written)?;
        record_conflicts(root, &report, Seen::default())?;
    }
    clear_progress(root)?;
    Ok(Some(report))
}

// ---- the working tree ---------------------------------------------------------------------------

fn read_disk(path: &Path) -> Option<Vec<u8>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => std::fs::read(path).ok(),
        _ => None,
    }
}

fn vault_error(e: vault_ops::VaultOpError) -> Error {
    Error::Io(io::Error::other(e.to_string()))
}

/// Where a tree path lands in the working tree, `None` when it is refused (see the module docs).
fn place(root: &Path, rel: &str) -> Option<Confined> {
    vault_ops::confine_with(root, rel, PROTECTED).ok()
}

/// Writes a file of a tree: the app's one atomic write, then git's mode.
fn put_file(at: &Confined, bytes: &[u8], mode: Mode) -> Result<(), Error> {
    vault_ops::write_bytes_creating(&at.abs, bytes).map_err(vault_error)?;
    vault_ops::set_executable(&at.abs, mode == Mode::Exec).map_err(vault_error)
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
/// new version; an overlap or a file in `skip` stays as the user has it. A path the confinement
/// refuses is listed in `report.refused` and left alone.
fn follow_worktree(
    repo: &Repo,
    root: &Path,
    changes: &[TreeChange],
    skip: &BTreeSet<String>,
    device: &str,
    report: &mut Report,
) -> Result<(), Error> {
    // a file already in conflict keeps the user's version until the merge view settles it
    let open = conflicts::paths(root);
    for ch in changes {
        if skip.contains(&ch.path) || open.contains(&ch.path) {
            continue;
        }
        if is_link(&ch.before) || is_link(&ch.after) {
            continue;
        }
        let Some(at) = place(root, &ch.path) else {
            if !report.refused.contains(&ch.path) {
                report.refused.push(ch.path.clone());
            }
            continue;
        };
        let ptr = |e: &Option<Entry>| e.as_ref().and_then(|e| repo.pointer_of_blob(&e.id));
        let (before_ptr, after_ptr) = (ptr(&ch.before), ptr(&ch.after));
        if before_ptr.is_some() || after_ptr.is_some() {
            follow_lfs(repo, root, &at, ch, (before_ptr, after_ptr), device, report)?;
            continue;
        }
        let blob = |e: &Option<Entry>| -> Result<Option<Vec<u8>>, Error> {
            e.as_ref().map(|e| Ok(repo.blob(&e.id)?)).transpose()
        };
        let (before, after) = (blob(&ch.before)?, blob(&ch.after)?);
        let disk = read_disk(&at.abs);
        let target = ch.after.as_ref().map_or(Mode::Blob, |e| e.mode);
        let put = |bytes: &Option<Vec<u8>>, report: &mut Report| -> Result<(), Error> {
            match bytes {
                Some(b) => put_file(&at, b, target)?,
                None => vault_ops::remove_file(&at.abs).map_err(vault_error)?,
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
                    let taken = |name: &str| {
                        place(root, name).is_none_or(|c| c.abs.exists())
                            || repo
                                .entry_at(repo.head_id_string().as_deref(), name)
                                .ok()
                                .flatten()
                                .is_some()
                    };
                    let copy = conflict_copy_name(&ch.path, device, &stamp(now_seconds()), &taken);
                    if let (Some(mine), Some(copy_at)) = (&disk, place(root, &copy)) {
                        put_file(&copy_at, mine, Mode::Blob)?;
                        report.written.push(copy.clone());
                    }
                    put(&after, report)?;
                    report.copies.push((ch.path.clone(), copy));
                }
                Merged::Conflict(c) => {
                    report
                        .conflicts
                        .push(record_of(&ch.path, &c, ch.before.as_ref(), None))
                }
            }
        }
    }
    Ok(())
}

/// [`follow_worktree`] for a file whose old or new version is an LFS pointer: compared and written
/// by pointer, so a large file is hashed and copied as a stream and never held in memory. The
/// disk file stands for a version when it is that pointer's content (or the pointer text itself,
/// a file never downloaded). Same outcomes as for a text file: untouched here, the new version
/// is written; changed on both sides, the version here is kept beside it as a copy (two versions
/// of a large file are never merged); edited here and deleted there, the edit stays.
fn follow_lfs(
    repo: &Repo,
    root: &Path,
    at: &Confined,
    ch: &TreeChange,
    (before, after): (Option<Pointer>, Option<Pointer>),
    device: &str,
    report: &mut Report,
) -> Result<(), Error> {
    let abs = &at.abs;
    let target = ch.after.as_ref().map_or(Mode::Blob, |e| e.mode);
    let on_disk = std::fs::symlink_metadata(abs).is_ok_and(|m| m.is_file());
    let stands_for = |e: &Option<Entry>, p: &Option<Pointer>| -> Result<bool, Error> {
        let Some(e) = e else { return Ok(!on_disk) };
        if !on_disk {
            return Ok(false);
        }
        if lfs::file_is_pointer(abs) {
            return Ok(read_disk(abs).as_deref() == Some(repo.blob(&e.id)?.as_slice()));
        }
        Ok(match p {
            Some(p) => {
                std::fs::metadata(abs).is_ok_and(|m| m.len() == p.size)
                    && lfs::pointer_of_file(abs).ok().as_ref() == Some(p)
            }
            None => read_disk(abs).as_deref() == Some(repo.blob(&e.id)?.as_slice()),
        })
    };
    let put = |report: &mut Report| -> Result<(), Error> {
        match (&ch.after, &after) {
            (None, _) => vault_ops::remove_file(abs).map_err(vault_error)?,
            (Some(e), Some(p)) => {
                // streamed from the store through a temp file beside the store, renamed in; the
                // target is the confined path
                if lfs::materialize(repo.common_dir(), abs, p)? {
                    vault_ops::set_executable(abs, target == Mode::Exec).map_err(vault_error)?;
                } else {
                    // not downloaded: the pointer itself, replaced once the object is here
                    put_file(at, &repo.blob(&e.id)?, target)?;
                }
            }
            (Some(e), None) => put_file(at, &repo.blob(&e.id)?, target)?,
        }
        report.written.push(ch.path.clone());
        Ok(())
    };
    if stands_for(&ch.before, &before)? {
        put(report)
    } else if stands_for(&ch.after, &after)? {
        Ok(())
    } else if ch.after.is_none() || !on_disk {
        // one side deleted what the other edited: the edit stays
        if ch.after.is_some() {
            put(report)?;
        }
        report.restored.push(ch.path.clone());
        Ok(())
    } else {
        let taken = |name: &str| {
            place(root, name).is_none_or(|c| c.abs.exists())
                || repo
                    .entry_at(repo.head_id_string().as_deref(), name)
                    .ok()
                    .flatten()
                    .is_some()
        };
        let copy = conflict_copy_name(&ch.path, device, &stamp(now_seconds()), &taken);
        if let Some(copy_at) = place(root, &copy) {
            // a new file under a name nothing has: copied as a stream, never read whole
            std::fs::copy(abs, &copy_at.abs)?;
            report.written.push(copy.clone());
        }
        put(report)?;
        report.copies.push((ch.path.clone(), copy));
        Ok(())
    }
}

// ---- the replay ---------------------------------------------------------------------------------

struct Replayed {
    /// The tip to move the branch to; `None` when nothing is left to keep and there is nothing
    /// to build on.
    head: Option<String>,
    /// Commits of the new chain (what gets pushed).
    kept: usize,
    skip: BTreeSet<String>,
    conflicts: Vec<Record>,
    copies: Vec<(String, String)>,
    restored: Vec<String>,
    held: Vec<Held>,
}

fn is_link(e: &Option<Entry>) -> bool {
    e.as_ref().is_some_and(|e| e.mode == Mode::Link)
}

/// One replay in progress: the files the rebuilt tree holds differently from `onto`, and what the
/// other side renamed since the first local commit's parent (so an edit follows the file).
struct Replay<'a> {
    repo: &'a Repo,
    root: &'a Path,
    onto: Option<&'a str>,
    device: &'a str,
    edits: BTreeMap<String, Option<Entry>>,
    /// Files the other side renamed, `old -> new`.
    remote_moves: BTreeMap<String, String>,
    /// Local paths whose edits follow a rename of the other side, `old -> new`.
    alias: BTreeMap<String, String>,
    out: Replayed,
}

/// The three versions of one file and where each lives: what [`Replay::merge3`] settles.
struct Settle<'a> {
    /// Where mine is on disk, and where the conflict is recorded.
    mine_path: &'a str,
    /// Where the other side's version is (differs from `mine_path` after a rename).
    theirs_path: &'a str,
    /// Where a clean result goes.
    out_path: &'a str,
    before: Option<Entry>,
    after: Option<Entry>,
    theirs: Option<Entry>,
    /// When mine was made (names the conflict copy of a binary).
    seconds: i64,
}

impl Replay<'_> {
    fn theirs_at(&self, path: &str) -> Result<Option<Entry>, Error> {
        match self.edits.get(path) {
            Some(e) => Ok(e.clone()),
            None => Ok(self.repo.entry_at(self.onto, path)?),
        }
    }

    fn blob_of(&self, e: &Option<Entry>) -> Result<Option<Vec<u8>>, Error> {
        e.as_ref().map(|e| Ok(self.repo.blob(&e.id)?)).transpose()
    }

    /// Holds back a plugin's settings whose version about to enter the rebuilt tree holds a token
    /// the user has not allowed: the file is skipped (it stays on disk), `true` when it was.
    fn hold_back(&mut self, path: &str, bytes: &[u8]) -> bool {
        if plugin_scan::plugin_of(path).is_none() || !plugin_scan::flagged(self.root, path, bytes) {
            return false;
        }
        self.out.skip.insert(path.to_string());
        let held = plugin_scan::held_among(self.root, [path]);
        self.out.held.extend(held);
        true
    }

    /// A conflict over `mine_path` (on disk), the other side's version at `theirs_path`.
    fn conflict(
        &mut self,
        mine_path: &str,
        c: &super::merge::Conflict,
        base: Option<&Entry>,
        theirs_path: &str,
    ) {
        self.out.skip.insert(mine_path.to_string());
        self.out.conflicts.push(record_of(
            mine_path,
            c,
            base,
            (theirs_path != mine_path).then(|| theirs_path.to_string()),
        ));
    }

    /// The 3-way merge of one file: a clean result goes into the rebuilt tree, a binary keeps mine
    /// beside theirs, an overlap is recorded and mine is left on disk.
    fn merge3(&mut self, s: Settle<'_>) -> Result<(), Error> {
        let (b, m, t) = (
            self.blob_of(&s.before)?,
            self.blob_of(&s.after)?,
            self.blob_of(&s.theirs)?,
        );
        match merge_file(s.mine_path, b.as_deref(), m.as_deref(), t.as_deref()) {
            Merged::Clean {
                bytes: merged,
                note,
            } => {
                if let Some(bytes) = &merged {
                    if self.hold_back(s.out_path, bytes) {
                        return Ok(());
                    }
                }
                if note == Some(Note::DeleteEdit) {
                    self.out.restored.push(s.out_path.to_string());
                }
                let entry = match merged {
                    None => None,
                    Some(bytes) if Some(&bytes) == m.as_ref() => s.after.clone(),
                    Some(bytes) if Some(&bytes) == t.as_ref() => s.theirs.clone(),
                    Some(bytes) => Some(Entry {
                        id: self.repo.write_blob(&bytes)?,
                        mode: s
                            .after
                            .as_ref()
                            .or(s.theirs.as_ref())
                            .map_or(Mode::Blob, |e| e.mode),
                    }),
                };
                if s.theirs_path != s.out_path {
                    // the other side's file moves to the new name
                    self.edits.insert(s.theirs_path.to_string(), None);
                }
                self.edits.insert(s.out_path.to_string(), entry);
            }
            Merged::BinaryCopy => {
                let taken = |name: &str| {
                    self.edits.get(name).is_some_and(Option::is_some)
                        || (!self.edits.contains_key(name)
                            && self.repo.entry_at(self.onto, name).ok().flatten().is_some())
                };
                let copy = conflict_copy_name(s.mine_path, self.device, &stamp(s.seconds), &taken);
                self.edits.insert(copy.clone(), s.after.clone());
                self.out.copies.push((s.mine_path.to_string(), copy));
            }
            Merged::Conflict(c) => self.conflict(s.mine_path, &c, s.before.as_ref(), s.theirs_path),
        }
        Ok(())
    }

    /// One file's change in a local commit, merged with what the rebuilt tree has.
    fn change(&mut self, ch: &TreeChange, seconds: i64) -> Result<(), Error> {
        if self.out.skip.contains(&ch.path) || !vault_ops::rel_allowed(&ch.path, PROTECTED) {
            return Ok(());
        }
        let mut target = self
            .alias
            .get(&ch.path)
            .cloned()
            .unwrap_or_else(|| ch.path.clone());
        let mut theirs = self.theirs_at(&target)?;
        // the other side renamed the file this commit edits: the edit follows it
        if theirs.is_none() && ch.before.is_some() && target == ch.path {
            if let Some(to) = self.remote_moves.get(&ch.path).cloned() {
                theirs = self.theirs_at(&to)?;
                self.alias.insert(ch.path.clone(), to.clone());
                target = to;
                // renamed AND edited there, edited here: a real 3-way merge across a rename is
                // the user's to check, never settled silently
                if theirs != ch.before && theirs != ch.after && !is_link(&theirs) {
                    let c = super::merge::Conflict::default();
                    self.conflict(&ch.path, &c, ch.before.as_ref(), &target);
                    return Ok(());
                }
            }
        }
        // already the same on both sides
        if theirs == ch.after {
            return Ok(());
        }
        if let Some(after) = &ch.after {
            if after.mode != Mode::Link && plugin_scan::plugin_of(&ch.path).is_some() {
                let bytes = self.repo.blob(&after.id)?;
                if self.hold_back(&ch.path.clone(), &bytes) {
                    return Ok(());
                }
            }
        }
        // untouched on the other side: this commit's version goes in as it is
        if theirs == ch.before || is_link(&ch.before) || is_link(&ch.after) || is_link(&theirs) {
            if theirs == ch.before || theirs.is_none() {
                self.edits.insert(target, ch.after.clone());
            }
            return Ok(());
        }
        self.merge3(Settle {
            mine_path: &ch.path,
            theirs_path: &target,
            out_path: &target,
            before: ch.before.clone(),
            after: ch.after.clone(),
            theirs,
            seconds,
        })
    }

    /// A file this commit renamed (`from` to `to`, `before` and `after` its two versions). When
    /// the other side edited it meanwhile, the edit lands at the new name; when it renamed it
    /// too, to a name of its own, the two names are a conflict for the user to choose between.
    fn rename(
        &mut self,
        (gone, added): (&TreeChange, &TreeChange),
        seconds: i64,
    ) -> Result<(), Error> {
        let (from, to) = (gone.path.as_str(), added.path.as_str());
        let (before, after) = (gone.before.clone(), added.after.clone());
        let plain = |this: &mut Self| -> Result<(), Error> {
            this.change(gone, seconds)?;
            this.change(added, seconds)
        };
        if self.out.skip.contains(from)
            || self.out.skip.contains(to)
            || !vault_ops::rel_allowed(from, PROTECTED)
            || !vault_ops::rel_allowed(to, PROTECTED)
            || is_link(&before)
            || is_link(&after)
        {
            return plain(self);
        }
        let (theirs_from, theirs_to) = (self.theirs_at(from)?, self.theirs_at(to)?);
        if theirs_from == before {
            return plain(self);
        }
        match theirs_from {
            // a file already sits at the new name: two files, no rename to follow
            Some(_) if theirs_to.is_some() => plain(self),
            // edited on the other side while renamed here: the edit comes along
            Some(edited) => self.merge3(Settle {
                mine_path: to,
                theirs_path: from,
                out_path: to,
                before,
                after,
                theirs: Some(edited),
                seconds,
            }),
            None => match self.remote_moves.get(from).cloned() {
                // renamed on both sides to the same name: one file, edits merged
                Some(c) if c == to => self.merge3(Settle {
                    mine_path: to,
                    theirs_path: to,
                    out_path: to,
                    before,
                    after,
                    theirs: theirs_to,
                    seconds,
                }),
                // renamed to different names: the user picks the name
                Some(c) => {
                    self.conflict(to, &super::merge::Conflict::default(), before.as_ref(), &c);
                    Ok(())
                }
                // deleted on the other side: the rename stands
                None => plain(self),
            },
        }
    }
}

/// Re-makes `local` (oldest first) on top of `onto` (`None`: an empty tree).
fn replay(
    repo: &Repo,
    root: &Path,
    onto: Option<&str>,
    local: &[String],
    device: &str,
) -> Result<Replayed, Error> {
    let read = |e: &Entry| repo.blob(&e.id).ok();
    // what the other side renamed since the first local commit's parent: only what its commits
    // recorded and exact blobs, never similar text over a range (two notes from one template)
    let remote_moves = match (onto, local.first()) {
        (Some(onto), Some(first)) => {
            let base = repo.parent_of(first)?;
            let changes = repo.tree_changes(base.as_deref(), Some(onto))?;
            let (mut range, _) = repo.first_parent_not_in(onto, base.as_deref())?;
            range.reverse();
            let mut recorded = Vec::new();
            for id in &range {
                let message = repo.commit_data(id)?.message;
                recorded.extend(super::message::parse(&String::from_utf8_lossy(&message)).moves);
            }
            let hints = super::renames::chain(recorded);
            super::renames::detect(&changes, &hints, &read, Similar::Off)
                .into_iter()
                .collect()
        }
        _ => BTreeMap::new(),
    };
    let mut st = Replay {
        repo,
        root,
        onto,
        device,
        edits: BTreeMap::new(),
        remote_moves,
        alias: BTreeMap::new(),
        out: Replayed {
            head: onto.map(str::to_string),
            kept: 0,
            skip: BTreeSet::new(),
            conflicts: Vec::new(),
            copies: Vec::new(),
            restored: Vec::new(),
            held: Vec::new(),
        },
    };
    let mut prev_tree = repo.write_tree(onto, &[])?;
    for id in local {
        let data = repo.commit_data(id)?;
        let parent = data.parents.first().map(String::as_str);
        let changes = repo.tree_changes(parent, Some(id))?;
        let hints = super::message::parse(&String::from_utf8_lossy(&data.message)).moves;
        let moved = super::renames::detect(&changes, &hints, &read, Similar::InCommit);
        let at = |p: &str| changes.iter().find(|c| c.path == p);
        for ch in &changes {
            if moved.iter().any(|(_, to)| *to == ch.path) {
                continue; // settled with the file it came from
            }
            match moved.iter().find(|(from, _)| *from == ch.path) {
                Some((_, to)) => match at(to) {
                    Some(added) => st.rename((ch, added), data.author.seconds)?,
                    None => st.change(ch, data.author.seconds)?,
                },
                None => st.change(ch, data.author.seconds)?,
            }
        }
        let list: Vec<TreeEdit> = st
            .edits
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
        let parents: Vec<String> = st.out.head.iter().cloned().collect();
        let new = repo.write_commit(
            &tree,
            &parents,
            &data.message,
            &data.author,
            &data.committer,
        )?;
        st.out.head = Some(new);
        st.out.kept += 1;
        prev_tree = tree;
    }
    Ok(st.out)
}

pub(crate) fn record_of(
    path: &str,
    c: &super::merge::Conflict,
    base: Option<&Entry>,
    theirs_path: Option<String>,
) -> Record {
    Record {
        path: path.to_string(),
        hunks: c.hunks.len() as u32,
        properties: c.properties.iter().map(|p| p.name.clone()).collect(),
        base: base.map(|e| e.id.clone()),
        theirs_path,
    }
}

/// Writes what a sync could not settle into `conflicts.json` (a file already there is replaced).
fn record_conflicts(root: &Path, report: &Report, since: Seen) -> io::Result<()> {
    let new = |len: usize, at: usize| at < len;
    if !new(report.conflicts.len(), since.conflicts)
        && !new(report.copies.len(), since.copies)
        && !new(report.restored.len(), since.restored)
        && !new(report.refused.len(), since.refused)
    {
        return Ok(());
    }
    let mut book = conflicts::read(root);
    for r in &report.conflicts[since.conflicts..] {
        book.files.retain(|f| f.path != r.path);
        book.files.push(r.clone());
    }
    book.copies
        .extend(report.copies[since.copies..].iter().cloned());
    book.restored
        .extend(report.restored[since.restored..].iter().cloned());
    for r in &report.refused[since.refused..] {
        if !book.refused.contains(r) {
            book.refused.push(r.clone());
        }
    }
    conflicts::write(root, &book)
}

/// How much of a report was already recorded.
#[derive(Clone, Copy, Default)]
struct Seen {
    conflicts: usize,
    copies: usize,
    restored: usize,
    refused: usize,
}

impl Seen {
    fn of(r: &Report) -> Seen {
        Seen {
            conflicts: r.conflicts.len(),
            copies: r.copies.len(),
            restored: r.restored.len(),
            refused: r.refused.len(),
        }
    }
}

/// An open note whose unsaved text overlaps what a sync wrote (the editor found it applying the
/// sync, spec "Cadence" > Sync): the conflict is recorded against HEAD's version (base: the text
/// the editor last saved), then the buffer `mine` is written to disk, so the note bar shows and
/// no automatic commit takes the user's text over the other device's. Run under the write lock.
pub fn record_editor_conflict(
    root: &Path,
    rel: &str,
    base: &str,
    mine: &str,
) -> Result<Record, Error> {
    let root = &root.canonicalize()?;
    let at = vault_ops::confine_with(root, rel, PROTECTED).map_err(vault_error)?;
    let repo = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
    let theirs = repo
        .entry_at(repo.head_id_string().as_deref(), &at.rel)?
        .map(|e| repo.blob(&e.id))
        .transpose()?;
    let base_entry = Entry {
        id: repo.write_blob(base.as_bytes())?,
        mode: Mode::Blob,
    };
    let c = match merge_file(
        &at.rel,
        Some(base.as_bytes()),
        Some(mine.as_bytes()),
        theirs.as_deref(),
    ) {
        Merged::Conflict(c) => c,
        _ => super::merge::Conflict::default(),
    };
    let record = record_of(&at.rel, &c, Some(&base_entry), None);
    let report = Report {
        conflicts: vec![record.clone()],
        ..Report::default()
    };
    record_conflicts(root, &report, Seen::default())?;
    put_file(&at, mine.as_bytes(), Mode::Blob)?;
    Ok(record)
}

// ---- the sync -------------------------------------------------------------------------------------

// ---- large files ------------------------------------------------------------------------------------

fn no_lfs() -> Error {
    Error::Transport(TransportError {
        kind: Kind::NoLfs,
        line: "Install git-lfs to sync large files".into(),
        details: String::new(),
    })
}

/// Runs `f` with the caller's repository lock released, when it gave a way to.
fn unlocked(opts: &Options<'_>, f: &mut dyn FnMut()) {
    match opts.unlocked {
        Some(u) => u(f),
        None => f(),
    }
}

/// Before the working tree follows `remote`: the large files it adds or changes (pointers whose
/// object is not in the local store) are downloaded, so the files written are the real ones.
/// With `git-lfs` missing nothing is fetched: the pointers are written as they are and
/// [`catch_up_lfs`] replaces them once it is installed. `true` when a download ran (with the
/// lock released: the caller re-reads the repository).
fn fetch_lfs_objects(
    repo: &Repo,
    transport: &Transport<'_>,
    branch: &str,
    head: Option<&str>,
    remote: &str,
    opts: &Options<'_>,
) -> Result<bool, Error> {
    let missing = repo.tree_changes(head, Some(remote))?.iter().any(|c| {
        c.after
            .as_ref()
            .filter(|e| e.mode != Mode::Link)
            .and_then(|e| repo.pointer_of_blob(&e.id))
            .is_some_and(|p| !lfs::has_object(repo.common_dir(), &p))
    });
    if !missing || !transport.exec.lfs_installed() {
        return Ok(false);
    }
    let mut result = Ok(());
    unlocked(opts, &mut || result = transport.lfs_fetch(branch));
    result?;
    Ok(true)
}

/// A file that is still a pointer on disk (written while `git-lfs` was missing, or by a plain
/// clone) becomes its content once the object is in the store. One best-effort download for all
/// of them: a failure is logged and the files are reported in `lfs_missing`; it never stops the
/// sync (the push does not need the content).
fn catch_up_lfs(
    repo: &Repo,
    transport: &Transport<'_>,
    report: &mut Report,
    opts: &Options<'_>,
) -> Result<(), Error> {
    let (root, common) = (repo.root(), repo.common_dir());
    let pending: Vec<(String, Pointer)> = repo
        .lfs_files()
        .into_iter()
        .filter(|rel| place(root, rel).is_some() && lfs::file_is_pointer(&root.join(rel)))
        .filter_map(|rel| repo.head_pointer(&rel).map(|p| (rel, p)))
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    if pending.iter().any(|(_, p)| !lfs::has_object(common, p)) && transport.exec.lfs_installed() {
        if let Some(branch) = repo.head_branch() {
            let mut result = Ok(());
            unlocked(opts, &mut || result = transport.lfs_fetch(&branch));
            if let Err(e) = result {
                log::warn!(target: "git", "git: large files not downloaded: {}", e.line);
            }
        }
    }
    let (ready, missing): (Vec<_>, Vec<_>) = pending
        .into_iter()
        .partition(|(_, p)| lfs::has_object(common, p));
    let paths: Vec<String> = ready.iter().map(|(rel, _)| rel.clone()).collect();
    if let (Some(f), false) = (opts.announce, paths.is_empty()) {
        f(&paths);
    }
    let canonical = root.canonicalize()?;
    for (rel, p) in &ready {
        // the one confinement of every write the sync makes (a refused path is left alone)
        if let Some(at) = place(&canonical, rel) {
            lfs::materialize(common, &at.abs, p)?;
        }
    }
    if !paths.is_empty() {
        repo.refresh_index(&paths)?;
        report.written.extend(paths);
    }
    report
        .lfs_missing
        .extend(missing.into_iter().map(|(rel, _)| rel));
    Ok(())
}

/// Before the push: the objects of the large files in the history go first (a file deleted since
/// still has its pointer in older commits, so the test is the local store, not the tracked list).
/// The remote must never get a pointer without its object, so with `git-lfs` missing the push
/// stops here. `true` when the upload ran with the lock released.
fn push_lfs_objects(
    repo: &Repo,
    transport: &Transport<'_>,
    branch: &str,
    opts: &Options<'_>,
) -> Result<bool, Error> {
    if !lfs::has_store(repo.common_dir()) {
        return Ok(false);
    }
    if !transport.exec.lfs_installed() {
        return Err(no_lfs());
    }
    let mut result = Ok(());
    unlocked(opts, &mut || result = transport.lfs_push(branch));
    result?;
    Ok(true)
}

/// Does any of `commits` add a plugin's settings that hold a token the user has not allowed?
fn held_in(repo: &Repo, root: &Path, commits: &[String]) -> Result<bool, Error> {
    for id in commits {
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
        .filter(|c| !skip.contains(&c.path) && vault_ops::rel_allowed(&c.path, PROTECTED))
        .map(|c| c.path.clone())
        .collect();
    if !paths.is_empty() {
        f(&paths);
    }
}

/// Moves the branch to `new`, then brings the working tree and the index along, recording the
/// move first so a crash can be finished (see the module docs); the record goes as soon as the
/// working tree and the index follow, so a failure after (the push) leaves nothing to recover.
#[allow(clippy::too_many_arguments)]
fn adopt(
    repo: &Repo,
    root: &Path,
    old: Option<&str>,
    new: &str,
    skip: &BTreeSet<String>,
    device: &str,
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
    #[cfg(test)]
    tests::hooks::after_move_head(root)?;
    let changes = repo.tree_changes(old, Some(new))?;
    tell(announce, &changes, skip);
    follow_worktree(repo, root, &changes, skip, device, report)?;
    repo.refresh_index(&report.written)?;
    clear_progress(root)?;
    Ok(())
}

/// One whole sync of the vault at `root`. Commit the pending changes first (the caller does:
/// step 1 of the spec); this is steps 2 to 4.
pub fn sync(root: &Path, opts: &Options<'_>) -> Outcome {
    let mut report = Report::default();
    // the confinement compares canonical paths
    let error = match root.canonicalize() {
        Ok(root) => run(&root, opts, &mut report).err(),
        Err(e) => Some(e.into()),
    };
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
    if let Some(r) = recover(root, opts.announce, opts.device)? {
        report.written.extend(r.written);
        report.refused.extend(r.refused);
    }
    if let Some(repo) = Repo::open(root)? {
        conflicts::forget_settled(root, &repo.changes()?)?;
    }
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
        if behind > 0 {
            if let Some(r) = &remote {
                if fetch_lfs_objects(&repo, &transport, &branch, head.as_deref(), r, opts)? {
                    // the lock was let go for the download: start again if a commit landed
                    let now = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
                    if now.head_id_string() != head {
                        continue;
                    }
                }
            }
        }
        let mut oldest_first = local.clone();
        oldest_first.reverse();
        let hold = !oldest_first.is_empty() && held_in(&repo, root, &oldest_first)?;
        let mut seen = Seen::of(report);
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
                        opts.device,
                        report,
                        opts.announce,
                    )?;
                    report.pulled += behind;
                }
                _ => {
                    let replayed =
                        replay(&repo, root, remote.as_deref(), &oldest_first, opts.device)?;
                    report.pulled += behind;
                    report.conflicts.extend(replayed.conflicts);
                    report.copies.extend(replayed.copies);
                    report.restored.extend(replayed.restored);
                    for h in replayed.held {
                        if !report.held.iter().any(|x| x.path == h.path) {
                            report.held.push(h);
                        }
                    }
                    // the replay's conflicts are recorded before the branch moves: a crash after
                    // the move must still find them (the recovery skips those files)
                    record_conflicts(root, report, seen)?;
                    seen = Seen::of(report);
                    if let Some(new) = &replayed.head {
                        adopt(
                            &repo,
                            root,
                            head.as_deref(),
                            new,
                            &replayed.skip,
                            opts.device,
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
        let unpushed = match &head {
            None => Vec::new(),
            Some(h) => repo.first_parent_not_in(h, remote.as_deref())?.0,
        };
        catch_up_lfs(&repo, &transport, report, opts)?;
        if unpushed.is_empty() {
            return Ok(());
        }
        // the last guard: nothing that holds a held-back token leaves this device, whatever the
        // replay could or could not rebuild (no head to move to, a merge that brought one in)
        if held_in(&repo, root, &unpushed)? {
            return Ok(());
        }
        if push_lfs_objects(&repo, &transport, &branch, opts)? {
            let now = Repo::open(root)?.ok_or(repo::Error::NotARepo)?;
            if now.head_id_string() != head {
                continue;
            }
        }
        match transport.push(&branch) {
            Ok(()) => {
                report.pushed += unpushed.len();
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
pub(crate) mod tests;
