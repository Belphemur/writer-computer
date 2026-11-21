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
    // a file already in conflict keeps the user's version until the merge view settles it
    let open = conflicts::paths(root);
    for ch in changes {
        if skip.contains(&ch.path) || open.contains(&ch.path) || !safe_rel(&ch.path) {
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
                let copy = conflict_copy_name(s.mine_path, self.device, &stamp(s.seconds));
                self.edits.insert(copy.clone(), s.after.clone());
                self.out.copies.push((s.mine_path.to_string(), copy));
            }
            Merged::Conflict(c) => {
                self.out.skip.insert(s.mine_path.to_string());
                self.out.conflicts.push(record_of(
                    s.mine_path,
                    &c,
                    s.before.as_ref(),
                    (s.theirs_path != s.mine_path).then(|| s.theirs_path.to_string()),
                ));
            }
        }
        Ok(())
    }

    /// One file's change in a local commit, merged with what the rebuilt tree has.
    fn change(&mut self, ch: &TreeChange, seconds: i64) -> Result<(), Error> {
        if self.out.skip.contains(&ch.path) || !safe_rel(&ch.path) {
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
            }
        }
        // already the same on both sides
        if theirs == ch.after {
            return Ok(());
        }
        if let Some(after) = &ch.after {
            if after.mode != Mode::Link && plugin_scan::plugin_of(&ch.path).is_some() {
                let bytes = self.repo.blob(&after.id)?;
                if plugin_scan::flagged(self.root, &ch.path, &bytes) {
                    self.out.skip.insert(ch.path.clone());
                    self.out
                        .held
                        .extend(plugin_scan::held_among(self.root, [ch.path.as_str()]));
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
            || !safe_rel(from)
            || !safe_rel(to)
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
                    self.out.skip.insert(to.to_string());
                    self.out.conflicts.push(record_of(
                        to,
                        &super::merge::Conflict::default(),
                        before.as_ref(),
                        Some(c),
                    ));
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
    // what the other side renamed since the first local commit's parent
    let remote_moves = match (onto, local.first()) {
        (Some(onto), Some(first)) => {
            let base = repo.parent_of(first)?;
            let changes = repo.tree_changes(base.as_deref(), Some(onto))?;
            super::renames::detect(&changes, &[], &read)
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
        let moved = super::renames::detect(&changes, &hints, &read);
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

fn record_of(
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
                    report.conflicts.extend(replayed.conflicts);
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
pub(crate) mod tests;
