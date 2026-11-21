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
        for rel in candidates {
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
        Ok(out)
    }

    /// Commits `changes` (their files as they are on disk now) with `message`, on HEAD. Returns the
    /// commit id. Fails with [`Error::NoIdentity`] before touching anything when git has no
    /// identity for us.
    pub fn commit(&self, changes: &[Change], message: &Message) -> Result<String> {
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
