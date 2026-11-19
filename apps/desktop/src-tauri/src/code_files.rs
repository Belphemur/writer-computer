//! Code and text files in the vault (spec: `SPECs/code-files-spec.md`).
//!
//! Writer is also a notebook for agents, and a vault holds agent skills with
//! scripts next to their `SKILL.md`. This module is the one place that decides
//! which vault paths the sidebar, the file index, the watcher and quick open
//! surface beyond notes: a configurable set of code/text extensions, a list of
//! bulky or generated folders to keep out, and the narrow exception to the
//! dot-folder hiding for `.agents/skills` and `.claude/skills`.
//!
//! Tauri-free. The policy is process-wide (one app, any number of windows) and
//! the app pushes the settings into it; the `writer` CLI uses the defaults.
//!
//! This module is the one seam between core and the built-in feature `code-files`
//! (`features/code-files/`, spec `SPECs/builtin-plugins-spec.md` section 15). Every caller (the
//! sidebar listing, the index walker, the watcher, `NameCache`, `relocate`, the agent's change
//! snapshots) asks the functions below and never reads a setting or the feature switch; the
//! feature's Rust half derives the [`Policy`] from the settings and the switch and pushes it
//! here. Switched off, the policy is [`Policy::notes_only`]: notes, bases and images only,
//! the skills folders hidden, no ignored-folder list: what Writer listed before code files.

use parking_lot::RwLock;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

/// The rules both sides share (`shared/code-files.json`, twin `src/lib/code-files.ts`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shared {
    max_read_bytes: u64,
    read_only_bytes: u64,
    binary_sniff_bytes: usize,
    file_names: Vec<String>,
    never_extensions: Vec<String>,
    secret_name_words: Vec<String>,
    secret_key_prefixes: Vec<String>,
}

static SHARED: LazyLock<Shared> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../shared/code-files.json"))
        .expect("shared/code-files.json is valid")
});

/// The defaults of the list settings come from the feature's settings fragment, the one place
/// they live (the web side reads the same file).
fn schema_default_list(key: &str) -> Vec<String> {
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../features/code-files/settings.schema.json"
    ))
    .expect("code-files settings.schema.json is valid");
    schema["settings"]
        .as_array()
        .and_then(|all| all.iter().find(|s| s["key"] == key))
        .and_then(|s| s["default"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Above this a file is never read (`read_file` refuses it).
pub fn max_read_bytes() -> u64 {
    SHARED.max_read_bytes
}
/// Above this the editor opens a code file read-only.
pub fn read_only_bytes() -> u64 {
    SHARED.read_only_bytes
}

pub const SETTING_EXTENSIONS: &str = "code-files.extensions";
pub const SETTING_IGNORED: &str = "code-files.ignored-folders";
pub const SETTING_AGENT_FOLDERS: &str = "code-files.show-agent-folders";
/// Images are core (the image viewer and attachments), not a code-files setting.
pub const SETTING_IMAGES: &str = "files.show-images";
/// PDFs are core too (the reader is the `pdf` feature, the listing is not).
pub const SETTING_PDFS: &str = "files.show-pdfs";

/// Folders that are hidden whatever the setting says.
const ALWAYS_HIDDEN: &[&str] = &["node_modules", ".DS_Store"];

#[derive(Debug, Clone)]
pub struct Policy {
    /// List and open code/text files (the feature `code-files` is on). Off: no extension and no
    /// file name counts as code, whatever the lists below say.
    pub code: bool,
    pub extensions: HashSet<String>,
    pub ignored_folders: HashSet<String>,
    pub show_agent_folders: bool,
    /// List the renderable image files (`shared/attachments.json`) in the tree and quick open.
    pub show_images: bool,
    /// List the document files (`documentExtensions` of `shared/attachments.json`, PDFs).
    pub show_pdfs: bool,
}

impl Policy {
    /// What is listed with the feature `code-files` off: notes, bases and (setting on) images.
    /// No code, no skills folders, no ignored-folder list (`node_modules` stays hidden).
    pub fn notes_only() -> Self {
        Policy {
            code: false,
            extensions: HashSet::new(),
            ignored_folders: HashSet::new(),
            show_agent_folders: false,
            show_images: true,
            show_pdfs: true,
        }
    }
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            code: true,
            extensions: schema_default_list(SETTING_EXTENSIONS)
                .into_iter()
                .collect(),
            ignored_folders: schema_default_list(SETTING_IGNORED).into_iter().collect(),
            show_agent_folders: true,
            show_images: true,
            show_pdfs: true,
        }
    }
}

static POLICY: LazyLock<RwLock<Policy>> = LazyLock::new(|| RwLock::new(Policy::default()));

#[cfg(test)]
thread_local! {
    /// A policy for the calling thread only, so a test can run under the off policy without
    /// racing the tests that read the process-wide one.
    static TEST_POLICY: std::cell::RefCell<Option<Policy>> = const { std::cell::RefCell::new(None) };
}

/// Run `f` with `policy` as this thread's policy (tests only).
#[cfg(test)]
pub(crate) fn with_policy_for_test<T>(policy: Policy, f: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_POLICY.with(|p| *p.borrow_mut() = None);
        }
    }
    TEST_POLICY.with(|p| *p.borrow_mut() = Some(policy));
    let _reset = Reset;
    f()
}

/// Run `f` over the current policy without cloning it.
fn with_current<T>(f: impl FnOnce(&Policy) -> T) -> T {
    #[cfg(test)]
    if let Some(p) = TEST_POLICY.with(|p| p.borrow().clone()) {
        return f(&p);
    }
    f(&POLICY.read())
}

pub fn policy() -> Policy {
    with_current(Policy::clone)
}

pub fn set_policy(policy: Policy) {
    *POLICY.write() = policy;
}

/// Build a policy from the raw setting values; `None` keeps the default for that key. With the
/// feature off (`enabled` false) only `show_images` and `show_pdfs` (core settings) count:
/// [`Policy::notes_only`].
pub fn policy_from_settings(
    enabled: bool,
    extensions: Option<Vec<String>>,
    ignored: Option<Vec<String>>,
    show_agent_folders: Option<bool>,
    show_images: Option<bool>,
    show_pdfs: Option<bool>,
) -> Policy {
    if !enabled {
        let mut p = Policy::notes_only();
        if let Some(b) = show_images {
            p.show_images = b;
        }
        if let Some(b) = show_pdfs {
            p.show_pdfs = b;
        }
        return p;
    }
    let mut p = Policy::default();
    if let Some(list) = extensions {
        p.extensions = list
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty() && !is_never_extension(e))
            .collect();
    }
    if let Some(list) = ignored {
        p.ignored_folders = list
            .iter()
            .map(|f| f.trim().trim_matches('/').to_string())
            .filter(|f| !f.is_empty())
            .collect();
    }
    if let Some(b) = show_agent_folders {
        p.show_agent_folders = b;
    }
    if let Some(b) = show_images {
        p.show_images = b;
    }
    if let Some(b) = show_pdfs {
        p.show_pdfs = b;
    }
    p
}

/// Extensions no setting can enable: secrets and formats that open elsewhere.
fn is_never_extension(ext: &str) -> bool {
    SHARED.never_extensions.iter().any(|e| e == ext)
}

fn ext_of(name: &str) -> Option<String> {
    let i = name.rfind('.')?;
    if i == 0 || i + 1 == name.len() {
        return None;
    }
    Some(name[i + 1..].to_lowercase())
}

/// Secret-looking names are never listed, opened as text or indexed, whatever the extension
/// setting says: `.env*`, private keys, and names saying they hold credentials.
pub fn is_secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") || lower.ends_with(".env") {
        return true;
    }
    if SHARED
        .secret_key_prefixes
        .iter()
        .any(|p| lower.starts_with(p.as_str()))
    {
        return true;
    }
    let stem = lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&lower);
    SHARED
        .secret_name_words
        .iter()
        .any(|w| stem.contains(w.as_str()))
}

/// Does `name` (a file name, not a path) open as a code/text file under `policy`?
pub fn is_code_name_with(policy: &Policy, name: &str) -> bool {
    if !policy.code {
        return false;
    }
    if name.starts_with('.') && name.len() > 1 && ext_of(name).is_none() {
        // dotfiles without an extension (`.env`, `.gitignore`, `.bashrc`) are never code files
        return false;
    }
    if is_secret_name(name) {
        return false;
    }
    if SHARED.file_names.iter().any(|n| n == name) {
        return true;
    }
    ext_of(name).is_some_and(|e| policy.extensions.contains(&e))
}

pub fn is_code_name(name: &str) -> bool {
    with_current(|p| is_code_name_with(p, name))
}

pub fn is_code_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_code_name)
}

/// Does `name` open in the image viewer under `policy`: a renderable image extension and
/// `files.show-images` on. The extension list is `renderExtensions` of `shared/attachments.json`.
pub fn is_image_name_with(policy: &Policy, name: &str) -> bool {
    policy.show_images
        && ext_of(name).is_some_and(|e| crate::attachments::render_extensions().contains(&e))
}

/// Does `name` open in the PDF reader under `policy`: a document extension and `files.show-pdfs`
/// on. The extension list is `documentExtensions` of `shared/attachments.json`.
pub fn is_document_name_with(policy: &Policy, name: &str) -> bool {
    policy.show_pdfs
        && ext_of(name).is_some_and(|e| crate::attachments::document_extensions().contains(&e))
}

/// Extensions listed whatever the settings: notes, Bases, and Excalidraw's plain `.excalidraw`
/// drawings (the `.excalidraw.md` ones are notes). The one list the three listing rules below and
/// `index::names::LISTED_EXTS` share.
pub const ALWAYS_LISTED_EXTS: [&str; 3] = ["md", "base", "excalidraw"];

/// A listed file: a note, a `.base`, a drawing, a code file, or (setting on) an image or a PDF.
pub fn is_listed_name(name: &str) -> bool {
    ext_of(name).is_some_and(|e| ALWAYS_LISTED_EXTS.contains(&e.as_str()))
        || with_current(|p| {
            is_code_name_with(p, name)
                || is_image_name_with(p, name)
                || is_document_name_with(p, name)
        })
}

/// [`is_listed_name`] for a path (its file name).
pub fn is_listed_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_listed_name)
}

/// SQL predicate over `files.ext` / `files.name` selecting the listed rows (md, base, code, images).
pub fn listed_sql_predicate() -> String {
    with_current(listed_sql_predicate_with)
}

/// [`listed_sql_predicate`] under an explicit policy.
pub fn listed_sql_predicate_with(p: &Policy) -> String {
    let mut exts: Vec<String> = ALWAYS_LISTED_EXTS.iter().map(|e| e.to_string()).collect();
    if p.code {
        let mut code: Vec<&String> = p.extensions.iter().collect();
        code.sort();
        exts.extend(code.into_iter().cloned());
    }
    if p.show_images {
        exts.extend(crate::attachments::render_extensions().iter().cloned());
    }
    if p.show_pdfs {
        exts.extend(crate::attachments::document_extensions().iter().cloned());
    }
    let list = exts
        .iter()
        .map(|e| format!("'{}'", e.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let code_names: &[String] = if p.code { &SHARED.file_names } else { &[] };
    let names = code_names
        .iter()
        .map(|n| format!("'{}'", n.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    format!("(ext IN ({list}) OR name IN ({names}))")
}

/// True when the SQL row (`name`, lowercase `ext`) is listed. The Rust twin of
/// [`listed_sql_predicate`], used by tests and in-memory filters.
pub fn is_listed_row(name: &str, ext: &str) -> bool {
    with_current(|p| is_listed_row_with(p, name, ext))
}

/// [`is_listed_row`] under an explicit policy.
pub fn is_listed_row_with(p: &Policy, name: &str, ext: &str) -> bool {
    if ALWAYS_LISTED_EXTS.contains(&ext) {
        return true;
    }
    if p.show_images
        && crate::attachments::render_extensions()
            .iter()
            .any(|e| e == ext)
    {
        return true;
    }
    if p.show_pdfs
        && crate::attachments::document_extensions()
            .iter()
            .any(|e| e == ext)
    {
        return true;
    }
    if !p.code || is_secret_name(name) {
        return false;
    }
    SHARED.file_names.iter().any(|n| n == name) || p.extensions.contains(ext)
}

/// Is a vault-relative path (`.agents/skills/x/run.py`) visible: no hidden segment except the
/// `skills` subtree of `.agents` / `.claude` (when `code-files.show-agent-folders`), nothing in the
/// ignored-folder list, never `node_modules`.
///
/// `is_dir` only matters for the top-level `.agents` / `.claude` directory itself.
pub fn rel_is_visible(rel: &Path) -> bool {
    with_current(|p| rel_is_visible_with(p, rel))
}

/// [`rel_is_visible`] under an explicit policy.
pub fn rel_is_visible_with(p: &Policy, rel: &Path) -> bool {
    let mut first: Option<String> = None;
    for (index, name) in rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .enumerate()
    {
        let name = name.as_ref();
        if ALWAYS_HIDDEN.contains(&name) {
            return false;
        }
        if (name.starts_with('.') && name.len() > 1) || name == ".." {
            let agent_root = index == 0 && (name == ".agents" || name == ".claude");
            if !(agent_root && p.show_agent_folders) {
                return false;
            }
        } else if index == 1 {
            // second segment under `.agents` / `.claude` must be `skills`
            if matches!(first.as_deref(), Some(".agents") | Some(".claude")) && name != "skills" {
                return false;
            }
        }
        if index == 0 {
            first = Some(name.to_string());
        }
        // The dot-folders in the default ignore list (`.venv`, `.next`...) are dot-hidden
        // already; the others hide by name at any depth.
        if p.ignored_folders.contains(name) {
            return false;
        }
    }
    true
}

/// Does any segment of `rel` name an ignored folder (the `code-files.ignored-folders` list)?
pub fn rel_in_ignored_folder(rel: &Path) -> bool {
    with_current(|p| {
        rel.components().any(|c| {
            p.ignored_folders
                .contains(c.as_os_str().to_string_lossy().as_ref())
        })
    })
}

/// Is `rel` the top-level `.agents` or `.claude` directory (shown only when it holds `skills/`)?
pub fn is_agent_root_rel(rel: &Path) -> bool {
    let mut c = rel.components();
    match (c.next(), c.next()) {
        (Some(a), None) => matches!(a.as_os_str().to_str(), Some(".agents") | Some(".claude")),
        _ => false,
    }
}

/// Is the vault-relative path inside an agent skills tree (`.agents/skills/...`)?
pub fn is_agent_skill_rel(rel: &Path) -> bool {
    let mut c = rel.components().map(|c| c.as_os_str().to_string_lossy());
    matches!(
        (c.next().as_deref(), c.next().as_deref()),
        (Some(".agents") | Some(".claude"), Some("skills"))
    )
}

/// NUL byte in the first 8 KiB (`binarySniffBytes`): not text.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .take(SHARED.binary_sniff_bytes)
        .any(|b| *b == 0)
}

/// Read a code file as text, refusing what must not open: too large, binary, invalid UTF-8.
pub fn read_text_guarded(path: &Path) -> Result<String, GuardError> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|e| GuardError::Io(e.to_string()))?;
    if meta.len() > max_read_bytes() {
        return Err(GuardError::TooLarge(meta.len()));
    }
    let mut file = std::fs::File::open(path).map_err(|e| GuardError::Io(e.to_string()))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| GuardError::Io(e.to_string()))?;
    if looks_binary(&bytes) {
        return Err(GuardError::Binary);
    }
    String::from_utf8(bytes).map_err(|_| GuardError::NotUtf8)
}

#[derive(Debug, PartialEq, Eq)]
pub enum GuardError {
    TooLarge(u64),
    Binary,
    NotUtf8,
    Io(String),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::TooLarge(n) => write!(
                f,
                "File is too large to open ({} MiB; the limit is {} MiB)",
                n / (1024 * 1024),
                max_read_bytes() / (1024 * 1024)
            ),
            GuardError::Binary => write!(f, "Binary file: not opened as text"),
            GuardError::NotUtf8 => write!(f, "File is not valid UTF-8: not opened as text"),
            GuardError::Io(m) => write!(f, "{m}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn code_names_by_extension_and_name() {
        for n in [
            "a.py",
            "a.TS",
            "x.tsx",
            "main.rs",
            "go.mod.go",
            "Dockerfile",
            "Makefile",
            "x.json",
            "run.sh",
            "notes.txt",
            "t.dockerfile",
        ] {
            assert!(is_code_name(n), "{n}");
        }
        for n in [
            "a.png",
            "a.svg",
            "a.ipynb",
            "a.pdf",
            "noext",
            "a.md",
            ".env",
            ".env.local",
            "prod.env",
            "a.pem",
            "id_rsa",
            "secrets.yaml",
            "aws-credentials.json",
            ".bashrc",
            "a.zip",
        ] {
            assert!(!is_code_name(n), "{n}");
        }
    }

    #[test]
    fn settings_cannot_enable_secrets_or_notes() {
        let p = policy_from_settings(
            true,
            Some(vec![".PEM".into(), "env".into(), "py".into(), "md".into()]),
            None,
            None,
            None,
            None,
        );
        assert!(p.extensions.contains("py"));
        assert_eq!(p.extensions.len(), 1);
        assert!(!is_code_name_with(&p, "a.rs"));
    }

    #[test]
    fn visibility_rules() {
        let v = |s: &str| rel_is_visible(Path::new(s));
        assert!(v("notes/a.md"));
        assert!(v("scripts/run.py"));
        assert!(!v(".obsidian/app.json"));
        assert!(!v(".git/HEAD"));
        assert!(!v(".chats/x.json"));
        assert!(!v(".writer/config"));
        assert!(!v(".hidden/x.py"));
        assert!(!v("a/.hidden/x.py"));
        assert!(!v("node_modules/x/index.js"));
        assert!(!v("proj/target/debug/x.rs"));
        assert!(!v("web/dist/app.js"));
        assert!(!v("api/__pycache__/x.py"));
        assert!(!v(".venv/lib/x.py"));
        // the agent exception
        assert!(v(".agents"));
        assert!(v(".agents/skills"));
        assert!(v(".agents/skills/x/run.py"));
        assert!(v(".claude/skills/x/SKILL.md"));
        assert!(!v(".claude/settings.json"));
        assert!(!v(".claude/settings.local.json"));
        assert!(!v(".agents/other/x.py"));
        assert!(!v(".agents/skills/x/.env"));
        assert!(!v(".agents/skills/x/.git/config"));
        assert!(!v("sub/.agents/skills/x/run.py"));
        assert!(!v(".agents/skills/x/node_modules/a.js"));
    }

    #[test]
    fn agent_exception_follows_the_setting() {
        let off = policy_from_settings(true, None, None, Some(false), None, None);
        assert!(!rel_is_visible_with(
            &off,
            Path::new(".agents/skills/x/run.py")
        ));
        let on = policy_from_settings(true, None, None, Some(true), None, None);
        assert!(rel_is_visible_with(
            &on,
            Path::new(".agents/skills/x/run.py")
        ));
        // a custom ignore list replaces the default one
        let custom = policy_from_settings(true, None, Some(vec!["gen".into()]), None, None, None);
        assert!(!rel_is_visible_with(&custom, Path::new("a/gen/x.py")));
        assert!(rel_is_visible_with(&custom, Path::new("a/dist/x.py")));
    }

    #[test]
    fn guarded_read_refuses_binary_and_invalid_utf8() {
        let dir = TempDir::new().unwrap();
        let ok = dir.path().join("a.py");
        fs::write(&ok, "print('hi')\n").unwrap();
        assert_eq!(read_text_guarded(&ok).unwrap(), "print('hi')\n");
        let bin = dir.path().join("b.py");
        fs::write(&bin, b"abc\0def").unwrap();
        assert_eq!(read_text_guarded(&bin), Err(GuardError::Binary));
        let bad = dir.path().join("c.py");
        fs::write(&bad, [0x66, 0xff, 0xfe, 0x41]).unwrap();
        assert_eq!(read_text_guarded(&bad), Err(GuardError::NotUtf8));
    }

    #[test]
    fn sql_predicate_lists_code_and_names() {
        let sql = listed_sql_predicate();
        assert!(sql.contains("'py'") && sql.contains("'md'") && sql.contains("'Dockerfile'"));
        // images are listed by default; never secrets or notebooks
        assert!(sql.contains("'svg'") && sql.contains("'png'"));
        assert!(!sql.contains("'env'") && !sql.contains("'ipynb'"));
    }

    #[test]
    fn defaults_come_from_the_schema_and_the_shared_file() {
        let p = Policy::default();
        assert!(p.extensions.contains("py") && p.extensions.contains("dockerfile"));
        assert!(!p.extensions.contains("svg") && !p.extensions.contains("ipynb"));
        assert!(p.ignored_folders.contains("node_modules") && p.ignored_folders.contains("target"));
        assert!(p.show_agent_folders);
        assert_eq!(max_read_bytes(), 20 * 1024 * 1024);
        assert_eq!(read_only_bytes(), 2 * 1024 * 1024);
    }

    #[test]
    fn images_are_listed_only_while_the_setting_is_on() {
        let on = policy_from_settings(true, None, None, None, Some(true), None);
        let off = policy_from_settings(true, None, None, None, Some(false), None);
        // the one list: `renderExtensions` of shared/attachments.json, case-blind
        for ext in crate::attachments::render_extensions() {
            for n in [format!("a.{ext}"), format!("B.{}", ext.to_uppercase())] {
                assert!(is_image_name_with(&on, &n), "{n}");
                assert!(!is_image_name_with(&off, &n), "{n}");
            }
        }
        assert!(is_image_name_with(&on, "a.svg") && is_image_name_with(&on, "a.heic"));
        // other files are not images
        for n in ["a.pdf", "png", ".png", "a.txt"] {
            assert!(!is_image_name_with(&on, n), "{n}");
        }
        // the default is on, and the SQL predicate follows the same list
        assert!(Policy::default().show_images);
        assert!(listed_sql_predicate_with(&on).contains("'png'"));
        assert!(is_listed_row_with(&on, "a.png", "png"));
        assert!(!listed_sql_predicate_with(&off).contains("'png'"));
        assert!(!is_listed_row_with(&off, "a.png", "png"));
        assert!(listed_sql_predicate_with(&on).contains("'heic'"));
    }

    #[test]
    fn pdfs_are_listed_only_while_the_setting_is_on() {
        let on = policy_from_settings(true, None, None, None, None, Some(true));
        let off = policy_from_settings(true, None, None, None, None, Some(false));
        // the one list: `documentExtensions` of shared/attachments.json, case-blind
        for ext in crate::attachments::document_extensions() {
            for n in [format!("a.{ext}"), format!("B.{}", ext.to_uppercase())] {
                assert!(is_document_name_with(&on, &n), "{n}");
                assert!(!is_document_name_with(&off, &n), "{n}");
            }
        }
        for n in ["a.png", "pdf", ".pdf", "a.txt"] {
            assert!(!is_document_name_with(&on, n), "{n}");
        }
        assert!(Policy::default().show_pdfs && Policy::notes_only().show_pdfs);
        assert!(listed_sql_predicate_with(&on).contains("'pdf'"));
        assert!(is_listed_row_with(&on, "a.pdf", "pdf"));
        assert!(!listed_sql_predicate_with(&off).contains("'pdf'"));
        assert!(!is_listed_row_with(&off, "a.pdf", "pdf"));
        // the feature switch does not hide PDFs: only their own setting does
        let notes_off = policy_from_settings(false, None, None, None, None, Some(false));
        assert!(!notes_off.show_pdfs);
        assert!(policy_from_settings(false, None, None, None, None, None).show_pdfs);
    }

    #[test]
    fn images_follow_the_folder_rules() {
        // hidden and ignored folders hide images exactly as they hide code
        let v = |s: &str| rel_is_visible(Path::new(s));
        assert!(v("attachments/a.png") && v("papers/a.pdf"));
        assert!(!v(".obsidian/a.png") && !v(".obsidian/a.pdf") && !v("node_modules/x/a.pdf"));
        assert!(!v("node_modules/x/a.png"));
        assert!(!v("dist/a.png"));
    }
}
