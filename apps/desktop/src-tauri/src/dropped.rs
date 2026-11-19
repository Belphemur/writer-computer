//! Files dropped from the OS (Finder) onto Writer: the one Tauri-free seam behind every drop
//! target (the agent composer, an open note, the sidebar; spec `SPECs/os-drop-spec.md`).
//!
//! What it decides, for each dropped path:
//! - [`classify`]: already inside the vault (then nothing is copied: the target links, mentions or
//!   moves it) or outside;
//! - [`copy_file`]: a file from outside is copied into a vault folder, any type, refused when its
//!   name looks like a secret (`code_files::is_secret_name`, the one rule) or it is over the shared
//!   per-file cap, written by the attachments write path (confined, no clobber, ` 1` suffix);
//! - [`copy_tree`]: a folder from outside is copied recursively (the sidebar only), secret names
//!   skipped and counted, refused over the shared byte and file caps, staged then renamed so the
//!   tree appears whole.
//!
//! Sentences returned are terse and carry no prefix: the target adds its own ("Not attached:").
//! Nothing here logs; paths and names never reach the log.

use crate::attachments::{self, Saved, Source};
use crate::{code_files, vault_ops};
use std::fs;
use std::path::{Path, PathBuf};

/// Where a dropped path stands relative to the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dropped {
    /// Inside the vault (vault-relative path, after links are resolved).
    InVault { rel: String, is_dir: bool },
    /// Outside it: to be copied.
    Outside { is_dir: bool },
}

fn name_of(p: &Path) -> Result<String, String> {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "the dropped item has no name".to_string())
}

fn mb(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

pub fn classify(root: &Path, source: &Path) -> Result<Dropped, String> {
    let root = &root
        .canonicalize()
        .map_err(|_| "the vault can't be read".to_string())?;
    let meta = fs::metadata(source).map_err(|_| "that item can't be read".to_string())?;
    let canon = source
        .canonicalize()
        .map_err(|_| "that item can't be read".to_string())?;
    if !canon.starts_with(root) {
        return Ok(Dropped::Outside {
            is_dir: meta.is_dir(),
        });
    }
    let rel = canon
        .strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "that is the vault itself".to_string())?;
    // `.obsidian` and the like are refused here, as everywhere.
    vault_ops::confine(root, &rel).map_err(|e| e.to_string())?;
    Ok(Dropped::InVault {
        rel,
        is_dir: meta.is_dir(),
    })
}

/// Copies one file from outside into `folder` (vault-relative, may not exist yet).
pub fn copy_file(root: &Path, folder: &str, source: &Path) -> Result<Saved, String> {
    let name = name_of(source)?;
    if code_files::is_secret_name(&name) {
        return Err(format!("{name} looks like a secret"));
    }
    let meta = fs::metadata(source).map_err(|_| format!("{name} can't be read"))?;
    if meta.is_dir() {
        return Err(format!("{name} is a folder; folders can't be copied here"));
    }
    // An image keeps the image cap of the attachments write path.
    if attachments::image_extension(&name).is_none() && meta.len() > attachments::max_file_bytes() {
        return Err(format!(
            "{name} is over the {} MB limit",
            mb(attachments::max_file_bytes())
        ));
    }
    attachments::save_chat_file(root, folder, &name, Source::File(source))
        .map_err(|e| e.to_string())
}

/// What a tree copy did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeCopy {
    /// Vault-relative path of the new folder.
    pub rel: String,
    pub files: usize,
    /// Files left out for a secret-looking name.
    pub skipped: usize,
}

struct Plan {
    files: Vec<(PathBuf, PathBuf)>,
    dirs: Vec<PathBuf>,
    bytes: u64,
    skipped: usize,
}

/// Lists what a copy would write (relative paths), never following links.
fn plan_tree(dir: &Path, rel: &Path, plan: &mut Plan) -> Result<(), String> {
    plan.dirs.push(rel.to_path_buf());
    let entries = fs::read_dir(dir).map_err(|_| "a folder can't be read".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "a folder can't be read".to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry
            .metadata()
            .map_err(|_| "a file can't be read".to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let child_rel = rel.join(&name);
        if meta.is_dir() {
            plan_tree(&entry.path(), &child_rel, plan)?;
        } else if meta.is_file() {
            if code_files::is_secret_name(&name) {
                plan.skipped += 1;
                continue;
            }
            plan.bytes += meta.len();
            plan.files.push((entry.path(), child_rel));
            check_caps(plan)?;
        }
    }
    Ok(())
}

fn check_caps(plan: &Plan) -> Result<(), String> {
    let (max_bytes, max_files) = attachments::max_tree();
    if plan.files.len() > max_files {
        return Err(format!("that folder has over {max_files} files"));
    }
    if plan.bytes > max_bytes {
        return Err(format!("that folder is over {} MB", mb(max_bytes)));
    }
    Ok(())
}

/// Copies the folder `source` from outside into `dest_dir` (vault-relative, an existing folder;
/// `""` the vault root) as a new folder of the same name (` 1`, ` 2` on a clash).
pub fn copy_tree(root: &Path, dest_dir: &str, source: &Path) -> Result<TreeCopy, String> {
    let name = name_of(source)?;
    let mut plan = Plan {
        files: Vec::new(),
        dirs: Vec::new(),
        bytes: 0,
        skipped: 0,
    };
    plan_tree(source, Path::new(""), &mut plan)?;

    let parent = if dest_dir.is_empty() {
        root.to_path_buf()
    } else {
        let c = vault_ops::confine(root, dest_dir).map_err(|e| e.to_string())?;
        c.abs
    };
    if !parent.canonicalize().is_ok_and(|p| p.starts_with(root)) || !parent.is_dir() {
        return Err("the destination is not a folder of the vault".into());
    }
    // Stage next to the target, then rename: the tree appears whole or not at all.
    let staging = parent.join(format!(".writer-drop-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let built = (|| -> std::io::Result<()> {
        for d in &plan.dirs {
            fs::create_dir_all(staging.join(d))?;
        }
        for (from, rel) in &plan.files {
            fs::copy(from, staging.join(rel))?;
        }
        Ok(())
    })();
    if built.is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err("the folder could not be copied".into());
    }
    for n in 0..10_000u32 {
        let candidate = if n == 0 {
            name.clone()
        } else {
            format!("{name} {n}")
        };
        let target = parent.join(&candidate);
        if target.exists() {
            continue;
        }
        if fs::rename(&staging, &target).is_err() {
            let _ = fs::remove_dir_all(&staging);
            return Err("the folder could not be copied".into());
        }
        let rel = if dest_dir.is_empty() {
            candidate
        } else {
            format!("{}/{candidate}", dest_dir.trim_matches('/'))
        };
        return Ok(TreeCopy {
            rel,
            files: plan.files.len(),
            skipped: plan.skipped,
        });
    }
    let _ = fs::remove_dir_all(&staging);
    Err("too many folders with that name".into())
}

/// What dropping one path on a vault folder did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    /// Copied in (`path` vault-relative; `files` and `skipped` are those of a folder).
    Copied {
        path: String,
        is_dir: bool,
        files: usize,
        skipped: usize,
    },
    /// Already in the vault: nothing copied, the caller moves it (links rewritten).
    InVault {
        path: String,
        is_dir: bool,
    },
    Refused {
        name: String,
        message: String,
    },
}

/// The vault-relative form of a folder of the vault (`""` for the root).
pub fn folder_rel(root: &Path, dir: &Path) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "the vault can't be read".to_string())?;
    let canon = dir
        .canonicalize()
        .map_err(|_| "the destination can't be read".to_string())?;
    if !canon.is_dir() {
        return Err("the destination is not a folder".into());
    }
    let rel = canon
        .strip_prefix(&root)
        .map_err(|_| "the destination is outside the vault".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// The sidebar's drop: every `sources` path, outside ones copied into the vault folder
/// `dest_rel`, inside ones reported for the caller to move. One outcome per source, in order.
pub fn import_into(root: &Path, dest_rel: &str, sources: &[PathBuf]) -> Vec<Outcome> {
    sources
        .iter()
        .map(|source| {
            let name = source
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let refused = |message: String| Outcome::Refused {
                name: name.clone(),
                message,
            };
            match classify(root, source) {
                Err(message) => refused(message),
                Ok(Dropped::InVault { rel, is_dir }) => Outcome::InVault { path: rel, is_dir },
                Ok(Dropped::Outside { is_dir: true }) => match copy_tree(root, dest_rel, source) {
                    Ok(t) => Outcome::Copied {
                        path: t.rel,
                        is_dir: true,
                        files: t.files,
                        skipped: t.skipped,
                    },
                    Err(m) => refused(m),
                },
                Ok(Dropped::Outside { is_dir: false }) => match copy_file(root, dest_rel, source) {
                    Ok(s) => Outcome::Copied {
                        path: s.rel_path,
                        is_dir: false,
                        files: 1,
                        skipped: 0,
                    },
                    Err(m) => refused(m),
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        (d, root)
    }

    #[test]
    fn a_path_is_inside_or_outside_the_vault() {
        let (_d, root) = vault();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/n.md"), "x").unwrap();
        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("f.txt"), "x").unwrap();
        assert_eq!(
            classify(&root, &root.join("a/n.md")).unwrap(),
            Dropped::InVault {
                rel: "a/n.md".into(),
                is_dir: false
            }
        );
        assert_eq!(
            classify(&root, &root.join("a")).unwrap(),
            Dropped::InVault {
                rel: "a".into(),
                is_dir: true
            }
        );
        assert_eq!(
            classify(&root, &out.path().join("f.txt")).unwrap(),
            Dropped::Outside { is_dir: false }
        );
        assert_eq!(
            classify(&root, out.path()).unwrap(),
            Dropped::Outside { is_dir: true }
        );
        assert!(classify(&root, &root).is_err());
        assert!(classify(&root, &out.path().join("gone")).is_err());
    }

    #[test]
    fn a_file_from_outside_is_copied_confined_with_a_clash_suffix() {
        let (_d, root) = vault();
        let out = tempfile::tempdir().unwrap();
        let src = out.path().join("data.csv");
        fs::write(&src, "a,b").unwrap();
        let one = copy_file(&root, "n/attachments", &src).unwrap();
        let two = copy_file(&root, "n/attachments", &src).unwrap();
        assert_eq!(one.rel_path, "n/attachments/data.csv");
        assert_eq!(two.rel_path, "n/attachments/data 1.csv");
        assert_eq!(fs::read_to_string(&one.abs_path).unwrap(), "a,b");
        // the folder may not leave the vault
        assert!(copy_file(&root, "../escape", &src).is_err());
        assert!(!root.parent().unwrap().join("escape").exists());
        assert!(copy_file(&root, ".obsidian", &src).is_err());
    }

    #[test]
    fn secret_names_folders_and_oversize_files_are_refused() {
        let (_d, root) = vault();
        let out = tempfile::tempdir().unwrap();
        let secret = out.path().join(".env");
        fs::write(&secret, "K=1").unwrap();
        assert!(copy_file(&root, "x", &secret)
            .unwrap_err()
            .contains("secret"));
        assert!(copy_file(&root, "x", out.path())
            .unwrap_err()
            .contains("folder"));
        let big = out.path().join("big.bin");
        let f = fs::File::create(&big).unwrap();
        f.set_len(attachments::max_file_bytes() + 1).unwrap();
        assert!(copy_file(&root, "x", &big)
            .unwrap_err()
            .contains("over the 25 MB limit"));
        assert!(!root.join("x").exists());
    }

    #[test]
    fn a_folder_is_copied_whole_skipping_secrets_and_links() {
        let (_d, root) = vault();
        let out = tempfile::tempdir().unwrap();
        let src = out.path().join("proj");
        fs::create_dir_all(src.join("sub/deep")).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("sub/deep/b.txt"), "b").unwrap();
        fs::write(src.join("sub/.env"), "S=1").unwrap();
        fs::write(src.join("id_rsa"), "k").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(out.path(), src.join("loop")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        let done = copy_tree(&root, "docs", &src).unwrap();
        assert_eq!(
            done,
            TreeCopy {
                rel: "docs/proj".into(),
                files: 2,
                skipped: 2
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("docs/proj/sub/deep/b.txt")).unwrap(),
            "b"
        );
        assert!(!root.join("docs/proj/sub/.env").exists());
        assert!(!root.join("docs/proj/id_rsa").exists());
        // a clash gets a suffix, the root works, nothing is left staged
        assert_eq!(copy_tree(&root, "docs", &src).unwrap().rel, "docs/proj 1");
        assert_eq!(copy_tree(&root, "", &src).unwrap().rel, "proj");
        let staged = fs::read_dir(root.join("docs"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".writer-drop")
            })
            .count();
        assert_eq!(staged, 0);
        assert!(copy_tree(&root, "../x", &src).is_err());
    }

    #[test]
    fn a_folder_over_the_file_count_cap_is_refused_and_nothing_is_written() {
        let (_d, root) = vault();
        let out = tempfile::tempdir().unwrap();
        let src = out.path().join("many");
        fs::create_dir_all(&src).unwrap();
        let (_, max_files) = attachments::max_tree();
        for i in 0..=max_files {
            fs::write(src.join(format!("f{i}.txt")), "").unwrap();
        }
        let err = copy_tree(&root, "", &src).unwrap_err();
        assert!(err.contains("over"), "{err}");
        assert!(!root.join("many").exists());
    }

    #[test]
    fn a_folder_over_the_byte_cap_is_refused() {
        let (_d, root) = vault();
        let out = tempfile::tempdir().unwrap();
        let src = out.path().join("fat");
        fs::create_dir_all(&src).unwrap();
        let (max_bytes, _) = attachments::max_tree();
        for i in 0..3 {
            let f = fs::File::create(src.join(format!("b{i}.bin"))).unwrap();
            f.set_len(max_bytes / 2).unwrap();
        }
        assert!(copy_tree(&root, "", &src).unwrap_err().contains("MB"));
        assert!(!root.join("fat").exists());
    }

    #[test]
    fn the_sidebar_drop_copies_outside_items_and_reports_inside_ones() {
        let (_d, root) = vault();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/in.md"), "x").unwrap();
        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("a.txt"), "a").unwrap();
        fs::write(out.path().join(".env"), "S").unwrap();
        let dir = out.path().join("d");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        let dest = folder_rel(&root, &root.join("docs")).unwrap();
        assert_eq!(dest, "docs");
        assert_eq!(folder_rel(&root, &root).unwrap(), "");
        assert!(folder_rel(&root, out.path()).is_err());
        let got = import_into(
            &root,
            &dest,
            &[
                out.path().join("a.txt"),
                out.path().join(".env"),
                dir,
                root.join("docs/in.md"),
            ],
        );
        assert_eq!(
            got[0],
            Outcome::Copied {
                path: "docs/a.txt".into(),
                is_dir: false,
                files: 1,
                skipped: 0
            }
        );
        assert!(matches!(&got[1], Outcome::Refused { name, .. } if name == ".env"));
        assert_eq!(
            got[2],
            Outcome::Copied {
                path: "docs/d".into(),
                is_dir: true,
                files: 1,
                skipped: 0
            }
        );
        assert_eq!(
            got[3],
            Outcome::InVault {
                path: "docs/in.md".into(),
                is_dir: false
            }
        );
        // onto the root
        let at_root = import_into(&root, "", &[out.path().join("a.txt")]);
        assert!(matches!(&at_root[0], Outcome::Copied { path, .. } if path == "a.txt"));
    }

    #[test]
    fn a_dropped_file_and_a_pasted_image_land_in_the_attachments_folder_next_to_the_note() {
        let (_d, root) = vault();
        // the empty setting (no Obsidian opinion) is "./attachments": under the note's own folder
        let setting = attachments::effective_setting("", None);
        assert_eq!(setting, "./attachments");
        let folder = attachments::resolve_folder(&setting, "Projects/X");
        assert_eq!(folder, "Projects/X/attachments");
        assert!(!root.join("Projects").exists());
        let out = tempfile::tempdir().unwrap();
        let src = out.path().join("report.xlsx");
        fs::write(&src, "x").unwrap();
        // the first use creates the folder
        let dropped = copy_file(&root, &folder, &src).unwrap();
        assert_eq!(dropped.rel_path, "Projects/X/attachments/report.xlsx");
        assert!(root.join("Projects/X/attachments/report.xlsx").is_file());
        // a paste goes through the same folder rule and the same write path
        let pasted = attachments::save(
            &root,
            &folder,
            "Pasted image 20261119101500.png",
            attachments::Source::Bytes(&[0x89, b'P', b'N', b'G']),
        )
        .unwrap();
        assert_eq!(
            pasted.rel_path,
            "Projects/X/attachments/Pasted image 20261119101500.png"
        );
        // a note at the root gets `attachments/` at the root; the Obsidian setting stays a choice
        assert_eq!(attachments::resolve_folder(&setting, ""), "attachments");
        assert_eq!(attachments::effective_setting("", Some("media")), "media");
        // the Writer setting still wins
        assert_eq!(
            attachments::effective_setting("pics", Some("media")),
            "pics"
        );
    }
}
