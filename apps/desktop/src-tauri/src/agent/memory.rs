//! Agent memory in the vault (ADR "Keep agent memory in the vault through the backend's own
//! memory tool", spec `SPECs/agent-memory-spec.md`). Tauri-free.
//!
//! The one place that knows where memory lives: the vault memory is `<vault>/.writer/memory/`, a
//! project's is `<project>/.memory/` (the hidden-folder pattern of `<project>/.chats/`). Both
//! paths are built here from the session's confined root and project, never from model input,
//! and are confined to the vault (`vault_ops::confine`: no `..`, no link out, no `.git` or
//! `.obsidian`). The CLI writes the files itself (Claude Code's layout: a `MEMORY.md` index plus
//! one note per fact); this module lists, deletes and imports them for the Settings section and
//! tells the Changes card which paths are memory.
//!
//! Never logged: memory contents, file names and paths (counts only).

use crate::vault_ops::{self, VaultOpError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The vault memory folder, relative to the vault root.
pub const VAULT_MEMORY_REL: &str = ".writer/memory";
/// A project's memory folder name, inside the project folder.
pub const PROJECT_MEMORY_DIR: &str = ".memory";
/// The index file of a memory folder.
pub const INDEX_FILE: &str = "MEMORY.md";

/// Which memory folder a command acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Vault,
    Project,
}

/// The memory folder for a chat: the vault's, or the project's when `project_path` is set.
/// `root` must be the canonical vault root. Does not create anything.
pub fn memory_dir(root: &Path, project_path: Option<&str>) -> Result<PathBuf, VaultOpError> {
    let rel = match project_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => VAULT_MEMORY_REL.to_string(),
        Some(p) => {
            // the project folder is confined first (it may not be a link out); `.memory` is
            // confined again below, as it may itself be a link
            let project = vault_ops::confine(root, p)?;
            format!("{}/{PROJECT_MEMORY_DIR}", project.rel)
        }
    };
    Ok(vault_ops::confine(root, &rel)?.abs)
}

/// [`memory_dir`] for a scope: `Project` needs a project path.
pub fn scope_dir(
    root: &Path,
    scope: MemoryScope,
    project_path: Option<&str>,
) -> Result<PathBuf, VaultOpError> {
    match (scope, project_path.map(str::trim).filter(|p| !p.is_empty())) {
        (MemoryScope::Vault, _) => memory_dir(root, None),
        (MemoryScope::Project, Some(p)) => memory_dir(root, Some(p)),
        (MemoryScope::Project, None) => Err(VaultOpError::Invalid(
            "a project memory needs a project".into(),
        )),
    }
}

/// [`memory_dir`], created, and confined again once it exists (a folder that turned out to be a
/// link out is refused). Call it before a spawn.
pub fn prepare_dir(root: &Path, project_path: Option<&str>) -> Result<PathBuf, VaultOpError> {
    let dir = memory_dir(root, project_path)?;
    fs::create_dir_all(&dir)?;
    let canon = dir.canonicalize()?;
    if !canon.starts_with(root) {
        return Err(VaultOpError::Invalid(
            "the memory folder is outside the vault".into(),
        ));
    }
    Ok(dir)
}

/// The vault memory's index as a chat running in `cwd` should name it: relative to `cwd`
/// (`../../.writer/memory/MEMORY.md` from a project two folders deep), so the block's text stays
/// short however long the vault's absolute path is (the block has a character budget). `cwd` is
/// the vault root or a folder under it; anything else (it cannot happen for a confined project)
/// falls back to the absolute path. Pure, no I/O.
pub fn vault_index_from(root: &Path, cwd: &Path) -> String {
    let index = format!("{VAULT_MEMORY_REL}/{INDEX_FILE}");
    match cwd.strip_prefix(root) {
        Ok(rel) => format!("{}{index}", "../".repeat(rel.components().count())),
        Err(_) => root.join(index).to_string_lossy().into_owned(),
    }
}

/// Whether a vault-relative path (forward slashes) is inside a memory folder: under
/// `.writer/memory/`, or under a `.memory/` folder (a project's). Used by the Changes card.
pub fn is_memory_rel(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let Some((_, dirs)) = parts.split_last() else {
        return false;
    };
    dirs.windows(2)
        .any(|w| w[0] == ".writer" && w[1] == "memory")
        || dirs.contains(&PROJECT_MEMORY_DIR)
}

/// One file of a memory folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub name: String,
    /// Absolute path, to open it as a note.
    pub path: String,
    pub bytes: u64,
    /// Milliseconds since the epoch, 0 when unknown.
    pub modified_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFolder {
    pub scope: MemoryScope,
    /// Absolute path of the folder (it may not exist yet).
    pub path: String,
    pub exists: bool,
    /// Top-level regular files, the index first, then by name.
    pub files: Vec<MemoryFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOverview {
    pub vault: MemoryFolder,
    /// `None` outside a project.
    pub project: Option<MemoryFolder>,
}

fn path_string(p: &Path) -> Result<String, VaultOpError> {
    p.to_str()
        .map(String::from)
        .ok_or_else(|| VaultOpError::Invalid("path is not valid UTF-8".into()))
}

/// Top-level regular files of `dir` (links are never followed), index first.
fn list_files(dir: &Path) -> Result<Vec<MemoryFile>, VaultOpError> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in rd.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(MemoryFile {
            path: path_string(&entry.path())?,
            name,
            bytes: meta.len(),
            modified_ms,
        });
    }
    out.sort_by(|a, b| (a.name != INDEX_FILE, &a.name).cmp(&(b.name != INDEX_FILE, &b.name)));
    Ok(out)
}

fn folder(
    root: &Path,
    scope: MemoryScope,
    project_path: Option<&str>,
) -> Result<MemoryFolder, VaultOpError> {
    let dir = scope_dir(root, scope, project_path)?;
    Ok(MemoryFolder {
        scope,
        path: path_string(&dir)?,
        exists: dir.is_dir(),
        files: list_files(&dir)?,
    })
}

/// The vault memory and, for a project chat, the project's.
pub fn list(root: &Path, project_path: Option<&str>) -> Result<MemoryOverview, VaultOpError> {
    let has_project = project_path.is_some_and(|p| !p.trim().is_empty());
    Ok(MemoryOverview {
        vault: folder(root, MemoryScope::Vault, None)?,
        project: has_project
            .then(|| folder(root, MemoryScope::Project, project_path))
            .transpose()?,
    })
}

/// Deletes one file of a memory folder. `name` is a plain file name, never a path.
pub fn delete(
    root: &Path,
    scope: MemoryScope,
    project_path: Option<&str>,
    name: &str,
) -> Result<(), VaultOpError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(VaultOpError::Invalid(
            "a memory file is named, not given as a path".into(),
        ));
    }
    let target = scope_dir(root, scope, project_path)?.join(name);
    let meta = fs::symlink_metadata(&target)?;
    if !meta.is_file() && !meta.file_type().is_symlink() {
        return Err(VaultOpError::Invalid(
            "only a file of the memory folder can be deleted".into(),
        ));
    }
    // a link is removed itself, never followed
    fs::remove_file(&target)?;
    Ok(())
}

/// Empties a memory folder (files and sub-folders; links are removed, never followed); the
/// folder stays. Returns how many top-level entries went.
pub fn forget_all(
    root: &Path,
    scope: MemoryScope,
    project_path: Option<&str>,
) -> Result<usize, VaultOpError> {
    let dir = scope_dir(root, scope, project_path)?;
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut n = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
        n += 1;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------------------------
// Import from Claude Code's own memory

/// Claude Code's project key for an absolute path: every character that is not an ASCII letter
/// or digit becomes `-` (`/private/tmp/x_y` -> `-private-tmp-x-y`). Paths over about 200
/// characters are shortened with a hash by the CLI; those are not matched (nothing is imported
/// for them).
pub fn claude_project_key(abs: &Path) -> String {
    abs.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A memory file over this size is not imported (the CLI keeps them small).
const MAX_IMPORT_BYTES: u64 = 1024 * 1024;
/// Files imported per folder at most.
const MAX_IMPORT_FILES: usize = 500;
/// Suffixed names tried before a clashing file is given up on.
const MAX_SUFFIXES: usize = 99;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Memory folders of Claude Code found for this vault and its projects.
    pub folders_found: u32,
    pub imported: u32,
    /// Already there (same name and text) or not importable (too large, not text, link).
    pub skipped: u32,
}

/// `<name>`, then `<stem>-imported.<ext>`, `<stem>-imported-2.<ext>`, ...
fn candidate(name: &str, n: usize) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    if n == 1 {
        format!("{stem}-imported{ext}")
    } else {
        format!("{stem}-imported-{n}{ext}")
    }
}

/// Copies the text files of `src` into `dst` (created). Never overwrites: a name that is taken by
/// different text gets a suffix; the same text under the same name (or under a suffixed one, from
/// an earlier run) is skipped, so a second run imports nothing.
fn import_folder(src: &Path, dst: &Path, report: &mut ImportReport) -> Result<(), VaultOpError> {
    let Ok(rd) = fs::read_dir(src) else {
        return Ok(());
    };
    report.folders_found += 1;
    let mut names: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path())))
        .collect();
    names.sort();
    for (name, path) in names.into_iter().take(MAX_IMPORT_FILES) {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        let text = (meta.is_file() && meta.len() <= MAX_IMPORT_BYTES)
            .then(|| fs::read_to_string(&path).ok())
            .flatten();
        let Some(text) = text else {
            report.skipped += 1;
            continue;
        };
        fs::create_dir_all(dst)?;
        let mut placed = false;
        for n in 0..=MAX_SUFFIXES {
            let target = dst.join(candidate(&name, n));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut f) => {
                    f.write_all(text.as_bytes())?;
                    report.imported += 1;
                    placed = true;
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if fs::read_to_string(&target).is_ok_and(|t| t == text) {
                        placed = true;
                        report.skipped += 1;
                        break;
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        if !placed {
            report.skipped += 1;
        }
    }
    Ok(())
}

/// One-time, user-initiated import of Claude Code's own memory (`<home>/.claude/projects/<key>/
/// memory/`) for the vault root and each of `project_paths` (vault-relative project folders)
/// into the vault memory and the matching project memories. Reads nothing else under the home
/// folder, never overwrites, never deletes. `root` must be the canonical vault root.
pub fn import_claude(
    root: &Path,
    home: &Path,
    project_paths: &[String],
) -> Result<ImportReport, VaultOpError> {
    let projects_dir = home.join(".claude").join("projects");
    let mut report = ImportReport::default();
    let vault_dst = memory_dir(root, None)?;
    // the vault's own folder first, then every project
    let mut jobs: Vec<(PathBuf, PathBuf)> = vec![(
        projects_dir.join(claude_project_key(root)).join("memory"),
        vault_dst,
    )];
    for p in project_paths {
        let project = vault_ops::confine(root, p)?;
        jobs.push((
            projects_dir
                .join(claude_project_key(&project.abs))
                .join("memory"),
            memory_dir(root, Some(&project.rel))?,
        ));
    }
    for (src, dst) in jobs {
        import_folder(&src, &dst, &mut report)?;
    }
    Ok(report)
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
