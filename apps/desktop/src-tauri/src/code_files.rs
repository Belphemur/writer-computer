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

/// The defaults of the list settings come from the settings schema, the one place they live.
fn schema_default_list(key: &str) -> Vec<String> {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../shared/settings.schema.json"))
            .expect("settings.schema.json is valid");
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

pub const SETTING_EXTENSIONS: &str = "files.code-extensions";
pub const SETTING_IGNORED: &str = "files.ignored-folders";
pub const SETTING_AGENT_FOLDERS: &str = "files.show-agent-folders";

/// Folders that are hidden whatever the setting says.
const ALWAYS_HIDDEN: &[&str] = &["node_modules", ".DS_Store"];

#[derive(Debug, Clone)]
pub struct Policy {
    pub extensions: HashSet<String>,
    pub ignored_folders: HashSet<String>,
    pub show_agent_folders: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            extensions: schema_default_list(SETTING_EXTENSIONS)
                .into_iter()
                .collect(),
            ignored_folders: schema_default_list(SETTING_IGNORED).into_iter().collect(),
            show_agent_folders: true,
        }
    }
}

static POLICY: LazyLock<RwLock<Policy>> = LazyLock::new(|| RwLock::new(Policy::default()));

pub fn policy() -> Policy {
    POLICY.read().clone()
}

pub fn set_policy(policy: Policy) {
    *POLICY.write() = policy;
}

/// Build a policy from the raw setting values; `None` keeps the default for that key.
pub fn policy_from_settings(
    extensions: Option<Vec<String>>,
    ignored: Option<Vec<String>>,
    show_agent_folders: Option<bool>,
) -> Policy {
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
    is_code_name_with(&POLICY.read(), name)
}

pub fn is_code_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_code_name)
}

/// A listed file: a note, a `.base`, or a code file.
pub fn is_listed_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".base") || is_code_name(name)
}

/// SQL predicate over `files.ext` / `files.name` selecting the listed rows (md, base, code).
pub fn listed_sql_predicate() -> String {
    let p = POLICY.read();
    let mut exts: Vec<String> = vec!["md".into(), "base".into()];
    let mut code: Vec<&String> = p.extensions.iter().collect();
    code.sort();
    exts.extend(code.into_iter().cloned());
    let list = exts
        .iter()
        .map(|e| format!("'{}'", e.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let names = SHARED
        .file_names
        .iter()
        .map(|n| format!("'{}'", n.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    format!("(ext IN ({list}) OR name IN ({names}))")
}

/// True when the SQL row (`name`, lowercase `ext`) is listed. The Rust twin of
/// [`listed_sql_predicate`], used by tests and in-memory filters.
pub fn is_listed_row(name: &str, ext: &str) -> bool {
    if ext == "md" || ext == "base" {
        return true;
    }
    if is_secret_name(name) {
        return false;
    }
    SHARED.file_names.iter().any(|n| n == name) || POLICY.read().extensions.contains(ext)
}

/// Is a vault-relative path (`.agents/skills/x/run.py`) visible: no hidden segment except the
/// `skills` subtree of `.agents` / `.claude` (when `files.show-agent-folders`), nothing in the
/// ignored-folder list, never `node_modules`.
///
/// `is_dir` only matters for the top-level `.agents` / `.claude` directory itself.
pub fn rel_is_visible(rel: &Path) -> bool {
    rel_is_visible_with(&POLICY.read(), rel)
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

/// Does any segment of `rel` name an ignored folder (the `files.ignored-folders` list)?
pub fn rel_in_ignored_folder(rel: &Path) -> bool {
    let p = POLICY.read();
    rel.components().any(|c| {
        p.ignored_folders
            .contains(c.as_os_str().to_string_lossy().as_ref())
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
            Some(vec![".PEM".into(), "env".into(), "py".into(), "md".into()]),
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
        let off = policy_from_settings(None, None, Some(false));
        assert!(!rel_is_visible_with(
            &off,
            Path::new(".agents/skills/x/run.py")
        ));
        let on = policy_from_settings(None, None, Some(true));
        assert!(rel_is_visible_with(
            &on,
            Path::new(".agents/skills/x/run.py")
        ));
        // a custom ignore list replaces the default one
        let custom = policy_from_settings(None, Some(vec!["gen".into()]), None);
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
        assert!(!sql.contains("'svg'") && !sql.contains("'env'"));
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
}
