//! Tauri-free vault file operations shared by the Tauri commands
//! (`commands/bases.rs`) and the `writer` CLI (`cli/`): path confinement and
//! the one write path for property edits (consolidation: one function, two
//! front ends).
//!
//! Nothing here writes to `.obsidian` (or `.git`), follows a symlink out of the
//! vault, or edits a non-markdown file's properties.

use crate::index::patch::{self, PatchError, ValueType};
use serde_json::Value as Json;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum VaultOpError {
    #[error("{0}")]
    Io(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Patch(#[from] PatchError),
}

impl From<std::io::Error> for VaultOpError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            VaultOpError::NotFound(e.to_string())
        } else {
            VaultOpError::Io(e.to_string())
        }
    }
}

/// Directories nothing may be read or written through these helpers.
const PROTECTED: [&str; 2] = [".obsidian", ".git"];

/// A path accepted by [`confine`]: the resolved absolute path and the
/// vault-relative form with forward slashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Confined {
    pub abs: PathBuf,
    pub rel: String,
}

/// Canonicalise `path`, tolerating a tail that does not exist yet (the nearest
/// existing ancestor is canonicalised and the rest re-attached).
fn resolve_lenient(path: &Path) -> Result<PathBuf, VaultOpError> {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        match cur.canonicalize() {
            Ok(mut resolved) => {
                for part in missing.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(_) => {
                let name = cur
                    .file_name()
                    .ok_or_else(|| {
                        VaultOpError::Invalid(format!("invalid path: {}", path.display()))
                    })?
                    .to_os_string();
                missing.push(name);
                if !cur.pop() {
                    return Err(VaultOpError::Invalid(format!(
                        "invalid path: {}",
                        path.display()
                    )));
                }
            }
        }
    }
}

/// Confine `input` (vault-relative, or absolute inside the vault) to `root`,
/// which must be canonical. Rejects `..`, absolute paths outside the vault,
/// symlinks that resolve outside it and protected folders.
pub fn confine(root: &Path, input: &str) -> Result<Confined, VaultOpError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(VaultOpError::Invalid("empty path".into()));
    }
    let p = Path::new(input);
    let candidate: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        for c in p.components() {
            if matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(VaultOpError::Invalid(format!(
                    "{input} must stay inside the vault"
                )));
            }
        }
        root.join(p)
    };
    let resolved = resolve_lenient(&candidate)?;
    let rel = resolved
        .strip_prefix(root)
        .map_err(|_| VaultOpError::Invalid(format!("{input} is outside the vault")))?;
    let mut parts: Vec<&str> = Vec::new();
    for c in rel.components() {
        let name = c
            .as_os_str()
            .to_str()
            .ok_or_else(|| VaultOpError::Invalid(format!("{input} is not valid UTF-8")))?;
        if PROTECTED.contains(&name) {
            return Err(VaultOpError::Invalid(format!(
                "{input} is inside {name}, which Writer never reads or writes"
            )));
        }
        parts.push(name);
    }
    if parts.is_empty() {
        return Err(VaultOpError::Invalid(format!(
            "{input} is the vault root, not a file"
        )));
    }
    Ok(Confined {
        abs: resolved.clone(),
        rel: parts.join("/"),
    })
}

pub fn is_markdown_rel(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// [`confine`] plus the markdown requirement of property edits.
pub fn confine_markdown(root: &Path, input: &str) -> Result<Confined, VaultOpError> {
    let c = confine(root, input)?;
    if !is_markdown_rel(&c.rel) {
        return Err(VaultOpError::Invalid(format!(
            "{} is not a markdown note; properties live in markdown frontmatter",
            c.rel
        )));
    }
    Ok(c)
}

pub fn read_text(abs: &Path) -> Result<String, VaultOpError> {
    let bytes = std::fs::read(abs)?;
    String::from_utf8(bytes)
        .map_err(|_| VaultOpError::Invalid(format!("{} is not valid UTF-8 text", abs.display())))
}

/// The app's one atomic write (temp file + rename, `commands::fs`).
pub fn write_text(abs: &Path, text: &str) -> Result<(), VaultOpError> {
    let s = abs
        .to_str()
        .ok_or_else(|| VaultOpError::Invalid("path is not valid UTF-8".into()))?;
    crate::commands::fs::write_file_impl(s, text)
        .map(|_| ())
        .map_err(|e| VaultOpError::Io(e.to_string()))
}

/// Read, patch and atomically rewrite a note. Returns `false` (and writes
/// nothing) when the patch leaves the text unchanged.
pub fn edit_note(
    abs: &Path,
    f: impl FnOnce(&str) -> Result<String, PatchError>,
) -> Result<bool, VaultOpError> {
    let old = read_text(abs)?;
    let new = f(&old)?;
    if new == old {
        return Ok(false);
    }
    write_text(abs, &new)?;
    Ok(true)
}

pub fn set_property_file(
    abs: &Path,
    name: &str,
    value: &Json,
    hint: Option<ValueType>,
) -> Result<bool, VaultOpError> {
    edit_note(abs, |t| patch::set_property(t, name, value, hint))
}

pub fn remove_property_file(abs: &Path, name: &str) -> Result<bool, VaultOpError> {
    edit_note(abs, |t| patch::remove_property(t, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn root() -> (TempDir, PathBuf) {
        let d = TempDir::new().unwrap();
        let r = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(r.join("a/b")).unwrap();
        std::fs::create_dir_all(r.join(".obsidian")).unwrap();
        std::fs::write(r.join("a/n.md"), "---\nk: 1\n---\nx\n").unwrap();
        std::fs::write(r.join("a/pic.png"), "x").unwrap();
        (d, r)
    }

    #[test]
    fn accepts_relative_and_absolute_inside() {
        let (_d, r) = root();
        let c = confine(&r, "a/n.md").unwrap();
        assert_eq!(c.rel, "a/n.md");
        assert_eq!(c.abs, r.join("a/n.md"));
        let c = confine(&r, r.join("a/n.md").to_str().unwrap()).unwrap();
        assert_eq!(c.rel, "a/n.md");
        // a file that does not exist yet, in a folder that does not either
        let c = confine(&r, "new/dir/x.md").unwrap();
        assert_eq!(c.rel, "new/dir/x.md");
    }

    #[test]
    fn rejects_escapes_and_protected_dirs() {
        let (d, r) = root();
        for bad in [
            "../x.md",
            "a/../../x.md",
            "",
            "   ",
            ".obsidian/app.json",
            "a/../.obsidian/x.md",
            ".git/config",
            "/etc/passwd",
        ] {
            assert!(confine(&r, bad).is_err(), "{bad:?} must be rejected");
        }
        let outside = TempDir::new().unwrap();
        let abs_out = outside.path().join("o.md");
        assert!(confine(&r, abs_out.to_str().unwrap()).is_err());
        assert!(confine(&r, r.to_str().unwrap()).is_err());
        drop(d);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        let (_d, r) = root();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), r.join("a/link")).unwrap();
        assert!(confine(&r, "a/link/secret.md").is_err());
        assert!(confine(&r, "a/link/new.md").is_err());
        std::os::unix::fs::symlink(outside.path().join("secret.md"), r.join("a/s.md")).unwrap();
        assert!(confine(&r, "a/s.md").is_err());
        // a symlink that stays inside is fine and resolves to its target
        std::os::unix::fs::symlink(r.join("a/n.md"), r.join("a/alias.md")).unwrap();
        assert_eq!(confine(&r, "a/alias.md").unwrap().rel, "a/n.md");
    }

    #[test]
    fn property_edits_need_markdown() {
        let (_d, r) = root();
        assert!(confine_markdown(&r, "a/n.md").is_ok());
        assert!(confine_markdown(&r, "a/pic.png").is_err());
        assert!(confine_markdown(&r, "a/x.base").is_err());
    }

    #[test]
    fn a_dotted_name_edits_a_key_inside_a_map_on_disk() {
        let (_d, r) = root();
        let abs = r.join("a/n.md");
        std::fs::write(&abs, "---\nk: 1\nmeta:\n  v: 1\n  w: x\n---\nbody\n").unwrap();
        assert!(set_property_file(&abs, "meta.v", &json!(2), None).unwrap());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nk: 1\nmeta:\n  v: 2\n  w: x\n---\nbody\n"
        );
        assert!(remove_property_file(&abs, "meta.w").unwrap());
        assert!(remove_property_file(&abs, "meta.v").unwrap());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nk: 1\nmeta: {}\n---\nbody\n"
        );
        // a flow map is refused and the file is untouched
        std::fs::write(&abs, "---\nmeta: {v: 1}\n---\nbody\n").unwrap();
        assert!(set_property_file(&abs, "meta.v", &json!(2), None).is_err());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nmeta: {v: 1}\n---\nbody\n"
        );
    }

    #[test]
    fn set_and_remove_round_trip_on_disk() {
        let (_d, r) = root();
        let abs = r.join("a/n.md");
        assert!(set_property_file(&abs, "tags", &json!(["x", "y"]), None).unwrap());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nk: 1\ntags:\n  - x\n  - y\n---\nx\n"
        );
        // no-op writes nothing
        assert!(!set_property_file(&abs, "k", &json!(1), None).unwrap());
        assert!(remove_property_file(&abs, "tags").unwrap());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nk: 1\n---\nx\n"
        );
        assert!(matches!(
            remove_property_file(&abs, "nope"),
            Err(VaultOpError::Patch(PatchError::NotFound(_)))
        ));
        // unparsable frontmatter: file untouched
        std::fs::write(&abs, "---\nk: [oops\n---\nbody\n").unwrap();
        assert!(set_property_file(&abs, "a", &json!(1), None).is_err());
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "---\nk: [oops\n---\nbody\n"
        );
    }
}
