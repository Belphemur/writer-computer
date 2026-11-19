use crate::error::AppError;
use crate::fs_entry::ResolvedEntry;
use crate::ignore::WorkspaceIgnore;
use crate::state::{AppState, WorkspaceState};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_markdown: bool,
    pub modified_at: u64,
    /// Creation time in seconds since the epoch. Falls back to the modified
    /// time on filesystems without a birth time (many Linux mounts).
    pub created_at: u64,
    /// Display-title override from frontmatter `title:`. `None` (directories, `.base`, notes
    /// without the property): the entry shows its file name. A heading is never a title.
    pub title: Option<String>,
    /// Vault-relative real path when this entry is a symlink followed inside the vault
    /// (`fs_entry`); absent for ordinary entries. The sidebar shows it as a tooltip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub path: String,
    pub modified_at: u64,
}

use super::blocking;

/// The note's display-title override: a non-empty top-level frontmatter `title:` read from the
/// first few KB. `None` means the note shows its file name; a heading is never a title.
fn extract_title(path: &Path) -> Option<String> {
    use std::io::Read;

    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let text = std::str::from_utf8(&buf[..n]).ok()?;
    frontmatter_title(text)
}

fn frontmatter_title(text: &str) -> Option<String> {
    let fm = crate::index::frontmatter::split(text).fm?;
    for line in fm.lines() {
        // Top-level key only: an indented `title:` belongs to a nested property.
        let Some(value) = line.strip_prefix("title:") else {
            continue;
        };
        let value = value.trim();
        let title = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();
        if !title.is_empty() {
            return Some(title.to_string());
        }
    }
    None
}

fn epoch_secs(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok().map(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    })
}

pub(crate) fn modified_time(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| epoch_secs(m.modified()))
        .unwrap_or(0)
}

/// Creation time, falling back to the modified time where the platform or
/// filesystem exposes none, so created-time sorting degrades to modified-time
/// sorting instead of collapsing to zero.
pub(crate) fn created_time(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| epoch_secs(m.created()).or_else(|| epoch_secs(m.modified())))
        .unwrap_or(0)
}

/// Files the sidebar, quick open and the file index surface: Markdown notes,
/// `.base` files (Obsidian Bases), code files and images (`code_files`). `DirEntry::is_markdown` is the
/// "listed file" flag for both; a `.base` has no title.
pub(crate) fn is_listed_file(path: &Path) -> bool {
    crate::code_files::is_listed_path(path)
}

fn is_base_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("base")
}

/// Only notes carry a frontmatter title; `.base` and code files show their file name.
fn is_note_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Is this directory entry hidden from the tree? Inside a vault the rule is
/// `code_files::rel_is_visible` (dot-folders hidden except `.agents/skills` and
/// `.claude/skills`, the ignored-folder list); outside one (no workspace root) a leading dot or an
/// ignored-folder name hides it.
fn entry_hidden(root: Option<&Path>, path: &Path, name: &str) -> bool {
    match root.and_then(|r| path.strip_prefix(r).ok()) {
        Some(rel) => !crate::code_files::rel_is_visible(rel),
        None => name.starts_with('.') || crate::code_files::rel_in_ignored_folder(Path::new(name)),
    }
}

/// Recursively checks if a directory contains at least one visible .md file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectoryContent {
    Markdown,
    Empty,
    Other,
}

/// Vault-relative real path of a followed link, for the sidebar tooltip.
fn symlink_target_label(real: &Path, root_real: Option<&Path>) -> String {
    root_real
        .and_then(|r| real.strip_prefix(r).ok())
        .unwrap_or(real)
        .to_string_lossy()
        .replace('\\', "/")
}

/// One entry of a listed folder that is neither hidden by the visibility policy nor ignored, with
/// symlinks resolved by `fs_entry` (the real path of a link must pass the same checks).
struct VisibleEntry {
    path: PathBuf,
    name: String,
    resolved: ResolvedEntry,
}

/// The walk context shared by every on-disk folder walk of this module.
struct Walk<'a> {
    ignore: Option<&'a WorkspaceIgnore>,
    root: Option<&'a Path>,
    root_real: Option<PathBuf>,
}

impl<'a> Walk<'a> {
    fn new(ignore: Option<&'a WorkspaceIgnore>, root: Option<&'a Path>) -> Self {
        Walk {
            ignore,
            root,
            root_real: crate::fs_entry::canonical_root(root),
        }
    }

    fn visible(
        &self,
        entry: Result<std::fs::DirEntry, std::io::Error>,
        parent_real: &Path,
    ) -> Result<Option<VisibleEntry>, AppError> {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if entry_hidden(self.root, &path, &name) {
            return Ok(None);
        }
        let Some(resolved) = crate::fs_entry::resolve_entry(
            &path,
            entry.file_type()?,
            parent_real,
            self.root_real.as_deref(),
        ) else {
            return Ok(None);
        };
        if let Some(matcher) = self.ignore {
            let is_dir = resolved.is_dir();
            if matcher.is_ignored(&path, is_dir)
                || (resolved.symlink && matcher.is_ignored(&resolved.real, is_dir))
            {
                return Ok(None);
            }
        }
        Ok(Some(VisibleEntry {
            path,
            name,
            resolved,
        }))
    }

    /// Canonical path of a folder about to be walked.
    fn real_of(&self, dir: &Path) -> PathBuf {
        dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
    }
}

/// Classify a directory tree through the same visible/ignored lens as the
/// sidebar. Folder-only trees count as empty so a newly created folder stays
/// available for authoring; a visible non-Markdown file makes the tree
/// `Other`. A Markdown file wins immediately. `visited` holds the canonical
/// folders already walked: a symlink cycle (or a folder reachable twice) is walked once.
fn classify_directory_content(
    walk: &Walk,
    path: &Path,
    real: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<DirectoryContent, AppError> {
    let mut content = DirectoryContent::Empty;
    for entry in fs::read_dir(path)? {
        let Some(e) = walk.visible(entry, real)? else {
            continue;
        };
        if e.resolved.is_file() {
            if is_listed_file(&e.path) {
                return Ok(DirectoryContent::Markdown);
            }
            content = DirectoryContent::Other;
        } else if visited.insert(e.resolved.real.clone()) {
            match classify_directory_content(walk, &e.path, &e.resolved.real, visited)? {
                DirectoryContent::Markdown => return Ok(DirectoryContent::Markdown),
                DirectoryContent::Other => content = DirectoryContent::Other,
                DirectoryContent::Empty => {}
            }
        }
    }
    Ok(content)
}

/// Fast indexed-path check for a folder-only tree. Once the Markdown index is
/// ready we already know this subtree has no Markdown, so the first visible
/// file proves it is not empty and lets us stop without walking the remainder.
fn directory_tree_is_empty(
    walk: &Walk,
    path: &Path,
    real: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<bool, AppError> {
    for entry in fs::read_dir(path)? {
        let Some(e) = walk.visible(entry, real)? else {
            continue;
        };
        if e.resolved.is_file()
            || (visited.insert(e.resolved.real.clone())
                && !directory_tree_is_empty(walk, &e.path, &e.resolved.real, visited)?)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// O(1) Markdown check via the pre-built set once available. Directories not
/// in that set still need a recursive classification to distinguish durable
/// empty folder trees from trees containing only non-Markdown files.
fn directory_is_sidebar_visible(
    path: &Path,
    state: Option<&WorkspaceState>,
) -> Result<bool, AppError> {
    if let Some(state) = state {
        let root = state.workspace_root.read().clone();
        let walk_root = root.as_deref();
        // The name mirror holds REAL paths only (the index never follows links), so a followed
        // symlink folder (`.agents/skills -> ../LLM-Agents/skills`) is asked by its canonical
        // path: asked lexically it is absent, which read as "no listed file here" and, with the
        // index ready, hid the folder as soon as it held a file.
        let real = Walk::new(None, walk_root).real_of(path);
        // `Some` once the name mirror holds a finished index.
        let has_listed = state.names.dir_has_listed(&real);
        let index_ready = has_listed.is_some();
        if has_listed == Some(true) {
            return Ok(true);
        }
        // Snapshot the `Arc<WorkspaceIgnore>` under a brief read lock and
        // release immediately — the recursive fallback below does file I/O
        // and must not hold the RwLock across syscalls (it would block a
        // concurrent workspace switch's `workspace_ignore.write()`).
        let ignore_arc: Option<Arc<WorkspaceIgnore>> =
            state.workspace_ignore.read().as_ref().map(Arc::clone);
        let walk = Walk::new(ignore_arc.as_deref(), walk_root);
        let mut visited = HashSet::from([real.clone()]);
        if index_ready {
            return directory_tree_is_empty(&walk, path, &real, &mut visited);
        }
        return Ok(matches!(
            classify_directory_content(&walk, path, &real, &mut visited)?,
            DirectoryContent::Markdown | DirectoryContent::Empty
        ));
    }
    let walk = Walk::new(None, None);
    let real = walk.real_of(path);
    let mut visited = HashSet::from([real.clone()]);
    Ok(matches!(
        classify_directory_content(&walk, path, &real, &mut visited)?,
        DirectoryContent::Markdown | DirectoryContent::Empty
    ))
}

pub fn read_directory_impl(
    path: &str,
    state: Option<&WorkspaceState>,
) -> Result<Vec<DirEntry>, AppError> {
    read_directory_with(path, state, true)
}

/// `titles: false` skips `extract_title`, which opens every markdown file of the folder. The
/// plugin vault walks and lists folders without ever showing a title.
pub fn read_directory_with(
    path: &str,
    state: Option<&WorkspaceState>,
    titles: bool,
) -> Result<Vec<DirEntry>, AppError> {
    let dir_path = PathBuf::from(path);
    if !dir_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }

    // Snapshot the `Arc<WorkspaceIgnore>` under a brief read lock and release
    // immediately — we must NOT hold the RwLock across the per-file I/O
    // below. `extract_title` can block for seconds on iCloud placeholders or
    // slow disks; if the guard were still held, a concurrent workspace
    // switch's `workspace_ignore.write()` in `prepare_workspace_state` would
    // be blocked, freezing the switch IPC.
    let ignore_arc: Option<Arc<WorkspaceIgnore>> =
        state.and_then(|s| s.workspace_ignore.read().as_ref().map(Arc::clone));
    let ignore_matcher: Option<&WorkspaceIgnore> = ignore_arc.as_deref();

    let root_snapshot: Option<PathBuf> = state.and_then(|s| s.workspace_root.read().clone());
    let root_ref = root_snapshot.as_deref();

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    let walk = Walk::new(ignore_matcher, root_ref);
    let dir_real = walk.real_of(&dir_path);

    // Hidden and ignored entries never reach here (`Walk::visible`; the workspace `.gitignore`
    // stays available because only listed files and folders are surfaced, never dotfiles, see
    // the sidebar spec). Symlinks arrive resolved (`fs_entry`).
    for entry in fs::read_dir(&dir_path)?.flatten() {
        let Some(VisibleEntry {
            path: entry_path,
            name,
            resolved,
        }) = walk.visible(Ok(entry), &dir_real)?
        else {
            continue;
        };
        let symlink_target = resolved
            .symlink
            .then(|| symlink_target_label(&resolved.real, walk.root_real.as_deref()));

        if resolved.is_dir() {
            // `.agents` / `.claude` show only when they hold a `skills` folder (the rest of
            // those folders is hidden), so a settings-only `.claude` never appears empty. The
            // folder may be a followed symlink; a link leaving the vault does not count.
            let agent_root = root_ref
                .and_then(|r| entry_path.strip_prefix(r).ok())
                .is_some_and(crate::code_files::is_agent_root_rel);
            let visible = if agent_root {
                crate::fs_entry::resolve_path(
                    &entry_path.join("skills"),
                    &resolved.real,
                    walk.root_real.as_deref(),
                )
                .is_some_and(|s| s.is_dir())
            } else {
                directory_is_sidebar_visible(&entry_path, state)?
            };
            if visible {
                dirs.push(DirEntry {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    is_dir: true,
                    is_markdown: false,
                    modified_at: modified_time(&entry_path),
                    created_at: created_time(&entry_path),
                    title: None,
                    symlink_target,
                });
            }
        } else if is_listed_file(&entry_path) {
            let title = if !titles || !is_note_file(&entry_path) {
                None
            } else {
                extract_title(&entry_path)
            };
            files.push(DirEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: false,
                is_markdown: true,
                modified_at: modified_time(&entry_path),
                created_at: created_time(&entry_path),
                title,
                symlink_target,
            });
        }
    }

    // Sort dirs-first, then alphabetical by filename within each group. This is
    // a stable baseline for every consumer; the sidebar tree re-sorts by its
    // visible label (title or stem) in `flatten-tree.ts`.
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn read_directory(
    path: String,
    titles: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    let state = authorized_state(&app, &webview, &[&path])?;
    blocking(move || read_directory_with(&path, Some(&state), titles.unwrap_or(true))).await
}

/// Resolve this window's state and reject any path outside its allowed
/// roots (workspace root, or the one standalone file). Every command that
/// takes a raw path from the webview goes through this, so script running in
/// the webview — including plugin code — cannot reach other files.
fn authorized_state(
    app: &tauri::AppHandle,
    webview: &tauri::Webview,
    paths: &[&str],
) -> Result<Arc<WorkspaceState>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    for path in paths {
        state.authorize_path(Path::new(path))?;
    }
    Ok(state)
}

pub fn read_file_impl(path: &str) -> Result<FileContent, AppError> {
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }
    // Code files are guarded: never past 20 MiB, never binary or invalid UTF-8.
    let content = if crate::code_files::is_code_path(&file_path) {
        crate::code_files::read_text_guarded(&file_path).map_err(|e| AppError::Io(e.to_string()))?
    } else {
        fs::read_to_string(&file_path)?
    };
    Ok(FileContent {
        path: path.to_string(),
        content,
        modified_at: modified_time(&file_path),
    })
}

#[tauri::command]
pub async fn read_file(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<FileContent, AppError> {
    authorized_state(&app, &webview, &[&path])?;
    blocking(move || read_file_impl(&path)).await
}

pub fn write_file_impl(path: &str, content: &str) -> Result<WriteResult, AppError> {
    // A symlink is written through to its target, never replaced by the rename below. The command
    // authorised the resolved path (inside the vault) before getting here.
    let file_path = crate::fs_entry::write_target(Path::new(path))?;

    // Atomic write: write to temp file, then rename
    let dir = file_path
        .parent()
        .ok_or_else(|| AppError::Io("No parent directory".into()))?;
    let temp_path = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    fs::write(&temp_path, content)?;
    // Keep the mode of the file being replaced: an edited script stays executable.
    if let Ok(existing) = fs::metadata(&file_path) {
        if existing.is_file() {
            let _ = fs::set_permissions(&temp_path, existing.permissions());
        }
    }
    fs::rename(&temp_path, &file_path)?;

    Ok(WriteResult {
        path: path.to_string(),
        modified_at: modified_time(&file_path),
    })
}

#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<WriteResult, AppError> {
    // Record self-write before spawning (fast, just a HashMap insert).
    // The record is per-window so only this window's watcher suppresses
    // the echo — if another window is watching the same workspace it
    // still sees a genuine file-changed event.
    let state = authorized_state(&app, &webview, &[&path])?;
    let label = webview.label().to_string();
    crate::watcher::record_write(&state, &PathBuf::from(&path));

    let write_path = PathBuf::from(&path);
    let result = blocking(move || write_file_impl(&path, &content)).await?;
    state.update_index_modified_at(&write_path, result.modified_at);
    let _ = app.emit_to(label, "sidebar:metadata-changed", &result);
    Ok(result)
}

pub(crate) fn markdown_file_entry(path: &Path) -> Option<DirEntry> {
    if !path.is_file()
        || !(path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            || is_base_file(path)
            || crate::code_files::is_listed_path(path))
    {
        return None;
    }

    let name = path.file_name()?.to_string_lossy().to_string();
    Some(DirEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: false,
        is_markdown: true,
        modified_at: modified_time(path),
        created_at: created_time(path),
        title: if is_note_file(path) {
            extract_title(path)
        } else {
            None
        },
        symlink_target: None,
    })
}

pub fn read_recent_files_impl(
    state: &WorkspaceState,
    limit: usize,
    offset: usize,
) -> Result<Vec<DirEntry>, AppError> {
    let paths = state
        .names
        .recent(offset, limit)
        .map_err(crate::commands::index::app_err)?;
    Ok(paths
        .into_iter()
        .filter_map(|path| markdown_file_entry(&path))
        .collect())
}

#[tauri::command]
pub async fn read_recent_files(
    limit: Option<u32>,
    offset: Option<u32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    let limit = limit.unwrap_or(8).clamp(1, 100) as usize;
    let offset = offset.unwrap_or(0) as usize;
    blocking(move || {
        // Opens the window's index (and binds the name mirror) if needed.
        let (state, _) = crate::commands::index::window_index(&app, &webview)?;
        read_recent_files_impl(&state, limit, offset)
    })
    .await
}

/// Drop every path this window may not touch (symlinks and `..` resolved).
pub fn retain_authorized(state: &WorkspaceState, paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| state.authorize_path(Path::new(p)).is_ok())
        .collect()
}

pub fn read_file_entries_impl(paths: Vec<String>, root: &Path) -> Vec<DirEntry> {
    paths
        .into_iter()
        .filter_map(|path| {
            let path = PathBuf::from(path);
            if !path.starts_with(root) {
                return None;
            }
            markdown_file_entry(&path)
        })
        .collect()
}

#[tauri::command]
pub async fn read_file_entries(
    paths: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    // `starts_with` in the impl is lexical (`root/../x` passes): resolve first
    let paths = retain_authorized(&state, paths);
    blocking(move || Ok(read_file_entries_impl(paths, &root))).await
}

pub fn create_file_impl(path: &str) -> Result<FileContent, AppError> {
    let file_path = PathBuf::from(path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let default_content = "# ";
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::AlreadyExists(path.to_string())
            } else {
                AppError::Io(error.to_string())
            }
        })?;
    if let Err(error) = file.write_all(default_content.as_bytes()) {
        let _ = fs::remove_file(&file_path);
        return Err(AppError::Io(error.to_string()));
    }
    crate::telemetry::track("file_created");
    Ok(FileContent {
        path: path.to_string(),
        content: default_content.to_string(),
        modified_at: modified_time(&file_path),
    })
}

#[tauri::command]
pub async fn create_file(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<FileContent, AppError> {
    authorized_state(&app, &webview, &[&path])?;
    blocking(move || create_file_impl(&path)).await
}

pub fn create_directory_impl(path: &str) -> Result<DirEntry, AppError> {
    let dir_path = PathBuf::from(path);
    if let Some(parent) = dir_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&dir_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::AlreadyExists(path.to_string())
        } else {
            AppError::Io(error.to_string())
        }
    })?;
    let name = dir_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    crate::telemetry::track("folder_created");
    Ok(DirEntry {
        name,
        path: path.to_string(),
        is_dir: true,
        is_markdown: false,
        modified_at: modified_time(&dir_path),
        created_at: created_time(&dir_path),
        title: None,
        symlink_target: None,
    })
}

#[tauri::command]
pub async fn create_directory(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<DirEntry, AppError> {
    authorized_state(&app, &webview, &[&path])?;
    blocking(move || create_directory_impl(&path)).await
}

macro_rules! sidebar_entry_kinds {
    ($( $variant:ident => $wire:literal ),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Deserialize, Serialize)]
        pub enum SidebarEntryKind {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl SidebarEntryKind {
            #[cfg(test)]
            const ALL: &'static [Self] = &[$(Self::$variant),+];
        }
    };
}

sidebar_entry_kinds!(File => "file", Folder => "folder");

fn create_sidebar_candidate(
    candidate: &Path,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    match kind {
        SidebarEntryKind::File => create_file_impl(&candidate.to_string_lossy()).and_then(|_| {
            markdown_file_entry(candidate)
                .ok_or_else(|| AppError::Io("Created Markdown file is unreadable".into()))
        }),
        SidebarEntryKind::Folder => create_directory_impl(&candidate.to_string_lossy()),
    }
}

fn create_sidebar_entry_with(
    parent_path: &Path,
    workspace_root: &Path,
    kind: SidebarEntryKind,
    mut create_candidate: impl FnMut(&Path, SidebarEntryKind) -> Result<DirEntry, AppError>,
) -> Result<DirEntry, AppError> {
    let root = workspace_root
        .canonicalize()
        .map_err(|error| AppError::Io(error.to_string()))?;
    let parent = parent_path
        .canonicalize()
        .map_err(|_| AppError::NotFound(parent_path.to_string_lossy().to_string()))?;
    if !parent.is_dir() || !parent.starts_with(&root) {
        return Err(AppError::InvalidPath(
            parent_path.to_string_lossy().to_string(),
        ));
    }

    let mut suffix = 1_u64;
    loop {
        let numbered = |base: &str| {
            if suffix == 1 {
                base.to_string()
            } else {
                format!("{base} {suffix}")
            }
        };
        let candidate = match kind {
            SidebarEntryKind::File => parent.join(format!("{}.md", numbered("Untitled"))),
            SidebarEntryKind::Folder => parent.join(numbered("Untitled Folder")),
        };
        let result = create_candidate(&candidate, kind);
        match result {
            Ok(mut entry) => {
                // Created through a symlinked folder: the entry belongs to the path the user
                // opened (`.agents/skills/x`), not to the real folder it was written into.
                if parent != parent_path && parent_path.starts_with(&root) {
                    entry.path = parent_path.join(&entry.name).to_string_lossy().into_owned();
                }
                return Ok(entry);
            }
            Err(AppError::AlreadyExists(_)) => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or_else(|| AppError::Io("Untitled name counter overflowed".into()))?;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
pub fn create_sidebar_entry_impl(
    parent_path: &Path,
    workspace_root: &Path,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    create_sidebar_entry_with(parent_path, workspace_root, kind, create_sidebar_candidate)
}

fn create_sidebar_entry_for_snapshot(
    state: &WorkspaceState,
    parent_path: &Path,
    workspace_root: &Path,
    workspace_epoch: u64,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    create_sidebar_entry_with(parent_path, workspace_root, kind, |candidate, kind| {
        state
            .with_workspace_snapshot(workspace_root, workspace_epoch, || {
                let live_root = workspace_root
                    .canonicalize()
                    .map_err(|error| AppError::Io(error.to_string()))?;
                if live_root != workspace_root {
                    return Err(AppError::InvalidPath(
                        "Workspace folder changed before the sidebar entry could be created".into(),
                    ));
                }
                let live_parent = parent_path
                    .canonicalize()
                    .map_err(|_| AppError::NotFound(parent_path.to_string_lossy().into_owned()))?;
                if !live_parent.is_dir() || !live_parent.starts_with(&live_root) {
                    return Err(AppError::InvalidPath(
                        parent_path.to_string_lossy().into_owned(),
                    ));
                }
                let file_name = candidate.file_name().ok_or_else(|| {
                    AppError::InvalidPath(candidate.to_string_lossy().into_owned())
                })?;
                create_sidebar_candidate(&live_parent.join(file_name), kind)
            })
            .ok_or_else(|| {
                AppError::InvalidPath(
                    "Workspace changed before the sidebar entry could be created".into(),
                )
            })?
    })
}

#[tauri::command]
pub async fn create_sidebar_entry(
    parent_path: String,
    kind: SidebarEntryKind,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<DirEntry, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, epoch) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    blocking(move || {
        create_sidebar_entry_for_snapshot(&state, Path::new(&parent_path), &root, epoch, kind)
    })
    .await
}

/// A symlink itself is never renamed or moved (its relative target would break, and a rewrite of
/// links would act on the target). Entries *inside* a linked folder are real and fine.
fn refuse_symlink_root(path: &str) -> Result<(), AppError> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::InvalidPath(format!(
            "{path} is a symbolic link: rename or move the real file or folder instead"
        )));
    }
    Ok(())
}

pub fn rename_entry_impl(old_path: &str, new_path: &str) -> Result<(), AppError> {
    let old = PathBuf::from(old_path);
    if !old.exists() {
        return Err(AppError::NotFound(old_path.to_string()));
    }
    refuse_symlink_root(old_path)?;
    let new = PathBuf::from(new_path);
    if new.exists() {
        return Err(AppError::AlreadyExists(new_path.to_string()));
    }
    fs::rename(old, new)?;
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    old_path: String,
    new_path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let state = authorized_state(&app, &webview, &[&old_path, &new_path])?;
    blocking(move || {
        rename_entry_impl(&old_path, &new_path)?;
        icons_followed(&state, &old_path, &new_path);
        Ok(())
    })
    .await
}

/// The icons of a renamed or moved file or folder follow it (`icons::on_move_abs`: nothing
/// without icons or with the feature off). The files are already moved, so this never fails.
fn icons_followed(state: &WorkspaceState, old_path: &str, new_path: &str) {
    let root = state.workspace_root.read().clone();
    if let Some(root) = root {
        crate::icons::on_move_abs(&root, Path::new(old_path), Path::new(new_path));
    }
}

/// What [`relocate_entry`] did to the links of the vault.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocateResult {
    /// Links rewritten across the vault.
    pub links: usize,
    /// Files in which links were rewritten.
    pub files: usize,
    /// Links to the file that could not be rewritten automatically.
    pub skipped: usize,
    /// False when the vault index was still building: the file was moved but
    /// links were not updated (a partial link graph would miss referrers).
    pub links_updated: bool,
}

fn vault_err(e: crate::vault_ops::VaultOpError) -> AppError {
    use crate::vault_ops::VaultOpError as V;
    match e {
        V::NotFound(m) => AppError::NotFound(m),
        V::Invalid(m) if m.ends_with("already exists") => AppError::AlreadyExists(m),
        V::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

/// Rename or move one file and rewrite every link to it, using the same
/// `relocate` plan/apply as `writer rename` / `writer move`. Folders and
/// files outside an indexed vault go through plain [`rename_entry_impl`].
#[tauri::command]
pub async fn relocate_entry(
    old_path: String,
    new_path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<RelocateResult, AppError> {
    authorized_state(&app, &webview, &[&old_path, &new_path])?;
    blocking(move || {
        refuse_symlink_root(&old_path)?;
        let (_, index) = crate::commands::index::window_index(&app, &webview)?;
        let plain = RelocateResult {
            links: 0,
            files: 0,
            skipped: 0,
            links_updated: false,
        };
        if Path::new(&old_path).is_dir() || !index.is_ready() {
            rename_entry_impl(&old_path, &new_path)?;
            crate::icons::on_move_abs(index.root(), Path::new(&old_path), Path::new(&new_path));
            return Ok(plain);
        }
        let root = index.root().canonicalize()?;
        let plan =
            crate::relocate::plan(&root, &index, &old_path, &new_path, true).map_err(vault_err)?;
        crate::relocate::apply(&plan).map_err(|e| AppError::Io(e.to_string()))?;
        Ok(RelocateResult {
            links: plan.links(),
            files: plan.edits.len(),
            skipped: plan.skipped,
            links_updated: true,
        })
    })
    .await
}

/// What [`retitle_note`] did (or, for a dry run, would do).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetitleResult {
    /// The display title before (`None`: the note showed its file name) and after.
    pub old: Option<String>,
    pub new: Option<String>,
    /// Alias links (`[[File|Old title]]`) rewritten across the vault, and the notes holding them.
    pub links: usize,
    pub files: usize,
    /// False when the index was still building: only the note's frontmatter changed.
    pub links_updated: bool,
    /// Something is (or would be) written.
    pub changed: bool,
}

/// Set (`title`) or clear (`None`) a note's display title, the frontmatter `title` property, and
/// optionally rewrite links that show the old title as their alias. Same plan/apply, dry run
/// and rollback as [`relocate_entry`] (`relocate::retitle`); the file is never renamed.
#[tauri::command]
pub async fn retitle_note(
    path: String,
    title: Option<String>,
    update_links: bool,
    dry_run: bool,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<RetitleResult, AppError> {
    authorized_state(&app, &webview, &[&path])?;
    blocking(move || {
        let (_, index) = crate::commands::index::window_index(&app, &webview)?;
        let links_updated = update_links && index.is_ready();
        let root = index.root().canonicalize()?;
        let r =
            crate::relocate::retitle::plan(&root, &index, &path, title.as_deref(), links_updated)
                .map_err(vault_err)?;
        let changed = !r.plan.edits.is_empty();
        if changed && !dry_run {
            crate::relocate::apply(&r.plan).map_err(|e| AppError::Io(e.to_string()))?;
        }
        let (links, files) = r.link_counts();
        Ok(RetitleResult {
            old: r.old,
            new: r.new,
            links,
            files,
            links_updated,
            changed,
        })
    })
    .await
}

pub fn delete_entry_impl(path: &str) -> Result<(), AppError> {
    delete_entry_with(path, false)
}

/// `permanent` deletes for good. Plugins that churn temp files use it: the system trash goes
/// through Finder, which plays its trash sound for every move.
pub fn delete_entry_with(path: &str, permanent: bool) -> Result<(), AppError> {
    let entry_path = PathBuf::from(path);
    if !entry_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }
    if permanent {
        if entry_path.is_dir() {
            fs::remove_dir_all(&entry_path)?;
        } else {
            fs::remove_file(&entry_path)?;
        }
        return Ok(());
    }
    trash::delete(&entry_path).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_entry(
    path: String,
    permanent: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let state = authorized_state(&app, &webview, &[&path])?;
    blocking(move || {
        delete_entry_with(&path, permanent.unwrap_or(false))?;
        let root = state.workspace_root.read().clone();
        if let Some(root) = root {
            crate::icons::on_delete_abs(&root, Path::new(&path));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn file_exists(path: String, webview: tauri::Webview, app: tauri::AppHandle) -> bool {
    // A path outside this window's reach answers `false` exactly like a
    // missing one, so existence outside the workspace does not leak.
    let state = app.state::<AppState>().get_or_create(webview.label());
    let Ok(resolved) = state.authorize_probe(Path::new(&path)) else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || resolved.exists())
        .await
        .unwrap_or(false)
}

pub fn reveal_in_file_manager_impl(path: &str) -> Result<(), AppError> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` selects the file inside its parent. The
        // comma must be part of the same argument or Windows parses it as a
        // separator.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux: just open the parent directory with xdg-open. There is no
        // portable way to select the target file.
        let parent = target.parent().unwrap_or(&target);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn reveal_in_file_manager(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    authorized_state(&app, &webview, &[&path])?;
    blocking(move || reveal_in_file_manager_impl(&path)).await
}

/// Open an image file in the OS default app (the image viewer's fallback for a type the webview
/// cannot decode). Only the image types of `shared/attachments.json`: this never launches an
/// arbitrary file, and the path must be one this window may reach.
#[tauri::command]
pub async fn open_image_in_default_app(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    authorized_state(&app, &webview, &[&path])?;
    if !crate::attachments::is_render_name(&path) {
        return Err(AppError::Io("Only image files open this way".into()));
    }
    blocking(move || {
        if !Path::new(&path).is_file() {
            return Err(AppError::NotFound(path));
        }
        app.opener()
            .open_path(path, None::<String>)
            .map_err(|e| AppError::Io(e.to_string()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_directory_without_titles_skips_the_file_opens() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "---\ntitle: Real\n---\nbody").unwrap();
        let with = read_directory_with(dir.path().to_str().unwrap(), None, true).unwrap();
        let without = read_directory_with(dir.path().to_str().unwrap(), None, false).unwrap();
        assert_eq!(with[0].title.as_deref(), Some("Real"));
        assert_eq!(without[0].title, None);
        assert_eq!(without[0].name, "a.md");
    }

    /// Synthetic perf probe: `cargo test --lib read_directory_titles_cost -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn read_directory_titles_cost() {
        let dir = TempDir::new().unwrap();
        for i in 0..2000 {
            fs::write(
                dir.path().join(format!("note-{i}.md")),
                format!("---\ntitle: Note {i}\n---\n{}", "body ".repeat(200)),
            )
            .unwrap();
        }
        let p = dir.path().to_str().unwrap();
        for titles in [true, false] {
            let t = std::time::Instant::now();
            let n = read_directory_with(p, None, titles).unwrap().len();
            println!(
                "read_directory titles={titles}: {n} entries in {:?}",
                t.elapsed()
            );
        }
    }

    #[test]
    fn retain_authorized_drops_dotdot_and_outside_paths() {
        let ws = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(ws.path().join("in.md"), "x").unwrap();
        fs::write(outside.path().join("out.md"), "x").unwrap();
        let state = WorkspaceState::default();
        *state.workspace_root.write() = Some(ws.path().canonicalize().unwrap());
        let root = ws.path().canonicalize().unwrap();
        let sneaky = root
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("out.md");
        let kept = retain_authorized(
            &state,
            vec![
                root.join("in.md").to_string_lossy().into_owned(),
                sneaky.to_string_lossy().into_owned(),
                outside.path().join("out.md").to_string_lossy().into_owned(),
            ],
        );
        assert_eq!(
            kept,
            vec![root.join("in.md").to_string_lossy().into_owned()]
        );
    }

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        // Create some markdown files
        fs::write(dir.path().join("hello.md"), "# Hello").unwrap();
        fs::write(dir.path().join("world.md"), "# World").unwrap();
        // Create a non-markdown file (should be filtered)
        fs::write(dir.path().join("readme.bin"), "text").unwrap();
        // Create a subdirectory with markdown
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes").join("note.md"), "# Note").unwrap();
        // Create a subdirectory without markdown (should be filtered)
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::write(dir.path().join("empty").join("data.bin"), "data").unwrap();
        dir
    }

    #[test]
    fn test_read_directory_sorts_dirs_first() {
        let dir = setup_test_dir();
        let result = read_directory_impl(&dir.path().to_string_lossy(), None).unwrap();

        // First entry should be the dir (notes), then files
        assert!(result[0].is_dir);
        assert_eq!(result[0].name, "notes");
        assert!(result[0].title.is_none());
        // Remaining should be files, sorted alphabetically
        assert!(!result[1].is_dir);
        assert_eq!(result[1].name, "hello.md");
        assert_eq!(result[1].title, None);
        assert!(!result[2].is_dir);
        assert_eq!(result[2].name, "world.md");
        assert_eq!(result[2].title, None);
    }

    #[test]
    fn test_read_directory_lists_base_files_but_not_other_types_or_hidden_dirs() {
        let dir = setup_test_dir();
        fs::write(
            dir.path().join("tasks.base"),
            "views:\n  - type: table\n    name: T\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("only-base")).unwrap();
        fs::write(
            dir.path().join("only-base").join("x.base"),
            "# not a title\n",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
        fs::write(dir.path().join(".obsidian").join("y.base"), "").unwrap();
        let result = read_directory_impl(dir.path().to_str().unwrap(), None).unwrap();
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"tasks.base"));
        assert!(names.contains(&"only-base"));
        assert!(!names.contains(&".obsidian"));
        let base = result.iter().find(|e| e.name == "tasks.base").unwrap();
        assert!(base.is_markdown && base.title.is_none());
        assert!(!names.contains(&"data.json"));
        assert!(markdown_file_entry(&dir.path().join("tasks.base")).is_some());
    }

    #[test]
    fn test_read_directory_includes_empty_folder_trees_but_filters_non_markdown_content() {
        let dir = setup_test_dir();
        fs::create_dir_all(dir.path().join("drafts").join("nested")).unwrap();
        fs::write(dir.path().join("drafts").join(".DS_Store"), "hidden").unwrap();
        let result = read_directory_impl(&dir.path().to_string_lossy(), None).unwrap();

        // `drafts/` is an empty folder tree and stays available for authoring.
        // `empty/` contains only a visible non-Markdown file and remains hidden.
        assert_eq!(result.len(), 4);
        assert!(result
            .iter()
            .any(|entry| entry.name == "drafts" && entry.is_dir));
        assert!(!result.iter().any(|entry| entry.name == "empty"));
        for entry in &result {
            assert!(entry.is_dir || entry.is_markdown);
        }
    }

    /// A `WorkspaceState` whose name mirror holds `rows` (vault-relative path,
    /// mtime ms) as a finished index would.
    fn state_with_names(root: &Path, rows: &[(&str, i64)]) -> WorkspaceState {
        let data = TempDir::new().unwrap();
        let vault_files: Vec<_> = rows.iter().map(|(p, _)| *p).collect();
        for p in &vault_files {
            let abs = root.join(p);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            if !abs.exists() {
                fs::write(&abs, "# x").unwrap();
            }
        }
        let index = crate::index::Index::open(crate::index::OpenParams {
            root: root.to_path_buf(),
            app_data_dir: data.path().to_path_buf(),
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            on_change: None,
        })
        .unwrap();
        index.refresh_blocking().unwrap();
        let state = WorkspaceState::default();
        let generation = state.names.reset();
        state.names.bind(
            generation,
            index.root().to_path_buf(),
            index.db_path().to_path_buf(),
        );
        state.names.sync().unwrap();
        // The index (and its data dir) must outlive the mirror's reads only
        // until the rows are loaded; the mirror is in memory from here on.
        for (path, mtime_ms) in rows {
            let abs = index.root().join(path);
            state.names.touch(&abs, (*mtime_ms / 1000) as u64);
        }
        index.close();
        state
    }

    #[test]
    fn test_read_directory_uses_index_when_ready() {
        let dir = setup_test_dir();
        fs::create_dir_all(dir.path().join("drafts").join("nested")).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = state_with_names(&root, &[]);
        assert!(state.names.is_ready());

        let result = read_directory_impl(&dir.path().to_string_lossy(), Some(&state)).unwrap();

        assert_eq!(result.len(), 4);
        assert!(result
            .iter()
            .any(|entry| entry.name == "drafts" && entry.is_dir));
        assert!(!result.iter().any(|entry| entry.name == "empty"));
        assert!(result[0].is_dir);
    }

    /// The user's real layout, built under a symlinked parent (macOS `/var` -> `/private/var`):
    /// `.agents/skills` and `.claude/skills` are relative links to `LLM-Agents/skills`.
    #[cfg(unix)]
    fn agents_vault() -> ((TempDir, TempDir), PathBuf, PathBuf) {
        use std::os::unix::fs::symlink;
        let real_parent = TempDir::new().unwrap();
        let alias = TempDir::new().unwrap();
        let link_parent = alias.path().join("via-link");
        symlink(real_parent.path(), &link_parent).unwrap();
        let raw_root = link_parent.join("PersonalVault");
        let skill = raw_root.join("LLM-Agents/skills/pdf");
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(skill.join("SKILL.md"), "# pdf").unwrap();
        fs::write(skill.join("scripts/run.py"), "print(1)").unwrap();
        fs::create_dir_all(raw_root.join(".agents")).unwrap();
        fs::create_dir_all(raw_root.join(".claude")).unwrap();
        fs::write(raw_root.join(".claude/settings.local.json"), "{}").unwrap();
        symlink("../LLM-Agents/skills", raw_root.join(".agents/skills")).unwrap();
        symlink("../LLM-Agents/skills", raw_root.join(".claude/skills")).unwrap();
        fs::write(raw_root.join(".gitignore"), "ignored-thing/\n").unwrap();
        fs::write(raw_root.join("note.md"), "# n").unwrap();
        (
            (alias, real_parent),
            raw_root.clone(),
            raw_root.canonicalize().unwrap(),
        )
    }

    /// The names the sidebar lists for `dir` through the real command path: the path is
    /// authorized lexically, then listed.
    #[cfg(unix)]
    fn listed(state: &WorkspaceState, dir: &Path) -> Vec<String> {
        state.authorize_path(dir).unwrap();
        read_directory_impl(&dir.to_string_lossy(), Some(state))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect()
    }

    #[cfg(unix)]
    fn assert_agents_vault_lists(state: &WorkspaceState, root: &Path) {
        let top = listed(state, root);
        assert!(top.contains(&".agents".to_string()), "{top:?}");
        assert!(top.contains(&".claude".to_string()), "{top:?}");
        for agent in [".agents", ".claude"] {
            assert_eq!(listed(state, &root.join(agent)), ["skills"], "{agent}");
            assert_eq!(
                listed(state, &root.join(agent).join("skills")),
                ["pdf"],
                "{agent}"
            );
            let skill = root.join(agent).join("skills/pdf");
            assert_eq!(listed(state, &skill), ["scripts", "SKILL.md"], "{agent}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_agent_skills_list_their_children_whatever_the_root_spelling_or_index() {
        let (_keep, raw_root, canonical) = agents_vault();
        for root in [&canonical, &raw_root] {
            // index not ready
            let state = WorkspaceState::default();
            state.replace_workspace_root(root.clone());
            assert_agents_vault_lists(&state, root);
            // index ready
            let state = state_with_names(&canonical, &[]);
            state.replace_workspace_root(root.clone());
            assert!(state.names.is_ready());
            assert_agents_vault_lists(&state, root);
        }
    }

    #[test]
    fn test_directory_visibility_surfaces_read_errors() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("missing");

        assert!(matches!(
            directory_is_sidebar_visible(&missing, None).unwrap_err(),
            AppError::Io(_)
        ));
    }

    #[test]
    fn test_read_recent_files_sorts_by_index_mtime_and_pages() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = state_with_names(
            &root,
            &[("old.md", 1000), ("new.md", 3000), ("middle.md", 2000)],
        );

        let first_page = read_recent_files_impl(&state, 2, 0).unwrap();
        assert_eq!(
            first_page
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["new.md", "middle.md"]
        );

        let second_page = read_recent_files_impl(&state, 2, 2).unwrap();
        assert_eq!(
            second_page
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["old.md"]
        );
    }

    #[test]
    fn test_read_recent_files_reorders_when_a_file_is_saved() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = state_with_names(&root, &[("old.md", 1000), ("new.md", 2000)]);

        let before = read_recent_files_impl(&state, 1, 0).unwrap();
        assert_eq!(before[0].name, "new.md");

        state.update_index_modified_at(&root.join("old.md"), 5);

        let after = read_recent_files_impl(&state, 1, 0).unwrap();
        assert_eq!(after[0].name, "old.md");
    }

    #[test]
    fn test_read_file_entries_filters_missing_non_markdown_and_outside_root() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let kept = dir.path().join("kept.md");
        fs::write(&kept, "# Kept").unwrap();
        fs::write(dir.path().join("note.bin"), "not markdown").unwrap();
        fs::write(outside.path().join("outside.md"), "# Outside").unwrap();

        let entries = read_file_entries_impl(
            vec![
                kept.to_string_lossy().to_string(),
                dir.path().join("missing.md").to_string_lossy().to_string(),
                dir.path().join("note.bin").to_string_lossy().to_string(),
                outside
                    .path()
                    .join("outside.md")
                    .to_string_lossy()
                    .to_string(),
            ],
            dir.path(),
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "kept.md");
    }

    #[test]
    fn test_read_file_returns_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.md");
        fs::write(&path, "# Test Content").unwrap();

        let result = read_file_impl(&path.to_string_lossy()).unwrap();
        assert_eq!(result.content, "# Test Content");
    }

    #[test]
    fn test_read_file_not_found() {
        let result = read_file_impl("/nonexistent/file.md");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[test]
    fn test_write_file_atomic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("output.md");
        fs::write(&path, "old").unwrap();

        let result = write_file_impl(&path.to_string_lossy(), "new content").unwrap();
        assert_eq!(result.path, path.to_string_lossy().to_string());

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");
    }

    #[test]
    fn test_create_file_already_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("exists.md");
        fs::write(&path, "do not overwrite").unwrap();

        let result = create_file_impl(&path.to_string_lossy());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "do not overwrite");
    }

    #[test]
    fn test_create_directory_already_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("exists");
        fs::create_dir(&path).unwrap();

        let result = create_directory_impl(&path.to_string_lossy());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
    }

    #[test]
    fn test_create_sidebar_entry_retries_collisions_without_overwriting() {
        let dir = TempDir::new().unwrap();
        let existing = dir.path().join("Untitled.md");
        fs::write(&existing, "existing content").unwrap();

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::File).unwrap();

        assert_eq!(created.name, "Untitled 2.md");
        assert_eq!(fs::read_to_string(existing).unwrap(), "existing content");
        assert_eq!(fs::read_to_string(created.path).unwrap(), "# ");
    }

    #[test]
    fn test_create_sidebar_entry_has_no_999_name_ceiling() {
        let dir = TempDir::new().unwrap();
        for suffix in 1..1000 {
            let name = if suffix == 1 {
                "Untitled.md".to_string()
            } else {
                format!("Untitled {suffix}.md")
            };
            fs::write(dir.path().join(name), "occupied").unwrap();
        }

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::File).unwrap();

        assert_eq!(created.name, "Untitled 1000.md");
    }

    #[test]
    fn test_create_sidebar_folder_retries_collisions() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("Untitled Folder")).unwrap();

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::Folder).unwrap();

        assert_eq!(created.name, "Untitled Folder 2");
    }

    #[test]
    fn test_create_sidebar_entry_rejects_parent_outside_workspace() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        let result =
            create_sidebar_entry_impl(outside.path(), workspace.path(), SidebarEntryKind::Folder);

        assert!(result.is_err());
    }

    #[test]
    fn sidebar_entry_kind_serialization_matches_the_shared_contract() {
        let contract: std::collections::HashMap<String, bool> =
            serde_json::from_str(include_str!("../../../shared/sidebar-entry-kinds.json")).unwrap();
        let serialized = SidebarEntryKind::ALL
            .iter()
            .copied()
            .map(|kind| {
                serde_json::to_value(kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(
            serialized,
            contract
                .into_keys()
                .collect::<std::collections::HashSet<_>>()
        );
    }

    #[test]
    fn create_sidebar_entry_rejects_stale_workspace_before_mutation() {
        let workspace = TempDir::new().unwrap();
        let replacement = TempDir::new().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let epoch = state.replace_workspace_root(root.clone());
        state.replace_workspace_root(replacement.path().canonicalize().unwrap());

        assert!(matches!(
            create_sidebar_entry_for_snapshot(&state, &root, &root, epoch, SidebarEntryKind::File,)
                .unwrap_err(),
            AppError::InvalidPath(_)
        ));
        assert!(!root.join("Untitled.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_sidebar_entry_rejects_a_replaced_workspace_root() {
        use std::os::unix::fs::symlink;

        let parent = TempDir::new().unwrap();
        let workspace_path = parent.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let root = workspace_path.canonicalize().unwrap();
        let state = WorkspaceState::default();
        let epoch = state.replace_workspace_root(root.clone());

        fs::rename(&workspace_path, parent.path().join("moved-workspace")).unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), &workspace_path).unwrap();

        assert!(matches!(
            create_sidebar_entry_for_snapshot(
                &state,
                &workspace_path,
                &root,
                epoch,
                SidebarEntryKind::File,
            )
            .unwrap_err(),
            AppError::InvalidPath(_)
        ));
        assert!(!outside.path().join("Untitled.md").exists());
    }

    #[test]
    fn test_delete_entry_moves_to_trash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("to_delete.md");
        fs::write(&path, "delete me").unwrap();
        assert!(path.exists());

        delete_entry_impl(&path.to_string_lossy()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_rename_entry() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        let new_path = dir.path().join("new.md");
        fs::write(&old_path, "content").unwrap();

        rename_entry_impl(&old_path.to_string_lossy(), &new_path.to_string_lossy()).unwrap();

        assert!(!old_path.exists());
        assert!(new_path.exists());
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "content");
    }

    #[test]
    fn test_rename_entry_not_found() {
        let result = rename_entry_impl("/nonexistent/old.md", "/nonexistent/new.md");
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[test]
    fn test_rename_entry_already_exists() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        let new_path = dir.path().join("new.md");
        fs::write(&old_path, "old").unwrap();
        fs::write(&new_path, "new").unwrap();

        let result = rename_entry_impl(&old_path.to_string_lossy(), &new_path.to_string_lossy());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
    }

    #[test]
    fn test_error_serializes() {
        let err = AppError::Io("test error".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"IO error: test error\"");

        let err = AppError::NotFound("file.md".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Not found: file.md\"");

        let err = AppError::NoWorkspace;
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"No workspace is open\"");
    }

    #[test]
    fn heading_is_never_a_title() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "# My Document\n\nSome content").unwrap();
        assert_eq!(extract_title(&path), None);
        fs::write(&path, "---\ndate: 2025-01-01\n---\n\n# Fallback Heading").unwrap();
        assert_eq!(extract_title(&path), None);
    }

    #[test]
    fn frontmatter_title_is_the_override() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ntitle: Front Title\n---\n\n# Heading").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Front Title"));
        fs::write(&path, "---\ntitle: \"Quoted Title\"\n---\n\nBody").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Quoted Title"));
        fs::write(&path, "---\r\ntitle: Crlf\r\n---\r\nBody").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Crlf"));
    }

    #[test]
    fn empty_or_nested_title_is_not_an_override() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ntitle:\n---\nBody").unwrap();
        assert_eq!(extract_title(&path), None);
        fs::write(&path, "---\nmeta:\n  title: nested\n---\nBody").unwrap();
        assert_eq!(extract_title(&path), None);
        fs::write(&path, "").unwrap();
        assert_eq!(extract_title(&path), None);
    }

    /// A folder `X` holding `X.md` (first H1 `# Overview`) and `X/Notes/note.md` (H1 `# Description`):
    /// no entry takes a title from a heading or from a neighbouring note.
    #[test]
    fn folder_note_overview_heading_does_not_label_other_notes() {
        let dir = TempDir::new().unwrap();
        let x = dir.path().join("Daniel");
        fs::create_dir_all(x.join("Notes")).unwrap();
        fs::write(x.join("Daniel.md"), "# Overview\n").unwrap();
        fs::write(
            x.join("Notes").join("2026-08-31 - Spec.md"),
            "---\ntags:\n  - employee-note\n---\n# Description\nbody\n",
        )
        .unwrap();
        for d in [x.clone(), x.join("Notes")] {
            for e in read_directory_impl(d.to_str().unwrap(), None).unwrap() {
                assert_eq!(e.title, None, "{}", e.name);
            }
        }
    }

    #[test]
    fn test_workspace_state_default() {
        let state = WorkspaceState::default();
        assert!(state.workspace_root.read().is_none());
        assert!(!state.names.is_bound());
        assert!(!state.names.is_ready());
        assert!(state.watcher_handle.read().is_none());
    }
}
