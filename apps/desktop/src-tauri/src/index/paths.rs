//! Where the index lives and which vault paths it covers.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Release bundle identifier (`tauri.conf.json`). The `writer` CLI derives the
/// app data directory from it so it opens the same index files as the app. A
/// test asserts it equals the identifier in `tauri.conf.json`.
pub const RELEASE_IDENTIFIER: &str = "com.writer-computer";

/// Environment override for the app data directory (tests, sandboxes).
pub const INDEX_DIR_ENV: &str = "WRITER_INDEX_DIR";

/// `<app_data_dir>/index/<sha256(root)[0..16]>.sqlite3`. `canonical_root` must
/// already be canonical so the app and the CLI agree on the key.
pub fn index_db_path(app_data_dir: &Path, canonical_root: &Path) -> PathBuf {
    let digest = Sha256::digest(canonical_root.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    app_data_dir.join("index").join(format!("{hex}.sqlite3"))
}

/// The platform app data directory for `identifier`, mirroring Tauri's
/// `app_data_dir()` (`data_dir()/identifier`) without a Tauri handle.
pub fn platform_app_data_dir(identifier: &str) -> Result<PathBuf, String> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let base = if cfg!(target_os = "macos") {
        var("HOME")
            .map(|h| h.join("Library").join("Application Support"))
            .ok_or("HOME is not set")?
    } else if cfg!(windows) {
        var("APPDATA").ok_or("APPDATA is not set")?
    } else {
        match var("XDG_DATA_HOME") {
            Some(x) => x,
            None => var("HOME")
                .map(|h| h.join(".local").join("share"))
                .ok_or("neither XDG_DATA_HOME nor HOME is set")?,
        }
    };
    Ok(base.join(identifier))
}

/// App data directory for the headless CLI: `WRITER_INDEX_DIR` if set, else the
/// release identifier's platform directory.
pub fn cli_app_data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(INDEX_DIR_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    platform_app_data_dir(RELEASE_IDENTIFIER)
}

/// Is this vault-relative path covered by the index? Everything except hidden
/// segments (which covers `.obsidian`, `.git`, `.chats`, `.writer`, `.DS_Store`),
/// `node_modules` and the ignored-folder list, with the one exception of the
/// `skills` subtree of `.agents` / `.claude` (`code_files::rel_is_visible`).
pub fn is_indexable_rel(rel: &Path) -> bool {
    crate::code_files::rel_is_visible(rel)
}

/// Forward-slash relative path; `None` when the path is not valid UTF-8.
pub fn rel_to_string(rel: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for c in rel.components() {
        parts.push(c.as_os_str().to_str()?.to_string());
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_path_is_hashed_and_outside_vault() {
        let p = index_db_path(Path::new("/data"), Path::new("/vault"));
        assert_eq!(p.parent().unwrap(), Path::new("/data/index"));
        let name = p.file_name().unwrap().to_str().unwrap();
        assert_eq!(name.len(), 16 + ".sqlite3".len());
        assert_ne!(p, index_db_path(Path::new("/data"), Path::new("/vault2")));
    }

    #[test]
    fn indexable_rules() {
        assert!(is_indexable_rel(Path::new("a/b.md")));
        assert!(!is_indexable_rel(Path::new(".obsidian/app.json")));
        assert!(!is_indexable_rel(Path::new("a/.git/x")));
        assert!(!is_indexable_rel(Path::new("a/node_modules/x.md")));
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf = include_str!("../../tauri.conf.json");
        let v: serde_json::Value = serde_json::from_str(conf).unwrap();
        assert_eq!(v["identifier"], RELEASE_IDENTIFIER);
    }
}
