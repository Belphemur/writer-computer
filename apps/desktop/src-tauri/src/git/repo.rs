//! The repository, through `gix`: open, init, status, commit of a set of paths and the history of
//! a path. The only file that touches a `gix::Repository`.
//!
//! A repository is reopened for each operation (cheap) instead of kept, so a commit made by the
//! user's own `git` between two calls is always seen and nothing here is shared between threads.
//!
//! Commits are written the way `git` would: blobs, a tree edited from HEAD's, the commit on
//! `HEAD`, then the index updated for the committed paths (with their stat data, so the next
//! status does not rehash the vault). Only the paths given are committed; everything else in the
//! index and the working tree stays as it was.

use super::message::{self, Change, Message};
use gix::bstr::{BStr, BString, ByteSlice};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a git repository")]
    NotARepo,
    /// No name and email resolved the way `git commit` resolves them: nothing is guessed.
    #[error("Set your git name and email: git config --global user.name \"Your Name\" and git config --global user.email you@example.com")]
    NoIdentity,
    /// A merge, rebase, cherry-pick, revert or bisect is in progress, or HEAD is detached: Writer
    /// never commits then (its commit would land in the middle of the user's operation).
    #[error("Version history is paused: {0}")]
    Operation(String),
    #[error("{0}")]
    Git(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn git<E: std::fmt::Display>(e: E) -> Error {
    Error::Git(e.to_string())
}

pub type Result<T> = std::result::Result<T, Error>;

/// A resolved author or committer, as `git var GIT_AUTHOR_IDENT` names it (without the date).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

/// The author and committer a commit would get.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identities {
    pub author: Identity,
    pub committer: Identity,
}

/// One commit of the history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub id: String,
    /// Seconds since the epoch (the committer time).
    pub time: i64,
    pub message: message::Parsed,
}

/// What a commit did to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionKind {
    Add,
    Edit,
    Delete,
    /// Moved (and maybe edited) from another path.
    Move,
}

/// One version of a file: a commit that changed it, the blobs on either side by id (read them
/// with [`Repo::blob`]). Newer commits come first in a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub id: String,
    pub time: i64,
    pub message: message::Parsed,
    /// The file's path in this commit (the new path of a move; the path a delete removed).
    pub path: String,
    /// A move's old path.
    pub from: Option<String>,
    pub kind: VersionKind,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// A file that was removed from the vault and is not there now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deleted {
    pub path: String,
    /// The commit that removed it.
    pub id: String,
    pub time: i64,
}

/// A file over this is not versioned until LFS exists (the default of `git.lfs-threshold-mb`).
pub const LARGE_FILE_BYTES: u64 = 100 * 1024 * 1024;

pub struct Repo {
    root: PathBuf,
    repo: gix::Repository,
}

#[cfg(test)]
thread_local! {
    /// Tests read only the repository's own config, never the user's (`HOME`, `XDG_CONFIG_HOME`,
    /// the system config, `GIT_*`): a thread-local, so the other tests are unaffected.
    pub(crate) static ISOLATED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn open_gix(root: &Path) -> Result<gix::Repository> {
    #[cfg(test)]
    if ISOLATED.with(|i| i.get()) {
        return gix::open_opts(root, gix::open::Options::isolated()).map_err(git);
    }
    gix::open(root).map_err(git)
}

fn identity<E: std::fmt::Display>(
    sig: Option<std::result::Result<gix::actor::SignatureRef<'_>, E>>,
) -> Result<Identity> {
    match sig {
        Some(Ok(s)) if !s.name.is_empty() && !s.email.is_empty() => Ok(Identity {
            name: s.name.to_str_lossy().into_owned(),
            email: s.email.to_str_lossy().into_owned(),
        }),
        Some(Err(e)) => Err(git(e)),
        _ => Err(Error::NoIdentity),
    }
}

fn rel_of(p: &BStr) -> String {
    p.to_str_lossy().into_owned()
}

impl Repo {
    /// The repository whose working tree is exactly `root` (never one above it), if there is one.
    pub fn open(root: &Path) -> Result<Option<Repo>> {
        if !root.join(".git").exists() {
            return Ok(None);
        }
        let repo = open_gix(root)?;
        Ok(Some(Repo {
            root: root.to_path_buf(),
            repo,
        }))
    }

    /// `git init` in `root` (through gix: no `git` binary needed), or the repository already there.
    pub fn init(root: &Path) -> Result<Repo> {
        if let Some(repo) = Repo::open(root)? {
            return Ok(repo);
        }
        gix::init(root).map_err(git)?;
        Ok(Repo {
            root: root.to_path_buf(),
            repo: open_gix(root)?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Author and committer exactly as the installed `git` resolves them (`git var`, see
    /// `system.rs`): the environment, the repository's config with `include` and `includeIf`, the
    /// global, XDG and system config. Without a `git` binary, gix's own resolution of the same
    /// sources ([`Repo::identities_via_gix`]). `None` for either is [`Error::NoIdentity`]: nothing
    /// is invented (git is run with `user.useConfigOnly`, and gix never guesses).
    pub fn identities(&self) -> Result<Identities> {
        #[cfg(test)]
        if ISOLATED.with(|i| i.get()) {
            // tests read only the repository's own config, never the user's: no system git
            return self.identities_via_gix();
        }
        match super::system::identities(&self.root) {
            Ok(Some((author, committer))) => Ok(Identities { author, committer }),
            Ok(None) => self.identities_via_gix(),
            Err(e) if e == "none" => Err(Error::NoIdentity),
            Err(e) => Err(Error::Git(e)),
        }
    }

    /// gix's resolution, for when `git` is absent. git matches `includeIf "gitdir:"` against the
    /// resolved path of the repository, gix against the path as given: so the resolved path is
    /// tried first and the given one second, which agrees with git through a symlink.
    pub(crate) fn identities_via_gix(&self) -> Result<Identities> {
        let of = |repo: &gix::Repository| -> Result<Identities> {
            Ok(Identities {
                author: identity(repo.author())?,
                committer: identity(repo.committer())?,
            })
        };
        if let Ok(real) = self.root.canonicalize() {
            if real != self.root {
                if let Ok(repo) = open_gix(&real) {
                    if let Ok(ids) = of(&repo) {
                        return Ok(ids);
                    }
                }
            }
        }
        of(&self.repo)
    }

    pub fn has_commits(&self) -> bool {
        self.repo.head_id().is_ok()
    }

    /// The committer time of HEAD, `None` with no commit.
    pub fn last_commit_time(&self) -> Option<i64> {
        self.repo.head_commit().ok()?.time().ok().map(|t| t.seconds)
    }

    fn head_tree(&self) -> Option<gix::Tree<'_>> {
        self.repo.head_commit().ok()?.tree().ok()
    }

    fn head_blob(&self, tree: Option<&gix::Tree<'_>>, rel: &str) -> Option<gix::ObjectId> {
        let entry = tree?.lookup_entry_by_path(rel).ok()??;
        entry.mode().is_blob().then(|| entry.object_id())
    }

    fn disk_blob(&self, rel: &str) -> Option<gix::ObjectId> {
        let path = self.root.join(rel);
        if !std::fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        gix::objs::compute_hash(self.repo.object_hash(), gix::object::Kind::Blob, &bytes).ok()
    }

    /// The vault's changes against HEAD, files only: what the worktree and the index differ in,
    /// classified by comparing the file with HEAD's version. A delete and an add of the same
    /// content are one move. Sorted by path. Untracked files count unless ignored.
    pub fn changes(&self) -> Result<Vec<Change>> {
        Ok(self.changes_and_skipped()?.0)
    }

    /// [`Repo::changes`], plus the files Writer does not version: over [`LARGE_FILE_BYTES`] (no
    /// LFS yet), anywhere under a `node_modules` folder, or inside a nested repository (a folder
    /// with a `.git` of its own is that repository's, never walked into). The skipped large files
    /// are listed (vault-relative) so the panel can say so.
    pub fn changes_and_skipped(&self) -> Result<(Vec<Change>, Vec<String>)> {
        let items = self
            .repo
            .status(gix::progress::Discard)
            .map_err(git)?
            .untracked_files(gix::status::UntrackedFiles::Files)
            .index_worktree_rewrites(None)
            .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
            .into_iter(Vec::<BString>::new())
            .map_err(git)?;
        let mut candidates = BTreeSet::new();
        for item in items {
            let item = item.map_err(git)?;
            candidates.insert(rel_of(item.location()));
        }
        let tree = self.head_tree();
        let mut adds: BTreeMap<String, gix::ObjectId> = BTreeMap::new();
        let mut deletes: BTreeMap<String, gix::ObjectId> = BTreeMap::new();
        let mut out: Vec<Change> = Vec::new();
        let mut too_large: Vec<String> = Vec::new();
        for rel in candidates {
            if self.not_ours(&rel) {
                continue;
            }
            if std::fs::symlink_metadata(self.root.join(&rel))
                .is_ok_and(|m| m.is_file() && m.len() > LARGE_FILE_BYTES)
            {
                too_large.push(rel);
                continue;
            }
            let head = self.head_blob(tree.as_ref(), &rel);
            let disk = self.disk_blob(&rel);
            match (head, disk) {
                (Some(h), Some(d)) if h != d => out.push(Change::Edit(rel)),
                (None, Some(d)) => {
                    adds.insert(rel, d);
                }
                (Some(h), None) if !self.root.join(&rel).is_dir() => {
                    deletes.insert(rel, h);
                }
                _ => {}
            }
        }
        for (to, id) in adds {
            let from = deletes
                .iter()
                .find(|(_, h)| **h == id)
                .map(|(p, _)| p.clone());
            match from {
                Some(from) => {
                    deletes.remove(&from);
                    out.push(Change::Move { from, to });
                }
                None => out.push(Change::Add(to)),
            }
        }
        out.extend(deletes.into_keys().map(Change::Delete));
        out.sort_by(|a, b| a.path().cmp(b.path()));
        Ok((out, too_large))
    }

    /// Under `node_modules`, or inside a folder that is a repository of its own.
    fn not_ours(&self, rel: &str) -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.contains(&"node_modules") {
            return true;
        }
        (1..parts.len()).any(|n| self.root.join(parts[..n].join("/")).join(".git").exists())
    }

    /// Commits `changes` (their files as they are on disk now) with `message`, on HEAD. Returns the
    /// commit id. Fails with [`Error::NoIdentity`] before touching anything when git has no
    /// identity for us.
    pub fn commit(&self, changes: &[Change], message: &Message) -> Result<String> {
        if let Some(op) = super::operation(&self.root) {
            return Err(Error::Operation(op.label().into()));
        }
        let ids = self.identities()?;
        let repo = &self.repo;
        let signature = |who: &Identity| gix::actor::Signature {
            name: who.name.as_str().into(),
            email: who.email.as_str().into(),
            time: gix::date::Time::now_local_or_utc(),
        };
        let (committer, author) = (signature(&ids.committer), signature(&ids.author));
        let (mut committer_time, mut author_time) = (Default::default(), Default::default());
        let parent = repo.head_id().ok().map(|id| id.detach());
        let base = match &parent {
            Some(_) => repo.head_tree_id().map_err(git)?.detach(),
            None => repo.empty_tree().id,
        };
        let mut editor = repo.edit_tree(base).map_err(git)?;
        let mut index_file: gix::index::File = (**repo.index_or_empty().map_err(git)?).clone();
        let index: &mut gix::index::State = &mut index_file;

        let drop_from_index = |rel: &str, index: &mut gix::index::State| {
            index.remove_entries(|_, path, _| path == rel.as_bytes());
        };
        for change in changes {
            match change {
                Change::Delete(rel) => {
                    editor.remove(rel.as_str()).map_err(git)?;
                    drop_from_index(rel, index);
                }
                Change::Move { from, to } => {
                    editor.remove(from.as_str()).map_err(git)?;
                    drop_from_index(from, index);
                    self.stage(&mut editor, index, to)?;
                }
                Change::Add(rel) | Change::Edit(rel) => self.stage(&mut editor, index, rel)?,
            }
        }
        index.sort_entries();
        let tree = editor.write().map_err(git)?;
        let id = repo
            .commit_as(
                committer.to_ref(&mut committer_time),
                author.to_ref(&mut author_time),
                "HEAD",
                message.render(),
                tree.detach(),
                parent,
            )
            .map_err(git)?;
        index_file
            .write(gix::index::write::Options::default())
            .map_err(git)?;
        Ok(id.to_string())
    }

    fn stage(
        &self,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        rel: &str,
    ) -> Result<()> {
        let path = self.root.join(rel);
        let bytes = std::fs::read(&path)?;
        let id = self.repo.write_blob(&bytes).map_err(git)?.detach();
        let meta = gix::index::fs::Metadata::from_path_no_follow(&path)?;
        let executable = is_executable(&path);
        let (kind, mode) = if executable {
            (
                gix::object::tree::EntryKind::BlobExecutable,
                gix::index::entry::Mode::FILE_EXECUTABLE,
            )
        } else {
            (
                gix::object::tree::EntryKind::Blob,
                gix::index::entry::Mode::FILE,
            )
        };
        editor.upsert(rel, kind, id).map_err(git)?;
        index.remove_entries(|_, p, _| p == rel.as_bytes());
        let stat = gix::index::entry::Stat::from_fs(&meta).map_err(git)?;
        index.dangerously_push_entry(
            stat,
            id,
            gix::index::entry::Flags::empty(),
            mode,
            rel.as_bytes().as_bstr(),
        );
        Ok(())
    }

    /// The commits, newest first, that changed `path` (every commit with `None`), at most `limit`.
    pub fn log(&self, path: Option<&str>, limit: usize) -> Result<Vec<LogEntry>> {
        let Ok(head) = self.repo.head_id() else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        let walk = head.ancestors().all().map_err(git)?;
        for info in walk {
            if out.len() >= limit {
                break;
            }
            let info = info.map_err(git)?;
            let commit = info.object().map_err(git)?;
            if let Some(path) = path {
                let here = commit_blob(&commit, path);
                let before = match commit.parent_ids().next() {
                    Some(p) => {
                        let parent = self.repo.find_commit(p).map_err(git)?;
                        commit_blob(&parent, path)
                    }
                    None => None,
                };
                if here == before {
                    continue;
                }
            }
            let time = commit.time().map_err(git)?.seconds;
            let text = commit.message_raw_sloppy().to_str_lossy().into_owned();
            out.push(LogEntry {
                id: commit.id.to_string(),
                time,
                message: message::parse(&text),
            });
        }
        Ok(out)
    }
}

impl Repo {
    fn find(&self, id: &str) -> Result<gix::Commit<'_>> {
        let id = gix::ObjectId::from_hex(id.as_bytes()).map_err(git)?;
        self.repo.find_commit(id).map_err(git)
    }

    /// The full id of `rev`: a full id, or a prefix (4 characters or more) of one commit of the
    /// history.
    pub fn resolve(&self, rev: &str) -> Result<String> {
        let rev = rev.trim();
        if rev.len() == 40 && self.find(rev).is_ok() {
            return Ok(rev.to_ascii_lowercase());
        }
        if rev.len() < 4 || !rev.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Git(format!("unknown version {rev}")));
        }
        let rev = rev.to_ascii_lowercase();
        // ids only: no commit message is read or parsed
        let Ok(head) = self.repo.head_id() else {
            return Err(Error::Git(format!("unknown version {rev}")));
        };
        let mut found: Option<String> = None;
        for info in head.ancestors().all().map_err(git)?.take(10_000) {
            let id = info.map_err(git)?.id.to_string();
            if id.starts_with(&rev) {
                if found.is_some() {
                    return Err(Error::Git(format!("version {rev} is ambiguous")));
                }
                found = Some(id);
            }
        }
        found.ok_or_else(|| Error::Git(format!("unknown version {rev}")))
    }

    /// The first parent of a commit, if it has one.
    pub fn parent_of(&self, rev: &str) -> Result<Option<String>> {
        Ok(self.find(rev)?.parent_ids().next().map(|p| p.to_string()))
    }

    /// The bytes of a blob by id.
    pub fn blob(&self, id: &str) -> Result<Vec<u8>> {
        let id = gix::ObjectId::from_hex(id.as_bytes()).map_err(git)?;
        Ok(self.repo.find_object(id).map_err(git)?.detach().data)
    }

    /// The file at `path` in commit `rev`: its blob id, `None` when it was not there.
    pub fn blob_id_at(&self, rev: &str, path: &str) -> Result<Option<String>> {
        Ok(commit_blob(&self.find(rev)?, path).map(|i| i.to_string()))
    }

    /// Exact content renames and (by similarity) edited ones between a commit and its parent, the
    /// way git detects them: `(from, to)` of every moved file.
    fn renames_in(&self, commit: &gix::Commit<'_>) -> Result<Vec<(String, String)>> {
        let new_tree = commit.tree().map_err(git)?;
        let old_tree = match commit.parent_ids().next() {
            Some(p) => self.repo.find_commit(p).map_err(git)?.tree().map_err(git)?,
            None => self.repo.empty_tree(),
        };
        let changes = self
            .repo
            .diff_tree_to_tree(&old_tree, &new_tree, Option::<gix::diff::Options>::None)
            .map_err(git)?;
        Ok(changes
            .into_iter()
            .filter_map(|c| match c {
                gix::object::tree::diff::ChangeDetached::Rewrite {
                    source_location,
                    location,
                    copy: false,
                    ..
                } => Some((rel_of(source_location.as_ref()), rel_of(location.as_ref()))),
                _ => None,
            })
            .collect())
    }

    /// What `commit` did to the file at `current` (`here` and `before` are its blob ids in the
    /// commit and in its first parent, already known to differ): the version, with the old path
    /// of a move.
    fn version_of(
        &self,
        commit: &gix::Commit<'_>,
        parent: Option<&gix::Commit<'_>>,
        current: &str,
        here: Option<gix::ObjectId>,
        before: Option<gix::ObjectId>,
    ) -> Result<Version> {
        let text = commit.message_raw_sloppy().to_str_lossy().into_owned();
        let mut version = Version {
            id: commit.id.to_string(),
            time: commit.time().map_err(git)?.seconds,
            path: current.to_string(),
            from: None,
            kind: VersionKind::Edit,
            before: before.map(|i| i.to_string()),
            after: here.map(|i| i.to_string()),
            message: message::parse(&text),
        };
        match (here, before) {
            (Some(_), None) => {
                let source = version
                    .message
                    .moves
                    .iter()
                    .find(|(_, to)| to == current)
                    .map(|(from, _)| from.clone())
                    .filter(|from| parent.is_some_and(|p| commit_blob(p, from).is_some()))
                    .or_else(|| {
                        self.renames_in(commit)
                            .ok()?
                            .into_iter()
                            .find(|(_, to)| to == current)
                            .map(|(from, _)| from)
                    });
                match source {
                    Some(from) => {
                        version.kind = VersionKind::Move;
                        version.before = parent
                            .and_then(|p| commit_blob(p, &from))
                            .map(|i| i.to_string());
                        version.from = Some(from);
                    }
                    None => version.kind = VersionKind::Add,
                }
            }
            (None, Some(_)) => version.kind = VersionKind::Delete,
            _ => {}
        }
        Ok(version)
    }

    /// The version commit `rev` made of the file at `path` (its path in that commit): one commit
    /// is looked at, not the file's history. `None` when the commit did not change that path.
    pub fn version_in_commit(&self, rev: &str, path: &str) -> Result<Option<Version>> {
        let commit = self.find(rev)?;
        let parent = match commit.parent_ids().next() {
            Some(p) => Some(self.repo.find_commit(p).map_err(git)?),
            None => None,
        };
        let here = commit_blob(&commit, path);
        let before = parent.as_ref().and_then(|p| commit_blob(p, path));
        if here == before {
            return Ok(None);
        }
        self.version_of(&commit, parent.as_ref(), path, here, before)
            .map(Some)
    }

    /// The id of HEAD, `None` with no commit: what a cache of histories is keyed on.
    pub fn head_id_string(&self) -> Option<String> {
        self.repo.head_id().ok().map(|i| i.to_string())
    }

    /// The versions of a file, newest first, at most `limit`, following renames: Writer's own
    /// (`Writer-Move` trailers of its commits) first, git's rename detection for the rest. Older
    /// entries carry the old path. A commit's blob is looked up once and reused as the next
    /// commit's "before", and the walk stops at `limit`.
    pub fn file_versions(&self, path: &str, limit: usize) -> Result<Vec<Version>> {
        let Ok(head) = self.repo.head_id() else {
            return Ok(Vec::new());
        };
        let mut current = path.to_string();
        let mut out = Vec::new();
        // the file's blob in a commit, for `current`; dropped when `current` changes
        let mut memo: BTreeMap<gix::ObjectId, Option<gix::ObjectId>> = BTreeMap::new();
        for info in head.ancestors().all().map_err(git)? {
            if out.len() >= limit {
                break;
            }
            let commit = info.map_err(git)?.object().map_err(git)?;
            let parent = match commit.parent_ids().next() {
                Some(p) => Some(self.repo.find_commit(p).map_err(git)?),
                None => None,
            };
            let here = *memo
                .entry(commit.id)
                .or_insert_with(|| commit_blob(&commit, &current));
            let before = match &parent {
                Some(p) => *memo.entry(p.id).or_insert_with(|| commit_blob(p, &current)),
                None => None,
            };
            if here == before {
                continue;
            }
            let version = self.version_of(&commit, parent.as_ref(), &current, here, before)?;
            if let Some(from) = &version.from {
                current = from.clone();
                memo.clear();
            }
            out.push(version);
        }
        Ok(out)
    }

    /// Files removed from the vault and absent now, newest removal first (a rename is not a
    /// removal). Looks at most `max_commits` back.
    pub fn deleted_files(&self, max_commits: usize) -> Result<Vec<Deleted>> {
        let Ok(head) = self.repo.head_id() else {
            return Ok(Vec::new());
        };
        let head_tree = self.head_tree();
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for (n, info) in head.ancestors().all().map_err(git)?.enumerate() {
            if n >= max_commits {
                break;
            }
            let commit = info.map_err(git)?.object().map_err(git)?;
            let new_tree = commit.tree().map_err(git)?;
            let old_tree = match commit.parent_ids().next() {
                Some(p) => self.repo.find_commit(p).map_err(git)?.tree().map_err(git)?,
                None => break,
            };
            let changes = self
                .repo
                .diff_tree_to_tree(&old_tree, &new_tree, Option::<gix::diff::Options>::None)
                .map_err(git)?;
            let time = commit.time().map_err(git)?.seconds;
            for change in changes {
                let gix::object::tree::diff::ChangeDetached::Deletion {
                    location,
                    entry_mode,
                    ..
                } = change
                else {
                    continue;
                };
                let path = rel_of(location.as_ref());
                if !entry_mode.is_blob()
                    || super::ignore::device_local(&path)
                    || crate::vault_ops::is_protected_rel(&path)
                    || path.split('/').any(|p| p == "node_modules")
                    || self.head_blob(head_tree.as_ref(), &path).is_some()
                    || !seen.insert(path.clone())
                {
                    continue;
                }
                out.push(Deleted {
                    path,
                    id: commit.id.to_string(),
                    time,
                });
            }
        }
        Ok(out)
    }
}

fn commit_blob(commit: &gix::Commit<'_>, rel: &str) -> Option<gix::ObjectId> {
    let tree = commit.tree().ok()?;
    let entry = tree.lookup_entry_by_path(rel).ok()??;
    entry.mode().is_blob().then(|| entry.object_id())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_: &Path) -> bool {
    false
}

/// The local time, `2026-11-20 14:03:00 -0500`.
pub fn now_iso() -> String {
    gix::date::Time::now_local_or_utc()
        .format(gix::date::time::format::ISO8601)
        .unwrap_or_default()
}

/// `2026-11-19 14:03` for a commit time, in the machine's current local offset.
pub fn format_local(seconds: i64) -> String {
    let offset = gix::date::Time::now_local_or_utc().offset;
    gix::date::Time { seconds, offset }
        .format(gix::date::time::format::ISO8601)
        .unwrap_or_default()
        .chars()
        .take(16)
        .collect()
}
