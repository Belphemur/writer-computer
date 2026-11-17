//! The "Always allow" rules the CLI persisted for a folder (spec 6.3): read and remove entries of
//! `permissions.allow` / `permissions.deny` in `<cwd>/.claude/settings.local.json`. Writer never
//! adds rules (the CLI does, through `updatedPermissions`) and never touches the user-level
//! `~/.claude/settings.json`. Tauri-free; other keys of the file are preserved (key order is
//! alphabetical after a rewrite, `serde_json` without `preserve_order`).

use crate::vault_ops::{self, VaultOpError};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const SETTINGS_REL: &str = ".claude/settings.local.json";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
pub struct PermissionRules {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

fn settings_path(root: &Path, project_path: Option<&str>) -> Result<PathBuf, VaultOpError> {
    let base = match project_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => root.to_path_buf(),
        Some(p) => vault_ops::confine(root, p)?.abs,
    };
    let rel = base.join(SETTINGS_REL);
    // Re-confine the final path so a `.claude` symlink cannot leave the vault.
    Ok(vault_ops::confine(root, rel.to_str().unwrap_or_default())?.abs)
}

fn read_json(path: &Path) -> Result<Option<Value>, VaultOpError> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(m) if m.len() > MAX_BYTES => {
            return Err(VaultOpError::Invalid(format!(
                "{SETTINGS_REL} is larger than 1 MiB"
            )))
        }
        Ok(_) => {}
    }
    let text = vault_ops::read_text(path)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| VaultOpError::Invalid(format!("{SETTINGS_REL} is not valid JSON: {e}")))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn read_rules(
    root: &Path,
    project_path: Option<&str>,
) -> Result<PermissionRules, VaultOpError> {
    let path = settings_path(root, project_path)?;
    let Some(json) = read_json(&path)? else {
        return Ok(PermissionRules::default());
    };
    let perms = json.get("permissions");
    Ok(PermissionRules {
        allow: strings(perms.and_then(|p| p.get("allow"))),
        deny: strings(perms.and_then(|p| p.get("deny"))),
    })
}

/// Remove `rule` from `permissions.allow` and `permissions.deny`. Errors when it is in neither.
pub fn remove_rule(
    root: &Path,
    project_path: Option<&str>,
    rule: &str,
) -> Result<(), VaultOpError> {
    let path = settings_path(root, project_path)?;
    let mut json = read_json(&path)?
        .ok_or_else(|| VaultOpError::NotFound(format!("{SETTINGS_REL} does not exist")))?;
    let mut removed = false;
    if let Some(perms) = json.get_mut("permissions").and_then(Value::as_object_mut) {
        for key in ["allow", "deny"] {
            if let Some(list) = perms.get_mut(key).and_then(Value::as_array_mut) {
                let before = list.len();
                list.retain(|x| x.as_str() != Some(rule));
                removed |= list.len() != before;
            }
        }
    }
    if !removed {
        return Err(VaultOpError::NotFound(format!("rule {rule}")));
    }
    let text =
        serde_json::to_string_pretty(&json).map_err(|e| VaultOpError::Invalid(e.to_string()))?;
    vault_ops::write_text(&path, &format!("{text}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault() -> (TempDir, PathBuf) {
        let d = TempDir::new().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("P/.claude")).unwrap();
        (d, root)
    }

    #[test]
    fn missing_file_means_no_rules() {
        let (_d, root) = vault();
        assert_eq!(read_rules(&root, None).unwrap(), PermissionRules::default());
    }

    #[test]
    fn reads_and_removes_rules_keeping_other_keys() {
        let (_d, root) = vault();
        std::fs::write(
            root.join("P/.claude/settings.local.json"),
            r#"{"model":"x","permissions":{"allow":["Bash(ls)","Edit"],"deny":["Bash(rm)"],"ask":["A"]}}"#,
        )
        .unwrap();
        let r = read_rules(&root, Some("P")).unwrap();
        assert_eq!(r.allow, ["Bash(ls)", "Edit"]);
        assert_eq!(r.deny, ["Bash(rm)"]);
        remove_rule(&root, Some("P"), "Bash(ls)").unwrap();
        remove_rule(&root, Some("P"), "Bash(rm)").unwrap();
        let after = read_rules(&root, Some("P")).unwrap();
        assert_eq!(after.allow, ["Edit"]);
        assert!(after.deny.is_empty());
        let raw = std::fs::read_to_string(root.join("P/.claude/settings.local.json")).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["model"], "x");
        assert_eq!(v["permissions"]["ask"][0], "A");
        assert!(matches!(
            remove_rule(&root, Some("P"), "nope"),
            Err(VaultOpError::NotFound(_))
        ));
    }

    #[test]
    fn refuses_paths_outside_the_vault_and_bad_json() {
        let (_d, root) = vault();
        assert!(read_rules(&root, Some("../x")).is_err());
        std::fs::write(root.join("P/.claude/settings.local.json"), "{nope").unwrap();
        assert!(matches!(
            read_rules(&root, Some("P")),
            Err(VaultOpError::Invalid(_))
        ));
        #[cfg(unix)]
        {
            let outside = TempDir::new().unwrap();
            std::fs::create_dir_all(outside.path().join(".claude")).unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
            assert!(read_rules(&root, Some("link")).is_err());
        }
    }
}
