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

use super::lfs::{self, Lfs, Pointer};
use super::message::{self, Change, Message};
use super::signing::{self, Signing};
use super::transport::Exec;
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
    /// Commits are signed (git's configuration says so) and git could not sign: no commit is made.
    /// `details` is git's sanitized message, for the log and "Details".
    #[error("Signing failed: unlock your key")]
    Signing { details: String },
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

/// What [`Repo::baselines_at`] can vouch for about one path of a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaselineAt {
    /// The file's bytes there (never more than the reader's cap; the reader decides whether they
    /// are text).
    Bytes(Vec<u8>),
    /// The commit has no such file, under any spelling of its name, and git does not ignore it.
    Absent,
    /// Anything else: a folder, a link, over the cap, an LFS object not here, a conversion between
    /// blob and file, a path git ignores or does not version.
    Unknown,
}

/// A name as a case-insensitive or normalizing file system would compare it.
pub(crate) fn fold_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().to_lowercase()
}

/// Is `rel`, or a folder above it, excluded by the ignore rules? An error reads as ignored.
fn ignored(stack: &mut gix::AttributeStack<'_>, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    (1..=parts.len()).any(|n| {
        let mode = if n == parts.len() {
            gix::index::entry::Mode::FILE
        } else {
            gix::index::entry::Mode::DIR
        };
        match stack.at_entry(parts[..n].join("/").as_str(), Some(mode)) {
            Ok(platform) => platform.is_excluded(),
            Err(_) => true,
        }
    })
}

/// What one pass over the working tree found, against a commit.
struct Scan {
    changes: Vec<Change>,
    /// Over the size limit, not versioned.
    too_large: Vec<String>,
    /// Entries on disk that are not regular files (a symlink).
    non_files: Vec<String>,
    /// LFS-covered files that are still a pointer on disk.
    pointers: Vec<String>,
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

/// How a file goes into a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Via {
    Plain,
    /// As an LFS pointer; `needs_line`: no attribute rule covers it yet, the managed block of
    /// `.gitattributes` gets a line for it in the same commit.
    Pointer {
        needs_line: bool,
    },
}

pub struct Repo {
    root: PathBuf,
    repo: gix::Repository,
    /// The LFS settings this operation runs under ([`Repo::with_lfs`]; off unless set).
    lfs: Lfs,
    /// Does any `.gitattributes` name the LFS filter? Looked up once, forgotten when Writer
    /// rewrites the managed block.
    lfs_rules: std::cell::Cell<Option<bool>>,
    /// Where git children run for signing ([`Repo::with_exec`]); a short-lived runner with no scope
    /// of its own when unset, like the identity lookup.
    exec: Option<Exec>,
}

/// The `filter` attribute of paths, from every `.gitattributes` git reads (gix's attribute stack:
/// the root and nested files, `info/attributes`, the global file).
struct Rules<'r> {
    stack: gix::AttributeStack<'r>,
}

impl Rules<'_> {
    /// Does an attribute rule send `rel` through the `lfs` filter?
    fn covers(&mut self, rel: &str) -> bool {
        let mut out = self.stack.selected_attribute_matches(["filter"]);
        let Ok(platform) = self
            .stack
            .at_entry(rel, Some(gix::index::entry::Mode::FILE))
        else {
            return false;
        };
        platform.matching_attributes(&mut out);
        let hit = out
            .iter_selected()
            .any(|m| m.assignment.state.as_bstr().is_some_and(|v| v == "lfs"));
        hit
    }
}

impl Rules<'_> {
    /// Does git convert the file at `rel` between the blob and the working tree: `text`, `eol`,
    /// `crlf`, `ident`, `working-tree-encoding` set to anything but off, or a `filter` that is not
    /// `lfs` (an LFS file is handled by its pointer)?
    fn converts(&mut self, rel: &str) -> bool {
        let mut out = self.stack.selected_attribute_matches([
            "text",
            "eol",
            "crlf",
            "ident",
            "working-tree-encoding",
            "filter",
        ]);
        let Ok(platform) = self
            .stack
            .at_entry(rel, Some(gix::index::entry::Mode::FILE))
        else {
            return true;
        };
        platform.matching_attributes(&mut out);
        let hit = out.iter_selected().any(|m| {
            use gix::attrs::StateRef;
            let state = m.assignment.state;
            match (m.assignment.name.as_str(), state) {
                (_, StateRef::Unspecified | StateRef::Unset) => false,
                ("filter", StateRef::Value(v)) => v.as_bstr() != "lfs",
                _ => true,
            }
        });
        hit
    }
}

/// How many commits of the branch are looked at for a signature (the suggestion to sign).
const SIGNED_LOOKBACK: usize = 20;

#[cfg(test)]
thread_local! {
    /// Tests read only the repository's own config, never the user's (`HOME`, `XDG_CONFIG_HOME`,
    /// the system config, `GIT_*`): a thread-local, so the other tests are unaffected.
    pub(crate) static ISOLATED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The runner a repository without its own signs through in a test (a temporary `HOME`, a fake
    /// signer on `PATH`): isolated repositories otherwise never ask the installed git.
    pub(crate) static TEST_EXEC: std::cell::RefCell<Option<Exec>> = const { std::cell::RefCell::new(None) };
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
            lfs: Lfs::OFF,
            lfs_rules: Default::default(),
            exec: None,
        }))
    }

    /// [`Repo::open`] under these LFS settings.
    pub fn open_with(root: &Path, lfs: Lfs) -> Result<Option<Repo>> {
        Ok(Repo::open(root)?.map(|r| r.with_lfs(lfs)))
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
            lfs: Lfs::OFF,
            lfs_rules: Default::default(),
            exec: None,
        })
    }

    /// The same repository under these LFS settings: files above the threshold are committed as
    /// pointers (enabled), or not versioned at all (disabled; a file already in LFS stays there
    /// either way). The settings are the caller's, never read here.
    pub fn with_lfs(mut self, lfs: Lfs) -> Repo {
        self.lfs = lfs;
        self
    }

    /// The same repository whose git children (signing) run through `exec`: the sync passes its
    /// scope's runner, tests a temporary `HOME`.
    pub fn with_exec(mut self, exec: Exec) -> Repo {
        self.exec = Some(exec);
        self
    }

    /// Where a git child runs: the runner given, else one with no scope; none in a test that
    /// isolated the repository from the user's configuration (as for [`Repo::identities`]).
    fn git_exec(&self) -> Option<Exec> {
        if let Some(exec) = &self.exec {
            return Some(exec.clone());
        }
        #[cfg(test)]
        if let Some(exec) = TEST_EXEC.with(|e| e.borrow().clone()) {
            return Some(exec);
        }
        #[cfg(test)]
        if ISOLATED.with(|i| i.get()) {
            return None;
        }
        Some(Exec::new(crate::features::scope::Spawner::detached()))
    }

    /// The runner commits are signed through, `None` when git's configuration does not say commits
    /// are signed (or git is absent): the gix path is unchanged then.
    fn signer(&self) -> Option<Exec> {
        self.git_exec()
            .filter(|exec| signing::enabled(exec, &self.root))
    }

    /// What git says about signing here, and whether recent commits are signed.
    pub fn signing(&self) -> Signing {
        let Some(exec) = self.git_exec() else {
            return Signing::default();
        };
        Signing {
            on: signing::enabled(&exec, &self.root),
            key: signing::key_resolves(&exec, &self.root),
            signed_history: self.signed_among_recent(SIGNED_LOOKBACK),
        }
    }

    /// Whether any of the last `n` commits on HEAD's first-parent line carries a signature.
    fn signed_among_recent(&self, n: usize) -> bool {
        let Ok(head) = self.repo.head_id() else {
            return false;
        };
        let mut id = head.detach();
        for _ in 0..n {
            let Ok(commit) = self.repo.find_commit(id) else {
                return false;
            };
            let Ok(decoded) = commit.decode() else {
                return false;
            };
            if decoded
                .extra_headers
                .iter()
                .any(|(k, _)| *k == "gpgsig" || *k == "gpgsig-sha256")
            {
                return true;
            }
            let next = decoded.parents().next();
            match next {
                Some(parent) => id = parent,
                None => return false,
            }
        }
        false
    }

    /// The repository's common git directory (`.git`, or the main repository's for a linked
    /// worktree): where `lfs/` lives.
    pub fn common_dir(&self) -> &Path {
        self.repo.common_dir()
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
        self.identities_from(super::system::identities(&self.root))
    }

    /// [`Repo::identities`] asking through `exec` (tests put a fake `git` first on its path).
    #[cfg(test)]
    pub(crate) fn identities_using(&self, exec: &super::transport::Exec) -> Result<Identities> {
        self.identities_from(super::system::identities_with(exec, &self.root))
    }

    fn identities_from(
        &self,
        asked: std::result::Result<Option<(Identity, Identity)>, String>,
    ) -> Result<Identities> {
        match asked {
            Ok(Some((author, committer))) => Ok(Identities { author, committer }),
            Ok(None) => self.identities_via_gix(),
            Err(_) => Err(Error::NoIdentity),
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

    /// Is this blob an LFS pointer? Only a small blob is read.
    fn pointer_in(&self, id: gix::ObjectId) -> Option<Pointer> {
        let header = self.repo.find_header(id).ok()?;
        if header.size() > 1024 {
            return None;
        }
        Pointer::parse(&self.repo.find_object(id).ok()?.data)
    }

    /// Does any `.gitattributes` name the LFS filter at all? (The root file, nested ones in the
    /// index, `info/attributes`.) Cheap, and what keeps a vault without LFS from building an
    /// attribute stack.
    fn lfs_attributes_present(&self) -> bool {
        if let Some(known) = self.lfs_rules.get() {
            return known;
        }
        let names = |t: &str| t.contains("filter=lfs");
        let read = |p: PathBuf| std::fs::read_to_string(p).is_ok_and(|t| names(&t));
        let mut found = read(self.root.join(".gitattributes"))
            || read(self.common_dir().join("info").join("attributes"));
        if !found {
            if let Ok(index) = self.repo.index_or_empty() {
                found = index.entries().iter().any(|e| {
                    let path = e.path(&index);
                    path.ends_with(b".gitattributes") && read(self.root.join(rel_of(path)))
                });
            }
        }
        self.lfs_rules.set(Some(found));
        found
    }

    /// The attribute rules, only when some `.gitattributes` names the LFS filter.
    fn lfs_rules(&self) -> Result<Option<Rules<'_>>> {
        if !self.lfs_attributes_present() {
            return Ok(None);
        }
        self.attribute_rules().map(Some)
    }

    /// The attribute rules of every `.gitattributes` git reads (one stack, shared by the LFS
    /// checks and the baseline's conversion check).
    fn attribute_rules(&self) -> Result<Rules<'_>> {
        let index = self.repo.index_or_empty().map_err(git)?;
        let stack = self
            .repo
            .attributes_only(
                &index,
                gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
            )
            .map_err(git)?;
        Ok(Rules { stack })
    }

    /// Does the file at `rel` go into a commit as an LFS pointer, and does the managed block need
    /// a line for it? In order: a file on disk that is itself a pointer (never downloaded) is
    /// committed as it is; a file whose version in `head` is a pointer stays in LFS (whatever the
    /// setting: LFS off never rewrites what is there, and a moved file takes its source's
    /// version as `head`); a file an attribute rule covers (the user's own `*.psd filter=lfs`, or
    /// Writer's block) is a pointer whatever its size, so git's own clean filter agrees; any
    /// other file is one when LFS is enabled and it is above the threshold (and the block gets
    /// its line).
    fn via(
        &self,
        rules: &mut Option<Rules<'_>>,
        rel: &str,
        path: &Path,
        size: u64,
        head: Option<gix::ObjectId>,
    ) -> Via {
        if lfs::file_is_pointer(path) {
            return Via::Plain;
        }
        let covered = |rules: &mut Option<Rules<'_>>| rules.as_mut().is_some_and(|r| r.covers(rel));
        if head.is_some_and(|h| self.pointer_in(h).is_some()) {
            return Via::Pointer {
                needs_line: !covered(rules),
            };
        }
        if covered(rules) {
            return Via::Pointer { needs_line: false };
        }
        if self.lfs.enabled && size > self.lfs.threshold {
            return Via::Pointer { needs_line: true };
        }
        Via::Plain
    }

    /// A file Writer does not version: above the threshold while LFS is off, with no pointer in
    /// HEAD and no rule that sends it to LFS.
    fn too_large(
        &self,
        rules: &mut Option<Rules<'_>>,
        rel: &str,
        size: u64,
        head: Option<gix::ObjectId>,
    ) -> bool {
        size > self.lfs.threshold
            && !self.lfs.enabled
            && !head.is_some_and(|h| self.pointer_in(h).is_some())
            && !rules.as_mut().is_some_and(|r| r.covers(rel))
    }

    fn raw_id(&self, path: &Path) -> Option<gix::ObjectId> {
        let bytes = std::fs::read(path).ok()?;
        gix::objs::compute_hash(self.repo.object_hash(), gix::object::Kind::Blob, &bytes).ok()
    }

    /// Does the file on disk differ from HEAD's version `head`? An LFS file is compared with its
    /// pointer, size first: only a file of the same size is hashed.
    fn differs(
        &self,
        rules: &mut Option<Rules<'_>>,
        rel: &str,
        path: &Path,
        size: u64,
        head: gix::ObjectId,
    ) -> bool {
        match self.via(rules, rel, path, size, Some(head)) {
            Via::Plain => self.raw_id(path) != Some(head),
            Via::Pointer { .. } => match self.pointer_in(head) {
                Some(p) => p.size != size || lfs::pointer_of_file(path).ok().as_ref() != Some(&p),
                None => true,
            },
        }
    }

    /// The pointer HEAD holds for `rel`, if its version there is an LFS pointer.
    pub fn head_pointer(&self, rel: &str) -> Option<Pointer> {
        let id = self.head_blob(self.head_tree().as_ref(), rel)?;
        self.pointer_in(id)
    }

    /// The size of a blob, from its header (nothing is read).
    pub fn blob_size(&self, id: &str) -> Option<u64> {
        let id = gix::ObjectId::from_hex(id.as_bytes()).ok()?;
        Some(self.repo.find_header(id).ok()?.size())
    }

    /// Would Writer version a file of this size at `rel`? `false` for one over the threshold
    /// while LFS is off that no pointer in HEAD and no LFS rule covers (it is "Not versioned").
    pub fn can_version(&self, rel: &str, size: u64) -> bool {
        let mut rules = self.lfs_rules().ok().flatten();
        let head = self.head_blob(self.head_tree().as_ref(), rel);
        !self.too_large(&mut rules, rel, size, head)
    }

    /// The pointer a blob holds, `None` when it is not a pointer file.
    pub fn pointer_of_blob(&self, id: &str) -> Option<Pointer> {
        self.pointer_in(gix::ObjectId::from_hex(id.as_bytes()).ok()?)
    }

    /// Files Writer's managed `.gitattributes` block tracks whose version in HEAD is a pointer:
    /// what the panel counts as "in LFS".
    pub fn lfs_files(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.root.join(".gitattributes")).unwrap_or_default();
        lfs::tracked(&text)
            .into_iter()
            .filter(|rel| self.head_pointer(rel).is_some())
            .collect()
    }

    /// The vault's changes against HEAD, files only: what the worktree and the index differ in,
    /// classified by comparing the file with HEAD's version. A delete and an add of the same
    /// content are one move. Sorted by path. Untracked files count unless ignored.
    pub fn changes(&self) -> Result<Vec<Change>> {
        Ok(self.changes_and_skipped()?.0)
    }

    /// [`Repo::changes`], plus the files Writer does not version: over the LFS threshold while LFS
    /// is off (a file in LFS, or one an LFS rule covers, is versioned regardless), anywhere under
    /// a `node_modules` folder, or inside a nested repository (a folder with a `.git` of its own
    /// is that repository's, never walked into). The skipped large files are listed
    /// (vault-relative) so the panel can say so.
    pub fn changes_and_skipped(&self) -> Result<(Vec<Change>, Vec<String>)> {
        let scan = self.scan(None)?;
        Ok((scan.changes, scan.too_large))
    }

    /// [`Repo::changes_and_skipped`] against commit `head` (HEAD when `None`: one id read once by
    /// a caller that needs the commit and the status to agree), with the other things a caller
    /// that wants to know what is *not* different has to know about.
    fn scan(&self, head: Option<&str>) -> Result<Scan> {
        let mut rules = self.lfs_rules()?;
        let head_commit = head.map(|h| self.find(h)).transpose()?;
        let mut pointers: Vec<String> = Vec::new();
        // Files an LFS rule covers are kept out of gix's status: it would run the repository's
        // `filter.lfs` driver (a `git-lfs` child gix starts itself, outside the feature's scope)
        // to compare them. They are compared here instead, against their pointer.
        let mut in_lfs: Vec<(String, gix::index::entry::Stat)> = Vec::new();
        if let Some(r) = rules.as_mut() {
            let index = self.repo.index_or_empty().map_err(git)?;
            for entry in index.entries() {
                if !matches!(
                    entry.mode,
                    gix::index::entry::Mode::FILE | gix::index::entry::Mode::FILE_EXECUTABLE
                ) {
                    continue;
                }
                let rel = rel_of(entry.path(&index));
                if r.covers(&rel) {
                    if lfs::file_is_pointer(&self.root.join(&rel)) {
                        pointers.push(rel.clone());
                    }
                    in_lfs.push((rel, entry.stat));
                }
            }
        }
        // `top`: the paths are the vault's, whatever directory the process is in
        let skip_in_gix: Vec<BString> = in_lfs
            .iter()
            .map(|(rel, _)| BString::from(format!(":(top,literal,exclude){rel}")))
            .collect();
        let mut platform = self.repo.status(gix::progress::Discard).map_err(git)?;
        if let Some(commit) = &head_commit {
            platform = platform.head_tree(commit.tree_id().map_err(git)?.detach());
        }
        let items = platform
            .untracked_files(gix::status::UntrackedFiles::Files)
            .index_worktree_rewrites(None)
            .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
            .into_iter(skip_in_gix)
            .map_err(git)?;
        let mut candidates = BTreeSet::new();
        for item in items {
            let item = item.map_err(git)?;
            candidates.insert(rel_of(item.location()));
        }
        for (rel, stat) in &in_lfs {
            let fresh = gix::index::fs::Metadata::from_path_no_follow(&self.root.join(rel))
                .ok()
                .and_then(|m| gix::index::entry::Stat::from_fs(&m).ok())
                .is_some_and(|now| now.size == stat.size && now.mtime == stat.mtime);
            if !fresh {
                candidates.insert(rel.clone());
            }
        }
        let tree = match &head_commit {
            Some(c) => c.tree().ok(),
            None => self.head_tree(),
        };
        let mut non_files: Vec<String> = Vec::new();
        // (path, size) of files not in HEAD; (path, HEAD blob) of files gone from disk
        let mut adds: Vec<(String, u64)> = Vec::new();
        let mut deletes: Vec<(String, gix::ObjectId)> = Vec::new();
        let mut out: Vec<Change> = Vec::new();
        let mut too_large: Vec<String> = Vec::new();
        for rel in candidates {
            if self.not_ours(&rel) {
                continue;
            }
            let head = self.head_blob(tree.as_ref(), &rel);
            let path = self.root.join(&rel);
            let meta = std::fs::symlink_metadata(&path)
                .ok()
                .filter(|m| m.is_file());
            if meta.is_none() && std::fs::symlink_metadata(&path).is_ok() && !path.is_dir() {
                non_files.push(rel.clone());
            }
            match (head, meta) {
                (Some(h), Some(m)) => {
                    if self.too_large(&mut rules, &rel, m.len(), head) {
                        too_large.push(rel);
                    } else if self.differs(&mut rules, &rel, &path, m.len(), h) {
                        out.push(Change::Edit(rel));
                    }
                }
                (None, Some(m)) => adds.push((rel, m.len())),
                (Some(h), None) if !path.is_dir() => deletes.push((rel, h)),
                _ => {}
            }
        }
        // A delete and an add of the same content are one move, settled before the size limit
        // is asked: a file in LFS that was renamed stays in LFS whatever the setting. Cheap
        // first: an add is compared only with deletes of its own size (a pointer's, or the
        // blob's from its header), and read only then.
        for (to, size) in adds {
            let path = self.root.join(&to);
            let same = deletes.iter().position(|(_, h)| {
                let ptr = self.pointer_in(*h);
                let theirs = match &ptr {
                    Some(p) => Some(p.size),
                    None => self.repo.find_header(*h).ok().map(|x| x.size()),
                };
                theirs == Some(size)
                    && match &ptr {
                        Some(p) => lfs::pointer_of_file(&path).ok().as_ref() == Some(p),
                        None => self.raw_id(&path) == Some(*h),
                    }
            });
            match same {
                Some(i) => {
                    let (from, _) = deletes.remove(i);
                    out.push(Change::Move { from, to });
                }
                None if self.too_large(&mut rules, &to, size, None) => too_large.push(to),
                None => out.push(Change::Add(to)),
            }
        }
        out.extend(deletes.into_iter().map(|(rel, _)| Change::Delete(rel)));
        out.sort_by(|a, b| a.path().cmp(b.path()));
        Ok(Scan {
            changes: out,
            too_large,
            non_files,
            pointers,
        })
    }

    /// Every path the working tree differs from commit `head` in, or that Writer does not version
    /// or cannot compare: what [`Repo::scan`] finds (changes, a move's old path, files over the
    /// size limit), the entries on disk that are not regular files (a symlink hides what it points
    /// at), LFS files that are still pointers on disk, and the index entries git is told not to
    /// look at (skip-worktree, assume-unchanged). Vault-relative. After a commit it is what the
    /// commit could not take; a path outside it is, as far as git's own comparison goes, what
    /// `head` holds.
    pub fn uncommitted_at(&self, head: &str) -> Result<BTreeSet<String>> {
        let scan = self.scan(Some(head))?;
        let mut out: BTreeSet<String> = scan.too_large.into_iter().collect();
        out.extend(scan.non_files);
        out.extend(scan.pointers);
        for c in &scan.changes {
            out.insert(c.path().to_string());
            if let Change::Move { from, .. } = c {
                out.insert(from.clone());
            }
        }
        let index = self.repo.index_or_empty().map_err(git)?;
        for entry in index.entries() {
            if entry.flags.intersects(
                gix::index::entry::Flags::SKIP_WORKTREE | gix::index::entry::Flags::ASSUME_VALID,
            ) {
                out.insert(rel_of(entry.path(&index)));
            }
        }
        Ok(out)
    }

    /// What the history can say about each of `paths` as commit `rev` holds them, for a reader
    /// capped at `max_bytes` (see [`BaselineAt`]); the answer is positional. The attribute and
    /// ignore rules are built once for the batch. A conversion git applies between the blob and the
    /// file (line endings, `ident`, an encoding, a filter other than LFS) makes the blob not the
    /// bytes that were on disk: such a path gets [`BaselineAt::Unknown`], and every path does while
    /// `core.autocrlf` is on.
    pub fn baselines_at(&self, rev: &str, paths: &[&str], max_bytes: u64) -> Vec<BaselineAt> {
        let unknown = || vec![BaselineAt::Unknown; paths.len()];
        let Ok(commit) = self.find(rev) else {
            return unknown();
        };
        let autocrlf = self
            .config_string("core.autocrlf")
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "input"));
        if autocrlf {
            return unknown();
        }
        let Ok(mut rules) = self.attribute_rules() else {
            return unknown();
        };
        // built when the first missing path needs it
        let mut excludes: Option<Option<gix::AttributeStack<'_>>> = None;
        paths
            .iter()
            .map(|rel| {
                if self.not_ours(rel) || rules.converts(rel) {
                    return BaselineAt::Unknown;
                }
                self.baseline_of(&commit, rel, max_bytes, &mut excludes)
            })
            .collect()
    }

    fn baseline_of<'r>(
        &'r self,
        commit: &gix::Commit<'_>,
        rel: &str,
        max_bytes: u64,
        excludes: &mut Option<Option<gix::AttributeStack<'r>>>,
    ) -> BaselineAt {
        let Ok(tree) = commit.tree() else {
            return BaselineAt::Unknown;
        };
        let Ok(entry) = tree.lookup_entry_by_path(rel) else {
            return BaselineAt::Unknown;
        };
        let Some(entry) = entry else {
            // not there under this exact name: a name that differs only by case or Unicode
            // normalization is the same file on a case-insensitive or normalizing file system
            if self.has_name_variant(&tree, rel) {
                return BaselineAt::Unknown;
            }
            let stack = excludes.get_or_insert_with(|| self.excludes_stack());
            return match stack.as_mut() {
                Some(stack) => {
                    if ignored(stack, rel) {
                        BaselineAt::Unknown
                    } else {
                        BaselineAt::Absent
                    }
                }
                None => BaselineAt::Unknown,
            };
        };
        if !entry.mode().is_blob() {
            return BaselineAt::Unknown;
        }
        let id = entry.object_id();
        let Ok(header) = self.repo.find_header(id) else {
            return BaselineAt::Unknown;
        };
        let bytes = match self.pointer_in(id) {
            Some(p) if p.size > max_bytes => return BaselineAt::Unknown,
            Some(_) => self.content(&id.to_string()),
            None if header.size() > max_bytes => return BaselineAt::Unknown,
            None => self.blob(&id.to_string()),
        };
        match bytes {
            // an LFS object that is not here stays a pointer: not the file's content
            Ok(bytes) if bytes.len() as u64 <= max_bytes && !lfs::is_pointer(&bytes) => {
                BaselineAt::Bytes(bytes)
            }
            _ => BaselineAt::Unknown,
        }
    }

    /// Does a folder along `rel` hold a name that is not `rel`'s but folds to it (case,
    /// NFC/NFD), at the first component the tree lacks exactly? Anything unreadable says yes.
    fn has_name_variant(&self, tree: &gix::Tree<'_>, rel: &str) -> bool {
        let mut tree = tree.clone();
        let parts: Vec<&str> = rel.split('/').collect();
        for (i, part) in parts.iter().enumerate() {
            let mut exact = None;
            let mut folded = false;
            for entry in tree.iter() {
                let Ok(entry) = entry else { return true };
                let name = entry.filename().to_str_lossy();
                if name == *part {
                    exact = Some((entry.mode(), entry.oid().to_owned()));
                    break;
                }
                folded |= fold_name(&name) == fold_name(part);
            }
            match exact {
                None => return folded,
                Some(_) if i + 1 == parts.len() => return false,
                Some((mode, id)) if mode.is_tree() => match self.repo.find_tree(id) {
                    Ok(next) => tree = next,
                    Err(_) => return true,
                },
                Some(_) => return true,
            }
        }
        false
    }

    /// The ignore rules (the vault's `.gitignore` files, `info/exclude`, the user's global file).
    fn excludes_stack(&self) -> Option<gix::AttributeStack<'_>> {
        let index = self.repo.index_or_empty().ok()?;
        self.repo
            .excludes(
                &index,
                None,
                gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
            )
            .ok()
    }

    /// Under `node_modules`, or inside a folder that is a repository of its own: Writer never
    /// versions it, so a commit says nothing about it.
    pub(crate) fn not_ours(&self, rel: &str) -> bool {
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
        // a sync that moved the branch and was interrupted is finished first (`sync::recover`):
        // committing now would record the files it had not written yet at their old version
        if super::sync::interrupted(&self.root) {
            return Err(Error::Operation(super::sync::INTERRUPTED.into()));
        }
        let ids = self.identities()?;
        // asked before anything is written: signing on and git unable to sign makes no commit
        let signer = self.signer();
        let repo = &self.repo;
        let now = gix::date::Time::now_local_or_utc();
        let sig_of = |who: &Identity| Sig {
            name: who.name.clone(),
            email: who.email.clone(),
            seconds: now.seconds,
            offset: now.offset,
        };
        let signature = |who: &Identity| gix::actor::Signature {
            name: who.name.as_str().into(),
            email: who.email.as_str().into(),
            time: now,
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
        let mut rules = self.lfs_rules()?;
        // files that go into LFS and no rule covers yet: the managed block gets a line each
        let mut lines: BTreeSet<String> = BTreeSet::new();
        for change in changes {
            let (rel, from) = match change {
                Change::Delete(rel) => {
                    editor.remove(rel.as_str()).map_err(git)?;
                    drop_from_index(rel, index);
                    continue;
                }
                Change::Move { from, to } => {
                    editor.remove(from.as_str()).map_err(git)?;
                    drop_from_index(from, index);
                    (to, Some(from.as_str()))
                }
                Change::Add(rel) | Change::Edit(rel) => (rel, None),
            };
            if self.stage(&mut rules, &mut editor, index, rel, from)?
                == (Via::Pointer { needs_line: true })
            {
                lines.insert(rel.clone());
            }
        }
        if !lines.is_empty() {
            let included = changes.iter().any(|c| c.path() == ".gitattributes");
            self.track_in_attributes(&mut editor, index, &lines, included)?;
        }
        index.sort_entries();
        let tree = editor.write().map_err(git)?;
        let id = match signer {
            // git writes the signed commit object; the branch then moves only if nobody moved it
            Some(exec) => {
                let parents: Vec<String> = parent.iter().map(|p| p.to_string()).collect();
                let id = signing::commit_tree(
                    &exec,
                    &self.root,
                    &tree.to_string(),
                    &parents,
                    message.render().as_bytes(),
                    &sig_of(&ids.author),
                    &sig_of(&ids.committer),
                )
                .map_err(|e| Error::Signing { details: e.details })?;
                self.move_head_as(&id, parents.first().map(String::as_str), "commit")?;
                id
            }
            None => repo
                .commit_as(
                    committer.to_ref(&mut committer_time),
                    author.to_ref(&mut author_time),
                    "HEAD",
                    message.render(),
                    tree.detach(),
                    parent,
                )
                .map_err(git)?
                .to_string(),
        };
        index_file
            .write(gix::index::write::Options::default())
            .map_err(git)?;
        Ok(id)
    }

    /// Writes the managed `.gitattributes` block so it tracks `lines` besides what it tracked, and
    /// stages the change in the same commit. A line stays while its file exists or its pointer
    /// is still in HEAD. The committed file is the version in this commit (HEAD's, or the
    /// user's own edit when `included`) plus the block change only: other edits to the file on
    /// disk stay pending.
    fn track_in_attributes(
        &self,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        lines: &BTreeSet<String>,
        included: bool,
    ) -> Result<()> {
        let file = self.root.join(".gitattributes");
        let on_disk = match std::fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let committed = if included {
            on_disk.clone()
        } else {
            self.head_blob(self.head_tree().as_ref(), ".gitattributes")
                .and_then(|id| self.blob(&id.to_string()).ok())
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
        };
        let mut paths = lfs::tracked(&committed);
        paths.extend(lines.iter().cloned());
        paths.retain(|p| {
            std::fs::symlink_metadata(self.root.join(p)).is_ok() || self.head_pointer(p).is_some()
        });
        let for_commit = lfs::apply(&committed, &paths);
        let for_disk = lfs::apply(&on_disk, &paths);
        if for_disk != on_disk {
            // the one confined, atomic write the app has
            let root = self.root.canonicalize()?;
            let confined = crate::vault_ops::confine(&root, ".gitattributes")
                .map_err(|e| Error::Git(e.to_string()))?;
            crate::vault_ops::write_bytes(&confined.abs, for_disk.as_bytes())
                .map_err(|e| Error::Git(e.to_string()))?;
        }
        self.lfs_rules.set(None);
        let id = self
            .repo
            .write_blob(for_commit.as_bytes())
            .map_err(git)?
            .detach();
        if for_commit == for_disk {
            let meta = gix::index::fs::Metadata::from_path_no_follow(&file)?;
            self.push_entry(editor, index, ".gitattributes", id, &file, &meta)
        } else {
            // the file on disk holds more than the commit: the index entry is left stale on
            // purpose, so the next status finds the rest pending
            self.push_entry_with(
                editor,
                index,
                ".gitattributes",
                id,
                false,
                Default::default(),
            )
        }
    }

    fn stage(
        &self,
        rules: &mut Option<Rules<'_>>,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        rel: &str,
        from: Option<&str>,
    ) -> Result<Via> {
        let path = self.root.join(rel);
        let size = std::fs::symlink_metadata(&path).map_or(0, |m| m.len());
        let tree = self.head_tree();
        let head = self.head_blob(tree.as_ref(), from.unwrap_or(rel));
        let via = self.via(rules, rel, &path, size, head);
        if via == Via::Plain {
            self.stage_plain(editor, index, rel)?;
            return Ok(via);
        }
        // stat first, then the bytes go to the store: the same order as a plain file's
        let meta = gix::index::fs::Metadata::from_path_no_follow(&path)?;
        let pointer = lfs::store_file(self.common_dir(), &path)?;
        let id = self
            .repo
            .write_blob(pointer.text().as_bytes())
            .map_err(git)?
            .detach();
        self.push_entry(editor, index, rel, id, &path, &meta)?;
        Ok(via)
    }

    fn stage_plain(
        &self,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        rel: &str,
    ) -> Result<()> {
        let path = self.root.join(rel);
        let (bytes, meta) = read_after_stat(&path, || {})?;
        let id = self.repo.write_blob(&bytes).map_err(git)?.detach();
        self.push_entry(editor, index, rel, id, &path, &meta)
    }

    fn push_entry(
        &self,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        rel: &str,
        id: gix::ObjectId,
        path: &Path,
        meta: &gix::index::fs::Metadata,
    ) -> Result<()> {
        let stat = gix::index::entry::Stat::from_fs(meta).map_err(git)?;
        self.push_entry_with(editor, index, rel, id, is_executable(path), stat)
    }

    fn push_entry_with(
        &self,
        editor: &mut gix::object::tree::Editor<'_>,
        index: &mut gix::index::State,
        rel: &str,
        id: gix::ObjectId,
        executable: bool,
        stat: gix::index::entry::Stat,
    ) -> Result<()> {
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

    /// A blob as its reader wants it: an LFS pointer whose object is in the local store is the
    /// object (history, diffs and Restore show the real file); a pointer not fetched stays a
    /// pointer (see [`lfs::is_pointer`]). Sync and merge read [`Repo::blob`], the raw bytes.
    pub fn content(&self, id: &str) -> Result<Vec<u8>> {
        Ok(lfs::resolve(self.common_dir(), self.blob(id)?))
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

// ---- what a sync needs ----------------------------------------------------------------------

/// An author or committer with the time as git stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sig {
    pub name: String,
    pub email: String,
    pub seconds: i64,
    /// Seconds east of UTC.
    pub offset: i32,
}

/// A commit as the replay copies it: message bytes and both signatures exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitData {
    pub id: String,
    pub parents: Vec<String>,
    pub author: Sig,
    pub committer: Sig,
    pub message: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Blob,
    Exec,
    Link,
}

/// A file (or link) of a tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub mode: Mode,
}

/// What differs at one path between two commits' trees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeChange {
    pub path: String,
    pub before: Option<Entry>,
    pub after: Option<Entry>,
}

pub enum TreeEdit {
    Upsert { path: String, entry: Entry },
    Remove { path: String },
}

fn sig_of(sig: gix::actor::SignatureRef<'_>) -> Result<Sig> {
    let time = sig.time().map_err(git)?;
    Ok(Sig {
        name: sig.name.to_str_lossy().into_owned(),
        email: sig.email.to_str_lossy().into_owned(),
        seconds: time.seconds,
        offset: time.offset,
    })
}

fn entry_of(mode: gix::object::tree::EntryMode, id: gix::ObjectId) -> Option<Entry> {
    use gix::object::tree::EntryKind;
    let mode = match mode.kind() {
        EntryKind::Blob => Mode::Blob,
        EntryKind::BlobExecutable => Mode::Exec,
        EntryKind::Link => Mode::Link,
        EntryKind::Tree | EntryKind::Commit => return None,
    };
    Some(Entry {
        id: id.to_string(),
        mode,
    })
}

impl Repo {
    /// The short name of the branch HEAD is on (an unborn branch included), `None` when detached.
    pub fn head_branch(&self) -> Option<String> {
        let name = self.repo.head_name().ok()??;
        Some(name.shorten().to_str_lossy().into_owned())
    }

    /// A config value of the repository (`remote.origin.url`).
    pub fn config_string(&self, key: &str) -> Option<String> {
        let value = self.repo.config_snapshot().string(key)?;
        Some(value.to_str_lossy().into_owned())
    }

    /// The commit a reference points at (`refs/remotes/origin/main`).
    pub fn ref_id(&self, name: &str) -> Option<String> {
        let reference = self.repo.try_find_reference(name).ok()??;
        Some(reference.id().to_string())
    }

    pub fn commit_data(&self, rev: &str) -> Result<CommitData> {
        let commit = self.find(rev)?;
        Ok(CommitData {
            id: commit.id.to_string(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            author: sig_of(commit.author().map_err(git)?)?,
            committer: sig_of(commit.committer().map_err(git)?)?,
            message: commit.message_raw_sloppy().to_vec(),
        })
    }

    /// The commits reachable from `tip` and not from `hide`, newest first along the first-parent
    /// chain from `tip`; and whether any of them is a merge commit.
    pub fn first_parent_not_in(
        &self,
        tip: &str,
        hide: Option<&str>,
    ) -> Result<(Vec<String>, bool)> {
        let tip_id = gix::ObjectId::from_hex(tip.as_bytes()).map_err(git)?;
        let mut platform = self.repo.rev_walk([tip_id]);
        if let Some(h) = hide {
            platform = platform.with_hidden([gix::ObjectId::from_hex(h.as_bytes()).map_err(git)?]);
        }
        let mut set = BTreeSet::new();
        let mut merge = false;
        for info in platform.all().map_err(git)? {
            let info = info.map_err(git)?;
            merge |= info.parent_ids.len() > 1;
            set.insert(info.id.to_string());
        }
        let mut chain = Vec::new();
        let mut cur = Some(tip.to_string());
        while let Some(id) = cur.filter(|id| set.contains(id)) {
            cur = self.parent_of(&id)?;
            chain.push(id);
        }
        Ok((chain, merge))
    }

    /// `(ahead, behind)` of `head` against `remote`.
    pub fn ahead_behind(&self, head: &str, remote: &str) -> Result<(usize, usize)> {
        let count = |tip: &str, hide: &str| -> Result<usize> {
            let tip = gix::ObjectId::from_hex(tip.as_bytes()).map_err(git)?;
            let hide = gix::ObjectId::from_hex(hide.as_bytes()).map_err(git)?;
            let walk = self
                .repo
                .rev_walk([tip])
                .with_hidden([hide])
                .all()
                .map_err(git)?;
            let mut n = 0;
            for info in walk {
                info.map_err(git)?;
                n += 1;
            }
            Ok(n)
        };
        Ok((count(head, remote)?, count(remote, head)?))
    }

    fn tree_of(&self, commit: Option<&str>) -> Result<gix::Tree<'_>> {
        match commit {
            Some(c) => self.find(c)?.tree().map_err(git),
            None => Ok(self.repo.empty_tree()),
        }
    }

    /// The files that differ between two commits (`None`: the empty tree), no rename detection.
    pub fn tree_changes(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<TreeChange>> {
        let (old, new) = (self.tree_of(from)?, self.tree_of(to)?);
        let changes = self
            .repo
            .diff_tree_to_tree(&old, &new, Some(gix::diff::Options::default()))
            .map_err(git)?;
        let mut out = Vec::new();
        for c in changes {
            use gix::object::tree::diff::ChangeDetached as C;
            let (path, before, after) = match c {
                C::Addition {
                    location,
                    entry_mode,
                    id,
                    ..
                } => (location, None, entry_of(entry_mode, id)),
                C::Deletion {
                    location,
                    entry_mode,
                    id,
                    ..
                } => (location, entry_of(entry_mode, id), None),
                C::Modification {
                    location,
                    previous_entry_mode,
                    previous_id,
                    entry_mode,
                    id,
                } => (
                    location,
                    entry_of(previous_entry_mode, previous_id),
                    entry_of(entry_mode, id),
                ),
                C::Rewrite { .. } => continue,
            };
            if before.is_none() && after.is_none() {
                continue;
            }
            out.push(TreeChange {
                path: rel_of(path.as_ref()),
                before,
                after,
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// The file at `path` in a commit (`None`: the empty tree).
    pub fn entry_at(&self, commit: Option<&str>, path: &str) -> Result<Option<Entry>> {
        let tree = self.tree_of(commit)?;
        Ok(tree
            .lookup_entry_by_path(path)
            .map_err(git)?
            .and_then(|e| entry_of(e.mode(), e.object_id())))
    }

    pub fn write_blob(&self, bytes: &[u8]) -> Result<String> {
        Ok(self.repo.write_blob(bytes).map_err(git)?.to_string())
    }

    /// A tree: the one of `base` (`None`: empty) with `edits` applied. Returns its id.
    pub fn write_tree(&self, base: Option<&str>, edits: &[TreeEdit]) -> Result<String> {
        use gix::object::tree::EntryKind;
        let tree = self.tree_of(base)?;
        let mut editor = self.repo.edit_tree(tree.id).map_err(git)?;
        for e in edits {
            match e {
                TreeEdit::Remove { path } => {
                    editor.remove(path.as_str()).map_err(git)?;
                }
                TreeEdit::Upsert { path, entry } => {
                    let id = gix::ObjectId::from_hex(entry.id.as_bytes()).map_err(git)?;
                    let kind = match entry.mode {
                        Mode::Blob => EntryKind::Blob,
                        Mode::Exec => EntryKind::BlobExecutable,
                        Mode::Link => EntryKind::Link,
                    };
                    editor.upsert(path.as_str(), kind, id).map_err(git)?;
                }
            }
        }
        Ok(editor.write().map_err(git)?.to_string())
    }

    /// A commit object (no reference moves): the replay's copy of a local commit.
    pub fn write_commit(
        &self,
        tree: &str,
        parents: &[String],
        message: &[u8],
        author: &Sig,
        committer: &Sig,
    ) -> Result<String> {
        if let Some(exec) = self.signer() {
            // the replayed copy is signed again, as configured: its old signature does not hold
            // for a commit with another parent and tree
            return signing::commit_tree(
                &exec, &self.root, tree, parents, message, author, committer,
            )
            .map_err(|e| Error::Signing { details: e.details });
        }
        let sig = |s: &Sig| gix::actor::Signature {
            name: s.name.as_str().into(),
            email: s.email.as_str().into(),
            time: gix::date::Time {
                seconds: s.seconds,
                offset: s.offset,
            },
        };
        let commit = gix::objs::Commit {
            tree: gix::ObjectId::from_hex(tree.as_bytes()).map_err(git)?,
            parents: parents
                .iter()
                .map(|p| gix::ObjectId::from_hex(p.as_bytes()).map_err(git))
                .collect::<Result<_>>()?,
            author: sig(author),
            committer: sig(committer),
            encoding: None,
            message: message.into(),
            extra_headers: Vec::new(),
        };
        Ok(self.repo.write_object(&commit).map_err(git)?.to_string())
    }

    /// Moves the branch HEAD is on to `new` when it is still at `old` (`None`: not born yet).
    pub fn move_head(&self, new: &str, old: Option<&str>) -> Result<()> {
        self.move_head_as(new, old, "sync")
    }

    /// [`Repo::move_head`] with the reflog's reason (`writer: <what>`).
    fn move_head_as(&self, new: &str, old: Option<&str>, what: &str) -> Result<()> {
        use gix::refs::transaction::PreviousValue;
        let name = self
            .repo
            .head_name()
            .map_err(git)?
            .ok_or_else(|| Error::Operation("detached HEAD".into()))?;
        let new = gix::ObjectId::from_hex(new.as_bytes()).map_err(git)?;
        let constraint = match old {
            Some(o) => PreviousValue::MustExistAndMatch(gix::refs::Target::Object(
                gix::ObjectId::from_hex(o.as_bytes()).map_err(git)?,
            )),
            None => PreviousValue::MustNotExist,
        };
        self.repo
            .reference(name, new, constraint, format!("writer: {what}"))
            .map_err(git)?;
        Ok(())
    }

    /// Re-stages `paths` from the working tree (their stat data too) or drops their entries when
    /// the file is gone, so the next status sees them as unchanged.
    pub fn refresh_index(&self, paths: &[String]) -> Result<()> {
        let mut index_file: gix::index::File = (**self.repo.index_or_empty().map_err(git)?).clone();
        let index: &mut gix::index::State = &mut index_file;
        let tree = self.repo.empty_tree();
        let mut editor = self.repo.edit_tree(tree.id).map_err(git)?;
        let mut rules = self.lfs_rules()?;
        let head = self.head_tree();
        for rel in paths {
            let path = self.root.join(rel);
            let Ok(meta) = gix::index::fs::Metadata::from_path_no_follow(&path) else {
                index.remove_entries(|_, p, _| p == rel.as_bytes());
                continue;
            };
            if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
                index.remove_entries(|_, p, _| p == rel.as_bytes());
                continue;
            }
            // a large file the sync just wrote from HEAD's pointer is that pointer: no hashing
            match self.head_blob(head.as_ref(), rel) {
                Some(id) if self.pointer_in(id).is_some() && !lfs::file_is_pointer(&path) => {
                    self.push_entry(&mut editor, index, rel, id, &path, &meta)?;
                }
                _ => {
                    self.stage(&mut rules, &mut editor, index, rel, None)?;
                }
            }
        }
        index.sort_entries();
        index_file
            .write(gix::index::write::Options::default())
            .map_err(git)?;
        Ok(())
    }
}

/// The file's stat data first, its bytes second: a write that lands in between makes the stat older
/// than the bytes, so the next status finds the file changed and hashes it again, instead of
/// trusting a stat that matches content the commit never saw. `between` runs after the stat (a
/// test writes there).
pub(crate) fn read_after_stat(
    path: &Path,
    between: impl FnOnce(),
) -> io::Result<(Vec<u8>, gix::index::fs::Metadata)> {
    let meta = gix::index::fs::Metadata::from_path_no_follow(path)?;
    between();
    Ok((std::fs::read(path)?, meta))
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
