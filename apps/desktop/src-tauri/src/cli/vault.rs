//! Vault targeting: `vault=` (path, or a known recent workspace by name or
//! id), else the vault containing the working directory.

use crate::index::index_db_path;
use std::path::{Path, PathBuf};

/// Workspaces the app has opened (`recent_workspaces.json`, a JSON array of
/// paths in the app data directory). Read-only. A missing file is an empty
/// list; an unreadable or malformed one is an error.
pub fn load_recents(app_data_dir: &Path) -> Result<Vec<String>, String> {
    let p = app_data_dir.join("recent_workspaces.json");
    match std::fs::read_to_string(&p) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("cannot read {}: {e}", p.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("cannot read {}: {e}", p.display())),
    }
}

/// Folder name of a vault path.
pub fn vault_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// The id of a vault: the 16 hex characters in its index file name.
pub fn vault_id(app_data_dir: &Path, canonical_root: &Path) -> String {
    index_db_path(app_data_dir, canonical_root)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn looks_like_path(v: &str) -> bool {
    v.contains(['/', '\\']) || v == "." || v == ".." || v.starts_with('~')
}

fn expand_home(v: &str) -> PathBuf {
    if let Some(rest) = v.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(v)
}

fn canonical_dir(p: &Path) -> Result<PathBuf, String> {
    let c = p
        .canonicalize()
        .map_err(|e| format!("cannot open vault {}: {e}", p.display()))?;
    if c.is_dir() {
        Ok(c)
    } else {
        Err(format!("{} is not a directory", c.display()))
    }
}

/// Nearest ancestor of `cwd` (inclusive) that holds a `.obsidian` folder, else
/// `cwd` itself.
pub fn vault_from_cwd(cwd: &Path) -> Result<PathBuf, String> {
    let start = canonical_dir(cwd)?;
    for dir in start.ancestors() {
        if dir.join(".obsidian").is_dir() {
            return Ok(dir.to_path_buf());
        }
    }
    Ok(start)
}

/// Resolve the vault root (canonical).
pub fn resolve_vault(
    spec: Option<&str>,
    cwd: &Path,
    app_data_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let Some(spec) = spec else {
        return vault_from_cwd(cwd);
    };
    if looks_like_path(spec) {
        let p = expand_home(spec);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        return canonical_dir(&p);
    }
    let recents = match app_data_dir {
        Some(d) => load_recents(d)?,
        None => Vec::new(),
    };
    let known: Vec<PathBuf> = recents
        .iter()
        .filter_map(|r| Path::new(r).canonicalize().ok())
        .filter(|p| p.is_dir())
        .collect();
    if let Some(dir) = app_data_dir {
        if let Some(hit) = known.iter().find(|p| vault_id(dir, p) == spec) {
            return Ok(hit.clone());
        }
    }
    let by_name: Vec<&PathBuf> = known.iter().filter(|p| vault_name(p) == spec).collect();
    match by_name.as_slice() {
        [one] => return Ok((*one).clone()),
        [] => {}
        many => {
            return Err(format!(
                "several vaults are named \"{spec}\" ({}); use vault=<path> or vault=<id>",
                many.iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
    }
    // A folder of that name in the working directory.
    let local = cwd.join(spec);
    if local.is_dir() {
        return canonical_dir(&local);
    }
    Err(format!(
        "unknown vault \"{spec}\": not a recent Writer workspace by name or id, and no such folder here; pass vault=<path>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dirs() -> (TempDir, TempDir) {
        (TempDir::new().unwrap(), TempDir::new().unwrap())
    }

    #[test]
    fn default_is_nearest_obsidian_ancestor_else_cwd() {
        let (v, _) = dirs();
        let root = v.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        assert_eq!(vault_from_cwd(&root.join("a/b/c")).unwrap(), root);
        std::fs::create_dir_all(root.join("a/.obsidian")).unwrap();
        assert_eq!(vault_from_cwd(&root.join("a/b/c")).unwrap(), root.join("a"));
        let plain = TempDir::new().unwrap();
        let p = plain.path().canonicalize().unwrap();
        std::fs::create_dir_all(p.join("x")).unwrap();
        assert_eq!(vault_from_cwd(&p.join("x")).unwrap(), p.join("x"));
        assert!(vault_from_cwd(&p.join("missing")).is_err());
    }

    #[test]
    fn vault_by_path_name_and_id() {
        let (v, data) = dirs();
        let root = v.path().canonicalize().unwrap().join("My Vault");
        std::fs::create_dir_all(&root).unwrap();
        let other = TempDir::new().unwrap();
        std::fs::write(
            data.path().join("recent_workspaces.json"),
            serde_json::to_string(&[root.to_string_lossy(), "/gone/away".into()]).unwrap(),
        )
        .unwrap();
        let cwd = other.path();
        let d = Some(data.path());
        assert_eq!(
            resolve_vault(Some(root.to_str().unwrap()), cwd, d).unwrap(),
            root
        );
        assert_eq!(resolve_vault(Some("My Vault"), cwd, d).unwrap(), root);
        let id = vault_id(data.path(), &root);
        assert_eq!(id.len(), 16);
        assert_eq!(resolve_vault(Some(&id), cwd, d).unwrap(), root);
        assert!(resolve_vault(Some("nope"), cwd, d)
            .unwrap_err()
            .contains("unknown vault"));
        // a folder in the working directory
        std::fs::create_dir_all(cwd.join("local")).unwrap();
        assert_eq!(
            resolve_vault(Some("local"), cwd, d).unwrap(),
            cwd.canonicalize().unwrap().join("local")
        );
        // relative path
        assert_eq!(
            resolve_vault(Some("./local"), cwd, d).unwrap(),
            cwd.canonicalize().unwrap().join("local")
        );
    }

    #[test]
    fn ambiguous_names_and_bad_recents_fail_explicitly() {
        let (v, data) = dirs();
        let base = v.path().canonicalize().unwrap();
        let a = base.join("one/Notes");
        let b = base.join("two/Notes");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            data.path().join("recent_workspaces.json"),
            serde_json::to_string(&[a.to_string_lossy(), b.to_string_lossy()]).unwrap(),
        )
        .unwrap();
        let err = resolve_vault(Some("Notes"), &base, Some(data.path())).unwrap_err();
        assert!(err.contains("several vaults"));
        std::fs::write(data.path().join("recent_workspaces.json"), "{oops").unwrap();
        assert!(resolve_vault(Some("Notes"), &base, Some(data.path())).is_err());
        // an explicit path never needs the recents file
        assert!(resolve_vault(Some(a.to_str().unwrap()), &base, Some(data.path())).is_ok());
    }
}
