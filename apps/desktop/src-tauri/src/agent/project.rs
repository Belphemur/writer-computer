//! Agent projects (spec `SPECs/native-agent-spec.md` section 4; ADR "projects are vault folders
//! with project.md and AGENTS.md"). Tauri-free.
//!
//! A project is a vault folder holding `project.md` (Copilot-compatible `copilot-project-*`
//! frontmatter) and the project's own `AGENTS.md`. Everything here goes through
//! `vault_ops::confine` (path containment, `.obsidian`/`.git` refused, symlink escapes refused)
//! and `index::patch` (byte-minimal frontmatter edits: unknown keys, comments, key order and the
//! body survive every write). Files Writer did not ask to create are never touched, and an
//! existing `project.md`, `AGENTS.md` or `CLAUDE.md` is never overwritten.

use super::events::{NewProjectRequest, ProjectInfo, ProjectSource};
use crate::index::patch::{self, PatchError};
use crate::vault_ops::{self, VaultOpError};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const PROJECT_FILE: &str = "project.md";
pub const AGENTS_FILE: &str = "AGENTS.md";
pub const CLAUDE_FILE: &str = "CLAUDE.md";
/// Where the dialog creates projects unless told otherwise.
pub const DEFAULT_PARENT: &str = "Projects";

pub const KEY_ID: &str = "copilot-project-id";
pub const KEY_NAME: &str = "copilot-project-name";
pub const KEY_DESCRIPTION: &str = "copilot-project-description";
pub const KEY_CREATED: &str = "copilot-project-created";
pub const KEY_LAST_USED: &str = "copilot-project-last-used";
pub const KEY_ARCHIVED: &str = "copilot-project-archived-at";
pub const KEY_INCLUSIONS: &str = "copilot-project-inclusions";
pub const KEY_EXCLUSIONS: &str = "copilot-project-exclusions";
pub const KEY_WEB_URLS: &str = "copilot-project-web-urls";
pub const KEY_YOUTUBE_URLS: &str = "copilot-project-youtube-urls";
pub const KEY_AGENT_MODE: &str = "writer-agent-mode";
pub const KEY_ICON: &str = "writer-project-icon";
pub const KEY_COLOR: &str = "writer-project-color";

#[derive(Deserialize)]
struct ProjectColors {
    colors: Vec<String>,
}

/// The accent colors a project can have: `shared/project-colors.json`, the one list (the TS side
/// imports the same file; each name is a `--project-color-<name>` theme token).
pub fn project_colors() -> &'static [String] {
    static COLORS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    COLORS.get_or_init(|| {
        serde_json::from_str::<ProjectColors>(include_str!("../../../shared/project-colors.json"))
            .expect("project-colors.json is malformed")
            .colors
    })
}

const MAX_ICON_CHARS: usize = 64;

/// A Hugeicons export name (`Rocket01Icon`). Rust cannot list the ~4,000 names, so it checks the
/// shape; the web side shows the default icon for a name the set does not have.
fn valid_icon(name: &str) -> bool {
    name.len() <= MAX_ICON_CHARS
        && name.len() > "Icon".len()
        && name.ends_with("Icon")
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn valid_color(name: &str) -> bool {
    project_colors().iter().any(|c| c == name)
}

/// `project.md` larger than this is not read (a project file is a few lines).
const MAX_PROJECT_MD_BYTES: u64 = 256 * 1024;
const MAX_NAME_CHARS: usize = 100;

/// Bounds of the folder walk behind [`list`].
const MAX_DEPTH: usize = 10;
const MAX_DIRS: usize = 20_000;
const MAX_PROJECTS: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    Exists(String),
    #[error("{0}")]
    Io(String),
}

impl From<VaultOpError> for ProjectError {
    fn from(e: VaultOpError) -> Self {
        match e {
            VaultOpError::NotFound(m) => ProjectError::NotFound(m),
            VaultOpError::Invalid(m) => ProjectError::Invalid(m),
            VaultOpError::Io(m) => ProjectError::Io(m),
            VaultOpError::Patch(p) => ProjectError::Invalid(p.to_string()),
        }
    }
}

impl From<PatchError> for ProjectError {
    fn from(e: PatchError) -> Self {
        ProjectError::Invalid(e.to_string())
    }
}

impl From<std::io::Error> for ProjectError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            ProjectError::NotFound(e.to_string())
        } else {
            ProjectError::Io(e.to_string())
        }
    }
}

type Res<T> = Result<T, ProjectError>;

/// [`ProjectInfo`] (the shared contract) plus what the contract has no field for. Serialises as
/// a superset of `ProjectInfo`, so the typed client can read it as one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub info: ProjectInfo,
    /// Entries of the inclusion/exclusion lists whose shape is not recognised (shown as warning
    /// rows, never dropped or rewritten).
    pub unsupported: Vec<String>,
    pub web_urls: Vec<String>,
    pub youtube_urls: Vec<String>,
    /// `writer-agent-mode` (`manual` or `acceptEdits`), when set.
    pub agent_mode: Option<String>,
    /// `writer-project-icon`: a Hugeicons export name, when set and well formed.
    pub icon: Option<String>,
    /// `writer-project-color`: one of `shared/project-colors.json`, when set and known.
    pub color: Option<String>,
    /// Malformed values found in `project.md`.
    pub warnings: Vec<String>,
}

/// What a write did, for the dialog's confirmation line and for tests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub project: ProjectDetail,
    pub created_project_md: bool,
    pub created_agents_md: bool,
    /// Keys added to an adopted `project.md` (existing keys are never changed).
    pub filled_keys: Vec<String>,
}

/// Partial update of `project.md`; only `Some` fields are written.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub inclusions: Option<Vec<String>>,
    pub exclusions: Option<Vec<String>>,
    pub web_urls: Option<Vec<String>>,
    pub youtube_urls: Option<Vec<String>>,
    /// `Some("")` removes the key.
    pub agent_mode: Option<String>,
    /// A Hugeicons export name; `Some("")` removes the key.
    pub icon: Option<String>,
    /// A name from `shared/project-colors.json`; `Some("")` removes the key.
    pub color: Option<String>,
    pub touch_last_used: bool,
}

// -------------------------------------------------------------------------------------------
// Names and paths

/// Turn a user-typed project name into a folder name. Path separators are refused (the dialog
/// shows the error) rather than silently turned into nesting; characters that are illegal on
/// common file systems become `-`.
pub fn sanitize_name(name: &str) -> Res<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProjectError::Invalid("the project needs a name".into()));
    }
    if name.contains(['/', '\\']) {
        return Err(ProjectError::Invalid(
            "a project name cannot contain / or \\ (use Location to choose a folder)".into(),
        ));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(ProjectError::Invalid(
            "a project name cannot contain control characters".into(),
        ));
    }
    let mut out = String::with_capacity(name.len());
    let mut last_space = false;
    for c in name.chars() {
        let c = if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            '-'
        } else {
            c
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    let out: String = out.chars().take(MAX_NAME_CHARS).collect();
    let out = out.trim().trim_end_matches('.').trim().to_string();
    if out.is_empty() || out.starts_with('.') {
        return Err(ProjectError::Invalid(
            "a project name cannot be empty or start with a dot (hidden folders are not indexed)"
                .into(),
        ));
    }
    Ok(out)
}

/// A folder the agent can use as a project is visible: Writer's index, sidebar and the
/// `writer` CLI skip dot segments, so a project there would never be listed.
fn reject_hidden(rel: &str) -> Res<()> {
    if rel
        .split('/')
        .any(|s| s.starts_with('.') || s == "node_modules")
    {
        return Err(ProjectError::Invalid(format!(
            "{rel} is a hidden folder; projects live in visible vault folders"
        )));
    }
    Ok(())
}

fn confine_dir(root: &Path, rel: &str) -> Res<vault_ops::Confined> {
    let c = vault_ops::confine(root, rel)?;
    reject_hidden(&c.rel)?;
    Ok(c)
}

/// The CLI's working directory for a chat: the vault root, or a project folder verified to be
/// inside it (symlink escapes refused).
pub fn resolve_cwd(root: &Path, project_path: Option<&str>) -> Res<PathBuf> {
    let root = root.canonicalize()?;
    match project_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => Ok(root),
        Some(p) => {
            let c = confine_dir(&root, p)?;
            if !c.abs.is_dir() {
                return Err(ProjectError::NotFound(format!("{} is not a folder", c.rel)));
            }
            Ok(c.abs)
        }
    }
}

// -------------------------------------------------------------------------------------------
// Context sources

/// Parse one `inclusions`/`exclusions` string (comma separated, spec 4.2). Entries of an
/// unrecognised shape are returned verbatim in the second list.
pub fn parse_sources(raw: &str) -> (Vec<ProjectSource>, Vec<String>) {
    let mut sources = Vec::new();
    let mut unsupported = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        match parse_source(entry) {
            Some(s) => sources.push(s),
            None => unsupported.push(entry.to_string()),
        }
    }
    (sources, unsupported)
}

fn safe_rel_path(p: &str) -> Option<String> {
    let p = p.trim().trim_start_matches("./");
    if p.is_empty() || p.starts_with('/') || p.contains('\\') {
        return None;
    }
    let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() || segs.iter().any(|s| *s == ".." || *s == ".") {
        return None;
    }
    Some(segs.join("/"))
}

fn parse_source(entry: &str) -> Option<ProjectSource> {
    let raw = entry.to_string();
    if let Some(tag) = entry.strip_prefix('#') {
        let tag = tag.trim();
        let ok = !tag.is_empty() && !tag.contains(char::is_whitespace);
        return ok.then(|| ProjectSource::Tag {
            tag: tag.to_string(),
            raw,
        });
    }
    if let Some(inner) = entry.strip_prefix("[[").and_then(|e| e.strip_suffix("]]")) {
        // `[[Note|alias]]`, `[[Note#Heading]]`: the target is the part before `|` and `#`.
        let target = inner.split(['|', '#']).next().unwrap_or("").trim();
        let target = safe_rel_path(target)?;
        let path = if target.to_ascii_lowercase().ends_with(".md") {
            target
        } else {
            format!("{target}.md")
        };
        return Some(ProjectSource::Note { path, raw });
    }
    let lower = entry.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(ProjectSource::Url {
            url: entry.to_string(),
            raw,
        });
    }
    if let Some((name, value)) = entry.split_once(':') {
        let name = name.trim();
        let name_ok = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '));
        if name_ok {
            let value = value.trim();
            let value = (!value.is_empty() && value != "*").then(|| value.to_string());
            return Some(ProjectSource::Property {
                name: name.to_string(),
                value,
                raw,
            });
        }
        return None;
    }
    let is_folder_form = entry.ends_with('/');
    let path = safe_rel_path(entry)?;
    let last = path.rsplit('/').next().unwrap_or("");
    if path.to_ascii_lowercase().ends_with(".md") && !is_folder_form {
        return Some(ProjectSource::Note { path, raw });
    }
    if is_folder_form || !last.contains('.') {
        return Some(ProjectSource::Folder { path, raw });
    }
    None
}

/// Newline- or comma-separated URLs; non-http(s) entries are dropped from the list (they stay in
/// the file untouched).
fn parse_urls(raw: &str) -> Vec<String> {
    raw.split(['\n', ','])
        .map(str::trim)
        .filter(|u| {
            let l = u.to_ascii_lowercase();
            l.starts_with("http://") || l.starts_with("https://")
        })
        .map(str::to_string)
        .collect()
}

// -------------------------------------------------------------------------------------------
// project.md parsing

fn props_map(text: &str) -> Result<HashMap<String, Json>, PatchError> {
    Ok(patch::read_properties(text)?
        .into_iter()
        .map(|p| (p.name, p.value))
        .collect())
}

/// Text of a property that may legitimately be a string, a number or (tolerated) a YAML list of
/// strings, which is joined with commas.
fn text_value(v: Option<&Json>) -> Option<String> {
    match v? {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        Json::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect();
            Some(parts.join(","))
        }
        Json::Null => Some(String::new()),
        _ => None,
    }
}

fn ts_value(key: &str, v: Option<&Json>, warnings: &mut Vec<String>) -> Option<i64> {
    match v? {
        Json::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Json::String(s) if s.trim().is_empty() => None,
        Json::String(s) => match s.trim().parse::<i64>() {
            Ok(n) => Some(n),
            Err(_) => {
                warnings.push(format!("{key} is not a timestamp"));
                None
            }
        },
        Json::Null => None,
        _ => {
            warnings.push(format!("{key} is not a timestamp"));
            None
        }
    }
}

/// Parse `project.md` text. `None` when the file has no `copilot-project-id` (not a project).
/// Unparsable frontmatter is an error.
pub fn parse_project_md(
    text: &str,
    folder_rel: &str,
    folder_abs: &Path,
) -> Res<Option<ProjectDetail>> {
    let props = props_map(text)?;
    let Some(id) = text_value(props.get(KEY_ID)).filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let mut warnings = Vec::new();
    let folder_name = folder_rel.rsplit('/').next().unwrap_or(folder_rel);
    let name = text_value(props.get(KEY_NAME))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| folder_name.to_string());
    let description = text_value(props.get(KEY_DESCRIPTION)).unwrap_or_default();
    let (inclusions, mut unsupported) =
        parse_sources(&text_value(props.get(KEY_INCLUSIONS)).unwrap_or_default());
    let (exclusions, unsupported_ex) =
        parse_sources(&text_value(props.get(KEY_EXCLUSIONS)).unwrap_or_default());
    unsupported.extend(unsupported_ex);
    for key in [KEY_NAME, KEY_DESCRIPTION, KEY_INCLUSIONS, KEY_EXCLUSIONS] {
        if let Some(v) = props.get(key) {
            if text_value(Some(v)).is_none() {
                warnings.push(format!("{key} is not text"));
            }
        }
    }
    let agent_mode = text_value(props.get(KEY_AGENT_MODE))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(m) = &agent_mode {
        if m != "manual" && m != "acceptEdits" {
            warnings.push(format!("{KEY_AGENT_MODE} must be manual or acceptEdits"));
        }
    }
    let icon = text_value(props.get(KEY_ICON))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let icon = icon.filter(|i| {
        let ok = valid_icon(i);
        if !ok {
            warnings.push(format!("{KEY_ICON} is not an icon name"));
        }
        ok
    });
    let color = text_value(props.get(KEY_COLOR))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let color = color.filter(|c| {
        let ok = valid_color(c);
        if !ok {
            warnings.push(format!("{KEY_COLOR} is not one of the project colors"));
        }
        ok
    });
    let info = ProjectInfo {
        path: folder_rel.to_string(),
        id: id.trim().to_string(),
        name,
        description,
        created_at: ts_value(KEY_CREATED, props.get(KEY_CREATED), &mut warnings),
        last_used_at: ts_value(KEY_LAST_USED, props.get(KEY_LAST_USED), &mut warnings),
        archived_at: ts_value(KEY_ARCHIVED, props.get(KEY_ARCHIVED), &mut warnings),
        inclusions,
        exclusions,
        has_agents_md: is_file(&folder_abs.join(AGENTS_FILE)),
        has_claude_md: is_file(&folder_abs.join(CLAUDE_FILE)),
    };
    Ok(Some(ProjectDetail {
        info,
        unsupported,
        web_urls: parse_urls(&text_value(props.get(KEY_WEB_URLS)).unwrap_or_default()),
        youtube_urls: parse_urls(&text_value(props.get(KEY_YOUTUBE_URLS)).unwrap_or_default()),
        agent_mode,
        icon,
        color,
        warnings,
    }))
}

fn is_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

fn read_project_md(abs_folder: &Path) -> Res<Option<String>> {
    let file = abs_folder.join(PROJECT_FILE);
    match std::fs::metadata(&file) {
        Ok(m) if m.is_file() => {
            if m.len() > MAX_PROJECT_MD_BYTES {
                return Err(ProjectError::Invalid(format!(
                    "{PROJECT_FILE} is larger than {} KiB",
                    MAX_PROJECT_MD_BYTES / 1024
                )));
            }
            Ok(Some(vault_ops::read_text(&file)?))
        }
        Ok(_) => Err(ProjectError::Invalid(format!(
            "{PROJECT_FILE} exists but is not a file"
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Read the project in vault-relative folder `rel`.
pub fn read(root: &Path, rel: &str) -> Res<ProjectDetail> {
    let root = root.canonicalize()?;
    let c = confine_dir(&root, rel)?;
    if !c.abs.is_dir() {
        return Err(ProjectError::NotFound(format!("{} is not a folder", c.rel)));
    }
    let text = read_project_md(&c.abs)?
        .ok_or_else(|| ProjectError::NotFound(format!("{} has no {PROJECT_FILE}", c.rel)))?;
    parse_project_md(&text, &c.rel, &c.abs)?
        .ok_or_else(|| ProjectError::NotFound(format!("{} is not a project (no {KEY_ID})", c.rel)))
}

// -------------------------------------------------------------------------------------------
// Discovery

/// Every project under `root`, found by a bounded walk of the visible folders (dot folders and
/// `node_modules` are skipped like the index does; symlinks are not followed). Copilot's own
/// `copilot/projects/*` are ordinary folders and are found too. Sorted by last use, then name.
pub fn list(root: &Path, include_archived: bool) -> Res<Vec<ProjectDetail>> {
    let root = root.canonicalize()?;
    let mut out: Vec<ProjectDetail> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.clone(), String::new(), 0)];
    let mut dirs_seen = 0usize;
    let mut truncated = false;
    while let Some((dir, rel, depth)) = stack.pop() {
        dirs_seen += 1;
        if dirs_seen > MAX_DIRS || out.len() >= MAX_PROJECTS {
            truncated = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut subdirs = Vec::new();
        let mut has_project_md = false;
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if ft.is_dir() {
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                if depth < MAX_DEPTH {
                    let child_rel = if rel.is_empty() {
                        name.clone()
                    } else {
                        format!("{rel}/{name}")
                    };
                    subdirs.push((entry.path(), child_rel, depth + 1));
                }
            } else if ft.is_file() && name == PROJECT_FILE {
                has_project_md = true;
            }
        }
        if has_project_md && !rel.is_empty() {
            // A broken or foreign project.md is skipped, not fatal: one bad file must not hide
            // every other project.
            match read_project_md(&dir).and_then(|t| match t {
                Some(t) => parse_project_md(&t, &rel, &dir),
                None => Ok(None),
            }) {
                Ok(Some(p)) => {
                    if include_archived || p.info.archived_at.is_none() {
                        out.push(p);
                    }
                }
                Ok(None) => {}
                Err(e) => log::warn!("skipping unreadable project file in a vault folder: {e}"),
            }
        }
        stack.extend(subdirs);
    }
    if truncated {
        log::warn!(
            "project discovery stopped at its bounds ({MAX_DIRS} folders, {MAX_PROJECTS} projects)"
        );
    }
    out.sort_by(|a, b| {
        b.info
            .last_used_at
            .unwrap_or(0)
            .cmp(&a.info.last_used_at.unwrap_or(0))
            .then_with(|| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()))
            .then_with(|| a.info.path.cmp(&b.info.path))
    });
    Ok(out)
}

// -------------------------------------------------------------------------------------------
// Writing

/// Write `content` to `abs` only if nothing is there (temp file + hard link: atomic, and the
/// link fails when the destination exists). Returns whether the file was created.
fn create_new_file(abs: &Path, content: &str) -> Res<bool> {
    use std::io::Write;
    let dir = abs
        .parent()
        .ok_or_else(|| ProjectError::Invalid("no parent folder".into()))?;
    let tmp = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all().ok();
    }
    let linked = std::fs::hard_link(&tmp, abs);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => {
            // No hard links on this file system: fall back to an exclusive create.
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(abs)
            {
                Ok(mut f) => {
                    f.write_all(content.as_bytes())?;
                    Ok(true)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(e.into()),
            }
        }
    }
}

/// The `AGENTS.md` written when the user gave no instructions.
pub fn agents_md_template(name: &str) -> String {
    format!(
        "# {name}\n\nInstructions for the agent working in this project. Edit freely.\n\n- Goal:\n- Where to put new notes:\n- Conventions to follow:\n"
    )
}

fn agents_md_content(name: &str, instructions: &str) -> String {
    let t = instructions.trim();
    if t.is_empty() {
        agents_md_template(name)
    } else {
        format!("{t}\n")
    }
}

fn join_sources(items: &[String]) -> Res<String> {
    let mut parts = Vec::new();
    for i in items {
        let i = i.trim();
        if i.is_empty() {
            continue;
        }
        if i.contains(['\n', '\r']) {
            return Err(ProjectError::Invalid(
                "a context source cannot span lines".into(),
            ));
        }
        if i.contains(',') {
            return Err(ProjectError::Invalid(format!(
                "a context source cannot contain a comma: {i}"
            )));
        }
        parts.push(i);
    }
    Ok(parts.join(","))
}

fn single_line(label: &str, s: &str) -> Res<String> {
    let s = s.trim();
    if s.contains(['\n', '\r']) {
        return Err(ProjectError::Invalid(format!("{label} must be one line")));
    }
    Ok(s.to_string())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn set(text: &str, key: &str, value: Json) -> Res<String> {
    Ok(patch::set_property(text, key, &value, None)?)
}

/// Set `key` to `value` when `valid`, remove it for the empty string, else refuse. Removing a key
/// that is not there is not an error.
fn set_or_remove(
    text: &str,
    key: &str,
    value: &str,
    valid: fn(&str) -> bool,
    expected: &str,
) -> Res<String> {
    if value.is_empty() {
        return match patch::remove_property(text, key) {
            Ok(t) => Ok(t),
            Err(PatchError::NotFound(_)) => Ok(text.to_string()),
            Err(e) => Err(e.into()),
        };
    }
    if !valid(value) {
        return Err(ProjectError::Invalid(format!(
            "{key} must be {expected}, not {value}"
        )));
    }
    set(text, key, Json::from(value))
}

/// `project.md` text for a brand new project.
fn render_project_md(
    id: &str,
    name: &str,
    description: &str,
    inclusions: &str,
    now: i64,
) -> Res<String> {
    let mut t = String::new();
    t = set(&t, KEY_ID, Json::from(id))?;
    t = set(&t, KEY_NAME, Json::from(name))?;
    t = set(&t, KEY_DESCRIPTION, Json::from(description))?;
    t = set(&t, KEY_CREATED, Json::from(now))?;
    t = set(&t, KEY_LAST_USED, Json::from(now))?;
    if !inclusions.is_empty() {
        t = set(&t, KEY_INCLUSIONS, Json::from(inclusions))?;
    }
    t.push_str(&format!("\n# {name}\n"));
    Ok(t)
}

fn relative_join(parent: &str, name: &str) -> String {
    let parent = parent.trim().trim_matches('/');
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// Create a new project folder with `project.md` and `AGENTS.md`. The folder must not exist
/// (a duplicate name is an error, never a merge). On a failed write the folder it made is
/// removed again.
pub fn create(root: &Path, req: &NewProjectRequest, now_ms: i64) -> Res<WriteReport> {
    let root = root.canonicalize()?;
    let name = sanitize_name(&req.name)?;
    let description = single_line("the description", &req.description)?;
    let inclusions = join_sources(&req.inclusions)?;
    let parent = req
        .parent
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(DEFAULT_PARENT);
    let rel = relative_join(parent, &name);
    let c = confine_dir(&root, &rel)?;
    if c.abs.exists() {
        return Err(ProjectError::Exists(format!(
            "{} already exists; pick another name or use Make project on that folder",
            c.rel
        )));
    }
    let parent_abs = c
        .abs
        .parent()
        .ok_or_else(|| ProjectError::Invalid("no parent folder".into()))?;
    std::fs::create_dir_all(parent_abs)?;
    // Re-confine after creating the parents: a symlink in the chain is now resolvable.
    let c = confine_dir(&root, &rel)?;
    std::fs::create_dir(&c.abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            ProjectError::Exists(format!("{} already exists", c.rel))
        } else {
            e.into()
        }
    })?;
    let project_md = render_project_md(&new_id(), &name, &description, &inclusions, now_ms)?;
    let result = (|| -> Res<()> {
        if !create_new_file(&c.abs.join(PROJECT_FILE), &project_md)? {
            return Err(ProjectError::Exists(PROJECT_FILE.into()));
        }
        create_new_file(
            &c.abs.join(AGENTS_FILE),
            &agents_md_content(&name, &req.instructions),
        )?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(c.abs.join(PROJECT_FILE));
        let _ = std::fs::remove_file(c.abs.join(AGENTS_FILE));
        let _ = std::fs::remove_dir(&c.abs);
        return Err(e);
    }
    Ok(WriteReport {
        project: read(&root, &c.rel)?,
        created_project_md: true,
        created_agents_md: true,
        filled_keys: vec![],
    })
}

/// Options of [`make_with`]. `description` and `inclusions` are applied only to keys the folder's
/// `project.md` does not already have.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct MakeOptions {
    pub create_agents_md: bool,
    /// Seeds a new `AGENTS.md`; empty means the template. Ignored when one exists.
    pub instructions: String,
    pub description: String,
    pub inclusions: Vec<String>,
}

/// [`make_with`] with defaults: template `AGENTS.md` when `create_agents_md`.
pub fn make(root: &Path, rel: &str, create_agents_md: bool, now_ms: i64) -> Res<WriteReport> {
    make_with(
        root,
        rel,
        &MakeOptions {
            create_agents_md,
            ..Default::default()
        },
        now_ms,
    )
}

/// "Make project" on an existing folder. Idempotent and never destructive:
///
/// - no `project.md`: it is written;
/// - a `project.md` without `copilot-project-id` (or missing name / created): only the missing
///   keys are added, the body and every other key stay byte-identical;
/// - a complete `project.md`: nothing is written;
/// - `AGENTS.md` is created only when absent and `create_agents_md` is set; an existing
///   `AGENTS.md` or `CLAUDE.md` is never touched.
pub fn make_with(root: &Path, rel: &str, opts: &MakeOptions, now_ms: i64) -> Res<WriteReport> {
    let root = root.canonicalize()?;
    let c = confine_dir(&root, rel)?;
    if !c.abs.is_dir() {
        return Err(ProjectError::NotFound(format!("{} is not a folder", c.rel)));
    }
    let description = single_line("the description", &opts.description)?;
    let inclusions = join_sources(&opts.inclusions)?;
    let folder_name = c.rel.rsplit('/').next().unwrap_or(&c.rel).to_string();
    let mut created_project_md = false;
    let mut filled_keys = Vec::new();
    let project_file = c.abs.join(PROJECT_FILE);
    match read_project_md(&c.abs)? {
        None => {
            let text =
                render_project_md(&new_id(), &folder_name, &description, &inclusions, now_ms)?;
            if create_new_file(&project_file, &text)? {
                created_project_md = true;
                filled_keys = vec![KEY_ID.into(), KEY_NAME.into(), KEY_CREATED.into()];
            }
        }
        Some(text) => {
            let props = props_map(&text)?;
            let present = |k: &str| {
                text_value(props.get(k))
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
            };
            let mut next = text.clone();
            let mut wanted: Vec<(&str, Json)> = vec![
                (KEY_ID, Json::from(new_id())),
                (KEY_NAME, Json::from(folder_name.clone())),
                (KEY_CREATED, Json::from(now_ms)),
            ];
            if !description.is_empty() {
                wanted.push((KEY_DESCRIPTION, Json::from(description.clone())));
            }
            if !inclusions.is_empty() {
                wanted.push((KEY_INCLUSIONS, Json::from(inclusions.clone())));
            }
            for (key, value) in wanted {
                if !present(key) {
                    next = set(&next, key, value)?;
                    filled_keys.push(key.to_string());
                }
            }
            if next != text {
                vault_ops::write_text(&project_file, &next)?;
            }
        }
    }
    let mut created_agents = false;
    if opts.create_agents_md {
        let name = read(&root, &c.rel)
            .map(|d| d.info.name)
            .unwrap_or(folder_name);
        created_agents = create_new_file(
            &c.abs.join(AGENTS_FILE),
            &agents_md_content(&name, &opts.instructions),
        )?;
    }
    Ok(WriteReport {
        project: read(&root, &c.rel)?,
        created_project_md,
        created_agents_md: created_agents,
        filled_keys,
    })
}

/// Apply a partial update to `project.md` (key-preserving patches). The project must already
/// be a project; use [`make`] to adopt a plain folder.
pub fn update(root: &Path, rel: &str, up: &ProjectUpdate, now_ms: i64) -> Res<ProjectDetail> {
    let root = root.canonicalize()?;
    let c = confine_dir(&root, rel)?;
    let text = read_project_md(&c.abs)?
        .ok_or_else(|| ProjectError::NotFound(format!("{} has no {PROJECT_FILE}", c.rel)))?;
    if parse_project_md(&text, &c.rel, &c.abs)?.is_none() {
        return Err(ProjectError::NotFound(format!(
            "{} is not a project; use Make project first",
            c.rel
        )));
    }
    let mut next = text.clone();
    if let Some(n) = &up.name {
        let n = single_line("the name", n)?;
        if n.is_empty() {
            return Err(ProjectError::Invalid("the project needs a name".into()));
        }
        next = set(&next, KEY_NAME, Json::from(n))?;
    }
    if let Some(d) = &up.description {
        next = set(
            &next,
            KEY_DESCRIPTION,
            Json::from(single_line("the description", d)?),
        )?;
    }
    if let Some(i) = &up.inclusions {
        next = set(&next, KEY_INCLUSIONS, Json::from(join_sources(i)?))?;
    }
    if let Some(e) = &up.exclusions {
        next = set(&next, KEY_EXCLUSIONS, Json::from(join_sources(e)?))?;
    }
    if let Some(u) = &up.web_urls {
        next = set(&next, KEY_WEB_URLS, Json::from(join_sources(u)?))?;
    }
    if let Some(u) = &up.youtube_urls {
        next = set(&next, KEY_YOUTUBE_URLS, Json::from(join_sources(u)?))?;
    }
    if let Some(m) = &up.agent_mode {
        match m.as_str() {
            "" => {
                next = match patch::remove_property(&next, KEY_AGENT_MODE) {
                    Ok(t) => t,
                    Err(PatchError::NotFound(_)) => next,
                    Err(e) => return Err(e.into()),
                }
            }
            "manual" | "acceptEdits" => next = set(&next, KEY_AGENT_MODE, Json::from(m.as_str()))?,
            other => {
                return Err(ProjectError::Invalid(format!(
                    "agent mode must be manual or acceptEdits, not {other}"
                )))
            }
        }
    }
    if let Some(i) = &up.icon {
        next = set_or_remove(
            &next,
            KEY_ICON,
            i,
            valid_icon,
            "an icon name like Rocket01Icon",
        )?;
    }
    if let Some(c) = &up.color {
        next = set_or_remove(
            &next,
            KEY_COLOR,
            c,
            valid_color,
            "one of the project colors",
        )?;
    }
    if up.touch_last_used {
        next = set(&next, KEY_LAST_USED, Json::from(now_ms))?;
    }
    if next != text {
        vault_ops::write_text(&c.abs.join(PROJECT_FILE), &next)?;
    }
    read(&root, &c.rel)
}

/// Archive (`archived = true`: sets `copilot-project-archived-at`) or restore a project.
pub fn archive(root: &Path, rel: &str, archived: bool, now_ms: i64) -> Res<ProjectDetail> {
    let root = root.canonicalize()?;
    let c = confine_dir(&root, rel)?;
    let text = read_project_md(&c.abs)?
        .ok_or_else(|| ProjectError::NotFound(format!("{} has no {PROJECT_FILE}", c.rel)))?;
    if parse_project_md(&text, &c.rel, &c.abs)?.is_none() {
        return Err(ProjectError::NotFound(format!(
            "{} is not a project",
            c.rel
        )));
    }
    let next = if archived {
        set(&text, KEY_ARCHIVED, Json::from(now_ms))?
    } else {
        match patch::remove_property(&text, KEY_ARCHIVED) {
            Ok(t) => t,
            Err(PatchError::NotFound(_)) => text.clone(),
            Err(e) => return Err(e.into()),
        }
    };
    if next != text {
        vault_ops::write_text(&c.abs.join(PROJECT_FILE), &next)?;
    }
    read(&root, &c.rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault() -> (TempDir, PathBuf) {
        let d = TempDir::new().unwrap();
        let r = d.path().canonicalize().unwrap();
        (d, r)
    }

    fn req(name: &str) -> NewProjectRequest {
        NewProjectRequest {
            name: name.into(),
            parent: None,
            description: "A demo".into(),
            inclusions: vec!["Notes/".into(), "#client".into()],
            instructions: String::new(),
        }
    }

    const NOW: i64 = 1_796_000_000_000;

    #[test]
    fn create_writes_project_md_and_agents_md() {
        let (_d, root) = vault();
        let rep = create(&root, &req("Client X"), NOW).unwrap();
        assert_eq!(rep.project.info.path, "Projects/Client X");
        assert_eq!(rep.project.info.name, "Client X");
        assert_eq!(rep.project.info.description, "A demo");
        assert_eq!(rep.project.info.created_at, Some(NOW));
        assert!(rep.project.info.has_agents_md);
        assert!(!rep.project.info.id.is_empty());
        assert_eq!(rep.project.info.inclusions.len(), 2);
        let agents = std::fs::read_to_string(root.join("Projects/Client X/AGENTS.md")).unwrap();
        assert!(agents.starts_with("# Client X\n"));
        let md = std::fs::read_to_string(root.join("Projects/Client X/project.md")).unwrap();
        assert!(md.starts_with("---\n"));
        assert!(md.contains("copilot-project-id:"));
        assert!(
            md.contains("copilot-project-inclusions: \"Notes/,#client\"")
                || md.contains("copilot-project-inclusions: Notes/,#client")
        );
        // No stray temp files.
        let names: Vec<_> = std::fs::read_dir(root.join("Projects/Client X"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn create_uses_given_instructions_and_parent() {
        let (_d, root) = vault();
        let mut r = req("Plan");
        r.parent = Some("Work/Clients".into());
        r.instructions = "Always answer in French.\n\n".into();
        let rep = create(&root, &r, NOW).unwrap();
        assert_eq!(rep.project.info.path, "Work/Clients/Plan");
        let agents = std::fs::read_to_string(root.join("Work/Clients/Plan/AGENTS.md")).unwrap();
        assert_eq!(agents, "Always answer in French.\n");
    }

    #[test]
    fn duplicate_name_is_refused_and_leaves_the_folder_alone() {
        let (_d, root) = vault();
        create(&root, &req("Dup"), NOW).unwrap();
        let before = std::fs::read(root.join("Projects/Dup/AGENTS.md")).unwrap();
        let err = create(&root, &req("Dup"), NOW).unwrap_err();
        assert!(matches!(err, ProjectError::Exists(_)), "{err}");
        assert_eq!(
            std::fs::read(root.join("Projects/Dup/AGENTS.md")).unwrap(),
            before
        );
        // An existing plain folder of the same name is a duplicate too.
        std::fs::create_dir_all(root.join("Projects/Plain")).unwrap();
        assert!(matches!(
            create(&root, &req("Plain"), NOW).unwrap_err(),
            ProjectError::Exists(_)
        ));
    }

    #[test]
    fn name_sanitizing() {
        assert_eq!(sanitize_name("  My   Project ").unwrap(), "My Project");
        assert_eq!(sanitize_name("a:b*c?").unwrap(), "a-b-c-");
        assert_eq!(sanitize_name("end.").unwrap(), "end");
        assert!(sanitize_name("").is_err());
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("a\\b").is_err());
        assert!(sanitize_name(".hidden").is_err());
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name("bad\nname").is_err());
        assert_eq!(
            sanitize_name(&"x".repeat(300)).unwrap().chars().count(),
            100
        );
    }

    #[test]
    fn traversal_and_protected_paths_are_refused() {
        let (_d, root) = vault();
        let mut r = req("Ok");
        r.parent = Some("../outside".into());
        assert!(create(&root, &r, NOW).is_err());
        // A leading slash means "from the vault root", never the file system root.
        r.parent = Some("/etc".into());
        create(&root, &r, NOW).unwrap();
        assert!(root.join("etc/Ok/project.md").exists());
        assert!(!Path::new("/etc/Ok").exists());
        r.parent = Some(".obsidian/plugins".into());
        assert!(create(&root, &r, NOW).is_err());
        r.parent = Some(".hidden".into());
        assert!(create(&root, &r, NOW).is_err());
        assert!(make(&root, "../x", true, NOW).is_err());
        assert!(make(&root, ".git", true, NOW).is_err());
        assert!(resolve_cwd(&root, Some("../x")).is_err());
        assert!(!root.parent().unwrap().join("outside").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_refused() {
        let (_d, root) = vault();
        let (_o, outside) = vault();
        std::os::unix::fs::symlink(&outside, root.join("Link")).unwrap();
        let mut r = req("Escape");
        r.parent = Some("Link".into());
        assert!(create(&root, &r, NOW).is_err());
        assert!(make(&root, "Link", true, NOW).is_err());
        assert!(resolve_cwd(&root, Some("Link")).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn make_on_plain_folder_then_idempotent() {
        let (_d, root) = vault();
        std::fs::create_dir_all(root.join("Research/Topic")).unwrap();
        let rep = make(&root, "Research/Topic", true, NOW).unwrap();
        assert!(rep.created_project_md && rep.created_agents_md);
        assert_eq!(rep.project.info.name, "Topic");
        let md1 = std::fs::read(root.join("Research/Topic/project.md")).unwrap();
        let ag1 = std::fs::read(root.join("Research/Topic/AGENTS.md")).unwrap();
        let rep2 = make(&root, "Research/Topic", true, NOW + 5).unwrap();
        assert!(!rep2.created_project_md && !rep2.created_agents_md);
        assert!(rep2.filled_keys.is_empty());
        assert_eq!(rep2.project.info.id, rep.project.info.id);
        assert_eq!(
            std::fs::read(root.join("Research/Topic/project.md")).unwrap(),
            md1
        );
        assert_eq!(
            std::fs::read(root.join("Research/Topic/AGENTS.md")).unwrap(),
            ag1
        );
    }

    #[test]
    fn make_never_overwrites_agents_or_claude_md() {
        let (_d, root) = vault();
        let dir = root.join("Docs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "my rules \u{e9}\r\n").unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "claude rules").unwrap();
        let rep = make(&root, "Docs", true, NOW).unwrap();
        assert!(!rep.created_agents_md);
        assert!(rep.project.info.has_agents_md && rep.project.info.has_claude_md);
        assert_eq!(
            std::fs::read(dir.join("AGENTS.md")).unwrap(),
            "my rules \u{e9}\r\n".as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.join("CLAUDE.md")).unwrap(),
            b"claude rules"
        );
    }

    #[test]
    fn make_without_agents_option_leaves_it_absent() {
        let (_d, root) = vault();
        std::fs::create_dir_all(root.join("F")).unwrap();
        let rep = make(&root, "F", false, NOW).unwrap();
        assert!(!rep.created_agents_md);
        assert!(!root.join("F/AGENTS.md").exists());
    }

    #[test]
    fn make_adopts_existing_project_md_and_fills_only_missing_keys() {
        let (_d, root) = vault();
        let dir = root.join("copilot/projects/Old");
        std::fs::create_dir_all(&dir).unwrap();
        let original = "---\r\n# my comment\r\nzeta: 1\r\ncopilot-project-description: 'keep me'\r\ntags: [a, b]\r\n---\r\nBody text stays.\r\n";
        std::fs::write(dir.join("project.md"), original).unwrap();
        let rep = make(&root, "copilot/projects/Old", false, NOW).unwrap();
        assert!(!rep.created_project_md);
        assert_eq!(
            rep.filled_keys,
            vec![
                KEY_ID.to_string(),
                KEY_NAME.to_string(),
                KEY_CREATED.to_string()
            ]
        );
        assert_eq!(rep.project.info.description, "keep me");
        let after = std::fs::read_to_string(dir.join("project.md")).unwrap();
        // Every original line is still there, byte for byte, in order.
        let mut cursor = 0;
        for line in original
            .split_inclusive("\r\n")
            .filter(|l| !l.starts_with("---"))
        {
            let at = after[cursor..]
                .find(line)
                .unwrap_or_else(|| panic!("lost {line:?} in {after:?}"));
            cursor += at + line.len();
        }
        assert!(after.ends_with("Body text stays.\r\n"));
    }

    #[test]
    fn make_with_applies_description_sources_and_instructions_without_overwriting() {
        let (_d, root) = vault();
        std::fs::create_dir_all(root.join("W")).unwrap();
        let rep = make_with(
            &root,
            "W",
            &MakeOptions {
                create_agents_md: true,
                instructions: "Use bullet points.".into(),
                description: "Work stuff".into(),
                inclusions: vec!["#work".into()],
            },
            NOW,
        )
        .unwrap();
        assert_eq!(rep.project.info.description, "Work stuff");
        assert_eq!(rep.project.info.inclusions.len(), 1);
        assert_eq!(
            std::fs::read_to_string(root.join("W/AGENTS.md")).unwrap(),
            "Use bullet points.\n"
        );
        // Second run with other values changes nothing.
        let md = std::fs::read(root.join("W/project.md")).unwrap();
        make_with(
            &root,
            "W",
            &MakeOptions {
                create_agents_md: true,
                instructions: "other".into(),
                description: "other".into(),
                inclusions: vec!["#other".into()],
            },
            NOW + 1,
        )
        .unwrap();
        assert_eq!(std::fs::read(root.join("W/project.md")).unwrap(), md);
        assert_eq!(
            std::fs::read_to_string(root.join("W/AGENTS.md")).unwrap(),
            "Use bullet points.\n"
        );
    }

    #[test]
    fn make_keeps_an_existing_id() {
        let (_d, root) = vault();
        let dir = root.join("P");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "---\ncopilot-project-id: abc-123\ncopilot-project-name: Named\ncopilot-project-created: 5\n---\n";
        std::fs::write(dir.join("project.md"), text).unwrap();
        let rep = make(&root, "P", false, NOW).unwrap();
        assert!(rep.filled_keys.is_empty());
        assert_eq!(rep.project.info.id, "abc-123");
        assert_eq!(
            std::fs::read_to_string(dir.join("project.md")).unwrap(),
            text
        );
    }

    #[test]
    fn make_refuses_unparsable_frontmatter_without_touching_it() {
        let (_d, root) = vault();
        let dir = root.join("Bad");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "---\nkey: [unclosed\nother: : :\n---\nbody\n";
        std::fs::write(dir.join("project.md"), text).unwrap();
        assert!(make(&root, "Bad", true, NOW).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("project.md")).unwrap(),
            text
        );
        assert!(!dir.join("AGENTS.md").exists());
    }

    #[test]
    fn parses_a_copilot_shaped_project() {
        let (_d, root) = vault();
        let dir = root.join("copilot/projects/Alpha");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "---\n\
copilot-project-id: proj_17abc\n\
copilot-project-name: Alpha\n\
copilot-project-description: First one\n\
copilot-project-created: 1700000000000\n\
copilot-project-last-used: 1700000005000\n\
copilot-project-archived-at: 1700000009000\n\
copilot-project-inclusions: \"Folder/Sub/, [[Some Note]], #tag/nested, status:open, kind:*, file.pdf\"\n\
copilot-project-exclusions: Folder/Sub/Private/\n\
copilot-project-web-urls: \"https://example.com/a\\nhttps://example.com/b\"\n\
copilot-project-youtube-urls: \"https://youtu.be/xyz\"\n\
custom: value\n---\nfree notes\n";
        std::fs::write(dir.join("project.md"), text).unwrap();
        let p = read(&root, "copilot/projects/Alpha").unwrap();
        assert_eq!(p.info.id, "proj_17abc");
        assert_eq!(p.info.last_used_at, Some(1_700_000_005_000));
        assert_eq!(p.info.archived_at, Some(1_700_000_009_000));
        assert_eq!(p.info.inclusions.len(), 5);
        assert!(
            matches!(&p.info.inclusions[0], ProjectSource::Folder { path, .. } if path == "Folder/Sub")
        );
        assert!(
            matches!(&p.info.inclusions[1], ProjectSource::Note { path, .. } if path == "Some Note.md")
        );
        assert!(
            matches!(&p.info.inclusions[2], ProjectSource::Tag { tag, .. } if tag == "tag/nested")
        );
        assert!(
            matches!(&p.info.inclusions[3], ProjectSource::Property { name, value: Some(v), .. } if name == "status" && v == "open")
        );
        assert!(matches!(
            &p.info.inclusions[4],
            ProjectSource::Property { value: None, .. }
        ));
        assert_eq!(p.unsupported, vec!["file.pdf".to_string()]);
        assert_eq!(p.youtube_urls, vec!["https://youtu.be/xyz".to_string()]);
        assert_eq!(p.web_urls.len(), 2);
        assert_eq!(p.info.exclusions.len(), 1);
        // list finds it, archived hidden by default
        assert!(list(&root, false).unwrap().is_empty());
        assert_eq!(list(&root, true).unwrap().len(), 1);
    }

    #[test]
    fn source_shapes() {
        let (s, u) =
            parse_sources("a/b, ../etc, /abs, [[x/../y]], file.pdf, #, https://a.b/c, k:v");
        assert_eq!(s.len(), 3, "{s:?}");
        assert!(matches!(&s[0], ProjectSource::Folder { path, .. } if path == "a/b"));
        assert!(matches!(&s[1], ProjectSource::Url { .. }));
        assert!(matches!(&s[2], ProjectSource::Property { .. }));
        assert_eq!(u.len(), 5, "{u:?}");
    }

    #[test]
    fn icon_and_color_round_trip_and_leave_copilot_keys_alone() {
        let (_d, root) = vault();
        let dir = root.join("I");
        std::fs::create_dir_all(&dir).unwrap();
        let head = "---\ncopilot-project-id: id1\ncopilot-project-name: I\ncopilot-project-description: 'keep me'   # c\ncopilot-project-inclusions: \"Notes/,#client\"\n";
        std::fs::write(dir.join("project.md"), format!("{head}---\nbody\n")).unwrap();
        let up = ProjectUpdate {
            icon: Some("Rocket01Icon".into()),
            color: Some("blue".into()),
            ..Default::default()
        };
        let p = update(&root, "I", &up, NOW).unwrap();
        assert_eq!(p.icon.as_deref(), Some("Rocket01Icon"));
        assert_eq!(p.color.as_deref(), Some("blue"));
        let after = std::fs::read_to_string(dir.join("project.md")).unwrap();
        assert!(after.starts_with(head), "{after}");
        assert!(after.contains("writer-project-icon: Rocket01Icon"));
        assert!(after.contains("writer-project-color: blue"));
        assert!(after.ends_with("---\nbody\n"));
        // reset removes both keys and restores the original bytes
        let up = ProjectUpdate {
            icon: Some(String::new()),
            color: Some(String::new()),
            ..Default::default()
        };
        let p = update(&root, "I", &up, NOW).unwrap();
        assert_eq!((p.icon, p.color), (None, None));
        let after = std::fs::read_to_string(dir.join("project.md")).unwrap();
        assert_eq!(after, format!("{head}---\nbody\n"));
        // removing again is a no-op
        assert!(update(&root, "I", &up, NOW).is_ok());
    }

    #[test]
    fn unknown_color_and_bad_icon_are_rejected() {
        let (_d, root) = vault();
        create(&root, &req("Pick"), NOW).unwrap();
        for up in [
            ProjectUpdate {
                color: Some("#ff0000".into()),
                ..Default::default()
            },
            ProjectUpdate {
                color: Some("chartreuse".into()),
                ..Default::default()
            },
            ProjectUpdate {
                icon: Some("rocket".into()),
                ..Default::default()
            },
            ProjectUpdate {
                icon: Some("../Icon".into()),
                ..Default::default()
            },
        ] {
            assert!(matches!(
                update(&root, "Projects/Pick", &up, NOW),
                Err(ProjectError::Invalid(_))
            ));
        }
        let p = read(&root, "Projects/Pick").unwrap();
        assert_eq!((p.icon, p.color), (None, None));
    }

    #[test]
    fn a_hand_written_bad_value_is_a_warning_not_a_crash() {
        let text = "---\ncopilot-project-id: x\nwriter-project-color: chartreuse\nwriter-project-icon: nope\n---\n";
        let d = parse_project_md(text, "X", Path::new("/nonexistent"))
            .unwrap()
            .unwrap();
        assert_eq!((d.icon.as_deref(), d.color.as_deref()), (None, None));
        assert_eq!(d.warnings.len(), 2);
    }

    #[test]
    fn the_color_list_is_the_shared_one() {
        assert_eq!(project_colors().len(), 8);
        assert!(project_colors().iter().all(|c| valid_color(c)));
    }

    #[test]
    fn update_round_trips_unknown_keys_and_body() {
        let (_d, root) = vault();
        let dir = root.join("U");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "---\nextra: [1, 2]   # note\ncopilot-project-id: id1\ncopilot-project-name: U\n---\nbody\n";
        std::fs::write(dir.join("project.md"), text).unwrap();
        let up = ProjectUpdate {
            description: Some("Has: colon".into()),
            inclusions: Some(vec!["Notes/".into()]),
            agent_mode: Some("acceptEdits".into()),
            touch_last_used: true,
            ..Default::default()
        };
        let p = update(&root, "U", &up, NOW).unwrap();
        assert_eq!(p.info.description, "Has: colon");
        assert_eq!(p.agent_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(p.info.last_used_at, Some(NOW));
        let after = std::fs::read_to_string(dir.join("project.md")).unwrap();
        assert!(after.contains("extra: [1, 2]   # note\n"));
        assert!(after.ends_with("---\nbody\n"));
        // removing the mode
        let up = ProjectUpdate {
            agent_mode: Some(String::new()),
            ..Default::default()
        };
        assert_eq!(update(&root, "U", &up, NOW).unwrap().agent_mode, None);
        assert!(update(
            &root,
            "U",
            &ProjectUpdate {
                agent_mode: Some("bypassPermissions".into()),
                ..Default::default()
            },
            NOW
        )
        .is_err());
        assert!(update(
            &root,
            "U",
            &ProjectUpdate {
                inclusions: Some(vec!["a,b".into()]),
                ..Default::default()
            },
            NOW
        )
        .is_err());
    }

    #[test]
    fn archive_and_restore() {
        let (_d, root) = vault();
        create(&root, &req("Arc"), NOW).unwrap();
        let p = archive(&root, "Projects/Arc", true, NOW + 1).unwrap();
        assert_eq!(p.info.archived_at, Some(NOW + 1));
        assert!(list(&root, false).unwrap().is_empty());
        let p = archive(&root, "Projects/Arc", false, NOW + 2).unwrap();
        assert_eq!(p.info.archived_at, None);
        assert_eq!(list(&root, false).unwrap().len(), 1);
        // restoring a non-archived project is a no-op
        archive(&root, "Projects/Arc", false, NOW + 3).unwrap();
    }

    #[test]
    fn list_skips_hidden_dirs_and_non_projects_and_sorts_by_last_use() {
        let (_d, root) = vault();
        create(&root, &req("Old"), NOW).unwrap();
        create(&root, &req("New"), NOW + 100).unwrap();
        // project.md without an id is not a project
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/project.md"), "---\ntitle: x\n---\n").unwrap();
        // inside a dot folder
        std::fs::create_dir_all(root.join(".hidden/P")).unwrap();
        std::fs::write(
            root.join(".hidden/P/project.md"),
            "---\ncopilot-project-id: z\n---\n",
        )
        .unwrap();
        // a project.md at the vault root is not a folder project
        std::fs::write(
            root.join("project.md"),
            "---\ncopilot-project-id: root\n---\n",
        )
        .unwrap();
        let names: Vec<_> = list(&root, false)
            .unwrap()
            .into_iter()
            .map(|p| p.info.name)
            .collect();
        assert_eq!(names, vec!["New", "Old"]);
    }

    #[test]
    fn resolve_cwd_handles_root_and_projects() {
        let (_d, root) = vault();
        assert_eq!(resolve_cwd(&root, None).unwrap(), root);
        assert_eq!(resolve_cwd(&root, Some("")).unwrap(), root);
        create(&root, &req("C"), NOW).unwrap();
        assert_eq!(
            resolve_cwd(&root, Some("Projects/C")).unwrap(),
            root.join("Projects/C")
        );
        assert!(matches!(
            resolve_cwd(&root, Some("Projects/Nope")).unwrap_err(),
            ProjectError::NotFound(_)
        ));
    }

    #[test]
    fn write_preserves_when_agents_md_exists_race() {
        // create_new_file never replaces an existing file.
        let (_d, root) = vault();
        let f = root.join("x.md");
        assert!(create_new_file(&f, "one").unwrap());
        assert!(!create_new_file(&f, "two").unwrap());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "one");
    }
}
