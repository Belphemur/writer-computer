//! The one place that says "a vault file or folder was moved or deleted", for every per-path
//! store that must follow it: today the icons (`.writer/icons.json`) and the per-note ignored
//! words of the spell checker (device-local, app data dir). `relocate::apply`, the app's rename
//! and delete and the CLI's delete call [`moved`] / [`deleted`] (or their absolute-path forms)
//! and nothing else; a store added later is added here, once.
//!
//! Tauri-free. The files are already moved or gone when this runs, so nothing here fails the
//! operation: a store that cannot follow logs a warning and carries on.

use crate::{icons, spellcheck};
use std::path::Path;

/// The new key of `key` after `from` (a file or a folder) moved to `to`: `to` itself, or the
/// same descendant path under it; `None` when `key` is neither `from` nor under it. The one
/// prefix rule every store re-keys by.
pub fn moved_key(key: &str, from: &str, to: &str) -> Option<String> {
    if key == from {
        return Some(to.to_string());
    }
    key.strip_prefix(from)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(|rest| format!("{to}/{rest}"))
}

/// The vault-relative form of `abs` (forward slashes), `None` outside the vault.
pub fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs
        .strip_prefix(root)
        .ok()
        .map(Path::to_path_buf)
        .or_else(|| {
            let canonical = root.canonicalize().ok()?;
            abs.strip_prefix(canonical).ok().map(Path::to_path_buf)
        })?;
    let text = rel.to_str()?.replace('\\', "/");
    (!text.is_empty()).then_some(text)
}

/// A file or folder moved from `from` to `to` (vault-relative): every store re-keys it.
pub fn moved(root: &Path, from: &str, to: &str) {
    if let Err(e) = icons::on_move(root, from, to) {
        log::warn!("icons: could not re-key after a move: {e}");
    }
    if let Err(e) = spellcheck::ignored::on_move(root, from, to) {
        log::warn!("spellcheck: could not re-key ignored words after a move: {e}");
    }
}

/// A file or folder at `rel` (vault-relative) was deleted: every store drops its entries.
pub fn deleted(root: &Path, rel: &str) {
    if let Err(e) = icons::on_delete(root, rel) {
        log::warn!("icons: could not drop icons after a delete: {e}");
    }
    if let Err(e) = spellcheck::ignored::on_delete(root, rel) {
        log::warn!("spellcheck: could not drop ignored words after a delete: {e}");
    }
}

/// [`moved`] for a caller with absolute paths (nothing happens outside the vault).
pub fn moved_abs(root: &Path, from: &Path, to: &Path) {
    if let (Some(from), Some(to)) = (rel_of(root, from), rel_of(root, to)) {
        moved(root, &from, &to);
    }
}

/// [`deleted`] for a caller with an absolute path.
pub fn deleted_abs(root: &Path, path: &Path) {
    if let Some(rel) = rel_of(root, path) {
        deleted(root, &rel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_follows_its_file_or_folder() {
        assert_eq!(
            moved_key("a/b.md", "a/b.md", "c.md").as_deref(),
            Some("c.md")
        );
        assert_eq!(moved_key("a/b.md", "a", "z").as_deref(), Some("z/b.md"));
        assert_eq!(moved_key("ab/b.md", "a", "z"), None);
        assert_eq!(moved_key("x.md", "a", "z"), None);
    }

    #[test]
    fn absolute_paths_map_to_vault_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert_eq!(
            rel_of(&root, &root.join("a").join("b.md")).as_deref(),
            Some("a/b.md")
        );
        assert_eq!(rel_of(&root, &root), None);
        assert_eq!(rel_of(&root, Path::new("/elsewhere/x.md")), None);
    }
}
