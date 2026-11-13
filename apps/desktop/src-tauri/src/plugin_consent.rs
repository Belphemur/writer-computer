//! "Always allow this program in this vault" memory for plugin processes.
//!
//! File: `<app_data>/plugins_proc_consent.json`, shape
//! `{ "<canonical vault path>": { "<plugin id>": ["<absolute program>", ...] } }`.
//! The key is the RESOLVED program path, never the arguments: the user allows
//! a program, and every spawn still emits an activity event.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type Map = BTreeMap<String, BTreeMap<String, Vec<String>>>;

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Remembered {
    pub plugin_id: String,
    pub program: String,
}

#[derive(Debug, Clone)]
pub struct ConsentStore {
    file: PathBuf,
}

fn vault_key(root: &Path) -> String {
    crate::plugins::trust_key(root)
}

impl ConsentStore {
    pub fn new(file: PathBuf) -> Self {
        Self { file }
    }

    fn read(&self) -> Map {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write(&self, map: &Map) -> Result<(), String> {
        let dir = self.file.parent().ok_or("bad consent file path")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("plugins consent: {e}"))?;
        let name = self
            .file
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("bad consent file path")?;
        let body = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        crate::plugins::write_atomic(dir, name, body.as_bytes())
    }

    pub fn is_allowed(&self, root: &Path, plugin_id: &str, program: &Path) -> bool {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let program = program.to_string_lossy();
        self.read()
            .get(&vault_key(root))
            .and_then(|m| m.get(plugin_id))
            .is_some_and(|v| v.iter().any(|p| *p == program))
    }

    pub fn allow(&self, root: &Path, plugin_id: &str, program: &Path) -> Result<(), String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read();
        let list = map
            .entry(vault_key(root))
            .or_default()
            .entry(plugin_id.to_string())
            .or_default();
        let program = program.to_string_lossy().into_owned();
        if !list.contains(&program) {
            list.push(program);
        }
        self.write(&map)
    }

    pub fn list(&self, root: &Path) -> Vec<Remembered> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read()
            .get(&vault_key(root))
            .into_iter()
            .flat_map(|m| m.iter())
            .flat_map(|(id, progs)| {
                progs.iter().map(|p| Remembered {
                    plugin_id: id.clone(),
                    program: p.clone(),
                })
            })
            .collect()
    }

    pub fn revoke(&self, root: &Path, plugin_id: &str, program: &str) -> Result<(), String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read();
        let key = vault_key(root);
        if let Some(m) = map.get_mut(&key) {
            if let Some(v) = m.get_mut(plugin_id) {
                v.retain(|p| p != program);
                if v.is_empty() {
                    m.remove(plugin_id);
                }
            }
            if m.is_empty() {
                map.remove(&key);
            }
        }
        self.write(&map)
    }

    /// Trust revoked: forget everything remembered for the vault.
    pub fn clear_vault(&self, root: &Path) -> Result<(), String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read();
        if map.remove(&vault_key(root)).is_some() {
            self.write(&map)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_list_revoke_clear() {
        let dir = tempfile::tempdir().unwrap();
        let s = ConsentStore::new(dir.path().join("c.json"));
        let v1 = dir.path().join("v1");
        let v2 = dir.path().join("v2");
        std::fs::create_dir_all(&v1).unwrap();
        std::fs::create_dir_all(&v2).unwrap();
        let prog = Path::new("/bin/sh");
        assert!(!s.is_allowed(&v1, "copilot", prog));
        s.allow(&v1, "copilot", prog).unwrap();
        s.allow(&v1, "copilot", prog).unwrap();
        s.allow(&v2, "copilot", Path::new("/bin/ls")).unwrap();
        assert!(s.is_allowed(&v1, "copilot", prog));
        assert!(!s.is_allowed(&v1, "other", prog), "per plugin");
        assert!(!s.is_allowed(&v2, "copilot", prog), "per vault");
        assert_eq!(
            s.list(&v1),
            vec![Remembered {
                plugin_id: "copilot".into(),
                program: "/bin/sh".into()
            }]
        );
        s.revoke(&v1, "copilot", "/bin/sh").unwrap();
        assert!(!s.is_allowed(&v1, "copilot", prog));
        s.allow(&v1, "copilot", prog).unwrap();
        s.clear_vault(&v1).unwrap();
        assert!(s.list(&v1).is_empty());
        assert!(
            s.is_allowed(&v2, "copilot", Path::new("/bin/ls")),
            "other vault kept"
        );
    }
}
