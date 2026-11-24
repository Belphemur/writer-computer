//! The one place that decides what a directory entry is when it may be a symlink (spec:
//! `SPECs/code-files-spec.md`, "Symlinks"; ADR `2026-11-17-follow-symlinks-that-stay-inside-the-vault`).
//!
//! `DirEntry::file_type()` does not follow links, so a symlink to a folder is neither a directory
//! nor a file. Every walker that lists the vault on disk (sidebar listing, the folder
//! emptiness/classification checks, the managed skills sync) asks [`resolve_entry`] instead of
//! reading the file type itself, so the rule cannot drift between them.
//!
//! The rule: a symlink is followed only when its canonical target
//! - stays inside the canonical vault root (a link leaving the vault is never followed: reading or
//!   writing through it would break path confinement, `vault_ops::confine`),
//! - is not the vault root or an ancestor of the link's own folder (a cycle),
//! - is visible by `code_files::rel_is_visible` when reached by its *real* path (a link into
//!   `.git`, `.obsidian`, an ignored folder or any hidden folder is hidden, as the target would be),
//! - exists and is a regular file or a directory (a dangling link is skipped).
//!
//! Anything else is skipped silently (debug log). The vault index and the watcher never follow
//! links: the real path is the one that gets indexed, so a folder reachable by two paths is
//! indexed once and never duplicates search results or links.
//!
//! Tauri-free.

use std::fs::FileType;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// A directory entry resolved through [`resolve_entry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEntry {
    pub kind: EntryKind,
    /// Canonical path of the entry (the link target for a followed symlink). Equal to
    /// `parent_real/name` for an ordinary entry, so it is only a syscall away for links.
    pub real: PathBuf,
    /// The entry itself is a symlink (followed, target inside the vault).
    pub symlink: bool,
}

impl ResolvedEntry {
    pub fn is_dir(&self) -> bool {
        self.kind == EntryKind::Dir
    }
    pub fn is_file(&self) -> bool {
        self.kind == EntryKind::File
    }
}

/// The canonical vault root a walker confines links to, or `None` outside a vault (then no link is
/// followed: there is nothing to confine it to). Call once per walk.
pub fn canonical_root(root: Option<&Path>) -> Option<PathBuf> {
    root.and_then(|r| r.canonicalize().ok())
}

/// Classify one entry of the directory whose canonical path is `parent_real`.
///
/// `file_type` is the entry's own type (not following links). `root_real` comes from
/// [`canonical_root`]. Returns `None` for what must not be shown or walked: a link that is
/// dangling, leaves the vault, forms a cycle or lands in a hidden location, and special files.
pub fn resolve_entry(
    path: &Path,
    file_type: FileType,
    parent_real: &Path,
    root_real: Option<&Path>,
) -> Option<ResolvedEntry> {
    if !file_type.is_symlink() {
        let kind = if file_type.is_dir() {
            EntryKind::Dir
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            return None;
        };
        return Some(ResolvedEntry {
            kind,
            real: parent_real.join(path.file_name()?),
            symlink: false,
        });
    }
    let skip = |why: &str| {
        log::debug!(
            "fs_entry: skipping symlink {}: {why}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        None
    };
    let (real, rel) = match link_target(path, parent_real, root_real) {
        LinkTarget::Inside { real, rel } => (real, rel),
        LinkTarget::NoRoot => return skip("no vault to confine it to"),
        LinkTarget::Dangling => return skip("dangling"),
        LinkTarget::Outside => return skip("target is outside the vault"),
        LinkTarget::Cycle => return skip("target is the vault root or an ancestor (cycle)"),
    };
    if !crate::code_files::rel_is_visible(&rel) {
        return skip("target is hidden by the visibility policy");
    }
    let kind = match std::fs::metadata(&real) {
        Ok(m) if m.is_dir() => EntryKind::Dir,
        Ok(m) if m.is_file() => EntryKind::File,
        _ => return skip("target is neither a file nor a folder"),
    };
    Some(ResolvedEntry {
        kind,
        real,
        symlink: true,
    })
}

/// Where a symlink points, judged against the vault: the one primitive every walker that follows
/// links builds its policy on ([`resolve_entry`] adds visibility and the file or folder kind; the
/// OpenCode config's skill check only wants to know whether a link leaves the vault).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// The canonical target, and its path below the vault root.
    Inside { real: PathBuf, rel: PathBuf },
    /// There is no vault to confine the link to.
    NoRoot,
    /// The target does not exist.
    Dangling,
    /// The target is outside the vault.
    Outside,
    /// The target is the vault root or the folder of the link, or an ancestor of it.
    Cycle,
}

/// Classifies the symlink `path` that sits in the folder whose canonical path is `parent_real`.
pub fn link_target(path: &Path, parent_real: &Path, root_real: Option<&Path>) -> LinkTarget {
    let Some(root) = root_real else {
        return LinkTarget::NoRoot;
    };
    let Ok(real) = path.canonicalize() else {
        return LinkTarget::Dangling;
    };
    let Ok(rel) = real.strip_prefix(root).map(Path::to_path_buf) else {
        return LinkTarget::Outside;
    };
    if rel.as_os_str().is_empty() || parent_real.starts_with(&real) {
        return LinkTarget::Cycle;
    }
    LinkTarget::Inside { real, rel }
}

/// [`resolve_entry`] for one path (no `read_dir` entry at hand): a fixed child such as `skills`.
pub fn resolve_path(
    path: &Path,
    parent_real: &Path,
    root_real: Option<&Path>,
) -> Option<ResolvedEntry> {
    let ft = std::fs::symlink_metadata(path).ok()?.file_type();
    resolve_entry(path, ft, parent_real, root_real)
}

/// The first component of vault-relative `rel` (starting at `root`) that is a symlink, as a
/// vault-relative path. Writers use it to refuse to install or replace anything through a link.
pub fn symlink_in_path(root: &Path, rel: &Path) -> Option<PathBuf> {
    let mut cur = root.to_path_buf();
    let mut seen = PathBuf::new();
    for c in rel.components() {
        cur.push(c);
        seen.push(c);
        if std::fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            return Some(seen);
        }
    }
    None
}

/// Where a write to `path` must land: `path` itself, or, for a symlink, its canonical target, so
/// that an atomic replace (temp file + rename) never swaps the link for a regular file. A dangling
/// link is an error. Confinement stays the caller's (`WorkspaceState::authorize_path`, which
/// resolves the same link before the command runs).
pub fn write_target(path: &Path) -> std::io::Result<PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => path.canonicalize(),
        _ => Ok(path.to_path_buf()),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn vault() -> (TempDir, PathBuf) {
        let t = TempDir::new().unwrap();
        let root = t.path().canonicalize().unwrap();
        (t, root)
    }

    fn resolve(root: &Path, rel: &str) -> Option<ResolvedEntry> {
        let path = root.join(rel);
        let parent_real = path.parent().unwrap().canonicalize().unwrap();
        resolve_path(&path, &parent_real, Some(root))
    }

    #[test]
    fn ordinary_entries_resolve_without_following_anything() {
        let (_t, root) = vault();
        fs::create_dir(root.join("d")).unwrap();
        fs::write(root.join("f.md"), "x").unwrap();
        let d = resolve(&root, "d").unwrap();
        assert!(d.is_dir() && !d.symlink && d.real == root.join("d"));
        let f = resolve(&root, "f.md").unwrap();
        assert!(f.is_file() && !f.symlink);
    }

    #[test]
    fn links_inside_the_vault_resolve_to_their_target() {
        let (_t, root) = vault();
        fs::create_dir_all(root.join("Real/skills")).unwrap();
        fs::write(root.join("Real/a.md"), "x").unwrap();
        fs::create_dir(root.join(".agents")).unwrap();
        symlink("../Real/skills", root.join(".agents/skills")).unwrap();
        symlink("Real/a.md", root.join("alias.md")).unwrap();
        let d = resolve(&root, ".agents/skills").unwrap();
        assert!(d.is_dir() && d.symlink);
        assert_eq!(d.real, root.join("Real/skills"));
        let f = resolve(&root, "alias.md").unwrap();
        assert!(f.is_file() && f.symlink && f.real == root.join("Real/a.md"));
    }

    #[test]
    fn escapes_dangling_cycles_and_hidden_targets_are_skipped() {
        let (_t, root) = vault();
        let (_o, outside) = vault();
        fs::write(outside.join("x.md"), "x").unwrap();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        symlink(&outside, root.join("out")).unwrap();
        symlink(outside.join("x.md"), root.join("out.md")).unwrap();
        symlink("nowhere", root.join("dangling")).unwrap();
        symlink("..", root.join("a/b/up")).unwrap(); // ancestor
        symlink("../a", root.join("a/b/up2")).unwrap(); // parent itself is under it
        symlink(".", root.join("self")).unwrap(); // the vault root
        symlink(".git", root.join("g")).unwrap(); // hidden by policy at its real path
        symlink("node_modules", root.join("nm")).unwrap(); // ignored folder
        for rel in [
            "out", "out.md", "dangling", "a/b/up", "a/b/up2", "self", "g", "nm",
        ] {
            assert!(resolve(&root, rel).is_none(), "{rel}");
        }
    }

    /// The primitive both policies stand on: it says only where a link points, never whether the
    /// target is visible (that is `resolve_entry`'s policy, and the skill check's is its own).
    #[test]
    fn link_target_says_where_a_link_points_and_nothing_about_visibility() {
        let (_t, root) = vault();
        let (_o, outside) = vault();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        symlink(&outside, root.join("out")).unwrap();
        symlink("nowhere", root.join("dangling")).unwrap();
        symlink("..", root.join("a/b/up")).unwrap();
        symlink(".git", root.join("g")).unwrap();
        let parent = |rel: &str| root.join(rel).parent().unwrap().canonicalize().unwrap();
        let t = |rel: &str, r: Option<&Path>| link_target(&root.join(rel), &parent(rel), r);
        assert_eq!(t("out", Some(&root)), LinkTarget::Outside);
        assert_eq!(t("dangling", Some(&root)), LinkTarget::Dangling);
        assert_eq!(t("a/b/up", Some(&root)), LinkTarget::Cycle);
        assert_eq!(t("g", None), LinkTarget::NoRoot);
        // a link into a hidden folder is still inside: the policy is the caller's
        assert_eq!(
            t("g", Some(&root)),
            LinkTarget::Inside {
                real: root.join(".git"),
                rel: PathBuf::from(".git")
            }
        );
    }

    #[test]
    fn no_root_means_no_link_is_followed() {
        let (_t, root) = vault();
        fs::create_dir(root.join("d")).unwrap();
        symlink("d", root.join("l")).unwrap();
        let ft = fs::symlink_metadata(root.join("l")).unwrap().file_type();
        assert!(resolve_entry(&root.join("l"), ft, &root, None).is_none());
    }

    #[test]
    fn symlink_in_path_names_the_first_link() {
        let (_t, root) = vault();
        fs::create_dir_all(root.join("real/sub")).unwrap();
        fs::create_dir(root.join(".agents")).unwrap();
        symlink("../real", root.join(".agents/skills")).unwrap();
        assert_eq!(
            symlink_in_path(&root, Path::new(".agents/skills/sub/x")),
            Some(PathBuf::from(".agents/skills"))
        );
        assert_eq!(symlink_in_path(&root, Path::new("real/sub")), None);
        assert_eq!(symlink_in_path(&root, Path::new("missing/x")), None);
    }

    #[test]
    fn write_target_follows_a_file_link_and_rejects_a_dangling_one() {
        let (_t, root) = vault();
        fs::write(root.join("real.md"), "x").unwrap();
        symlink("real.md", root.join("l.md")).unwrap();
        symlink("gone.md", root.join("d.md")).unwrap();
        assert_eq!(
            write_target(&root.join("l.md")).unwrap(),
            root.join("real.md")
        );
        assert_eq!(
            write_target(&root.join("new.md")).unwrap(),
            root.join("new.md")
        );
        assert!(write_target(&root.join("d.md")).is_err());
    }
}
