//! Plugin secrets (`app.secretStorage`) in the operating system's credential store:
//! macOS Keychain, Windows Credential Manager, Linux Secret Service (via the `keyring`
//! crate). Nothing is ever written to disk by Writer.
//!
//! Layout: one credential per secret (`secret:<id>`; Windows caps a credential blob at a
//! few KB, so one blob for everything would not scale) plus an index credential
//! (`__index__`, a JSON array of ids) because credential stores cannot be enumerated
//! portably. The service name derives from the app identifier, so the e2e build (a
//! different identifier) never touches the real keychain. Secrets are shared by every
//! plugin and vault of the user, like Obsidian's keychain: that sharing is the API's point.
//!
//! Order of writes keeps the index a superset of what exists: set = secret then index;
//! delete = index then secret. A crash in between leaves an orphan secret, never an id
//! that points at nothing the user can see.

use parking_lot::Mutex;
use std::collections::BTreeMap;

const INDEX_ACCOUNT: &str = "__index__";
const MAX_ID_LEN: usize = 256;
/// Windows Credential Manager rejects larger blobs; a longer "secret" is not a key anyway.
const MAX_SECRET_BYTES: usize = 2048;
const MAX_SECRETS: usize = 256;

pub trait SecretBackend: Send + Sync {
    /// `Ok(None)` when the credential does not exist.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// Deleting a missing credential is not an error.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The OS credential store through `keyring`.
pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: String) -> Self {
        Self { service }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|e| e.to_string())
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub struct PluginSecrets {
    backend: Box<dyn SecretBackend>,
    /// Serialises read-modify-write of the index.
    lock: Mutex<()>,
}

fn account(id: &str) -> String {
    format!("secret:{id}")
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN || id.chars().any(|c| c.is_control()) {
        return Err("EINVAL: secret id must be 1-256 characters without control characters".into());
    }
    Ok(())
}

impl PluginSecrets {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self {
            backend,
            lock: Mutex::new(()),
        }
    }

    /// Service name for this build: the app identifier keeps dev, e2e and release apart.
    pub fn service_name(app_identifier: &str) -> String {
        format!("{app_identifier}.plugin-secrets")
    }

    fn read_index(&self) -> Result<Vec<String>, String> {
        match self.backend.get(INDEX_ACCOUNT)? {
            None => Ok(Vec::new()),
            // A corrupt index is an error, not an empty list: writing over it would orphan
            // every secret the user has.
            Some(raw) => serde_json::from_str(&raw)
                .map_err(|e| format!("EIO: the secret index is unreadable: {e}")),
        }
    }

    fn write_index(&self, ids: &[String]) -> Result<(), String> {
        let raw = serde_json::to_string(ids).map_err(|e| e.to_string())?;
        self.backend.set(INDEX_ACCOUNT, &raw)
    }

    /// Every secret as `id -> value`. A secret listed in the index but gone from the store
    /// is skipped.
    pub fn load_all(&self) -> Result<BTreeMap<String, String>, String> {
        let _g = self.lock.lock();
        let mut out = BTreeMap::new();
        for id in self.read_index()? {
            if let Some(v) = self.backend.get(&account(&id))? {
                out.insert(id, v);
            }
        }
        Ok(out)
    }

    /// Ids of the secrets that exist, sorted. Values are read only to drop index entries whose
    /// credential is gone, and never leave this function: the Settings UI lists names only.
    pub fn list_ids(&self) -> Result<Vec<String>, String> {
        let _g = self.lock.lock();
        let mut out = Vec::new();
        for id in self.read_index()? {
            if self.backend.get(&account(&id))?.is_some() {
                out.push(id);
            }
        }
        out.sort();
        Ok(out)
    }

    pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
        check_id(id)?;
        if value.len() > MAX_SECRET_BYTES {
            return Err(format!(
                "EINVAL: a secret is limited to {MAX_SECRET_BYTES} bytes"
            ));
        }
        let _g = self.lock.lock();
        let mut ids = self.read_index()?;
        let known = ids.iter().any(|i| i == id);
        if !known && ids.len() >= MAX_SECRETS {
            return Err(format!("EINVAL: at most {MAX_SECRETS} secrets"));
        }
        self.backend.set(&account(id), value)?;
        if !known {
            ids.push(id.to_string());
            self.write_index(&ids)?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        let _g = self.lock.lock();
        let mut ids = self.read_index()?;
        if ids.iter().any(|i| i == id) {
            ids.retain(|i| i != id);
            self.write_index(&ids)?;
        }
        self.backend.delete(&account(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default, Clone)]
    struct Fake {
        map: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl SecretBackend for Fake {
        fn get(&self, a: &str) -> Result<Option<String>, String> {
            Ok(self.map.lock().get(a).cloned())
        }
        fn set(&self, a: &str, v: &str) -> Result<(), String> {
            self.map.lock().insert(a.into(), v.into());
            Ok(())
        }
        fn delete(&self, a: &str) -> Result<(), String> {
            self.map.lock().remove(a);
            Ok(())
        }
    }

    fn secrets() -> (PluginSecrets, Fake) {
        let f = Fake::default();
        (PluginSecrets::new(Box::new(f.clone())), f)
    }

    #[test]
    fn set_load_overwrite_delete() {
        let (s, _) = secrets();
        assert!(s.load_all().unwrap().is_empty());
        s.set("openai", "k1").unwrap();
        s.set("anthropic", "k2").unwrap();
        s.set("openai", "k3").unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["openai"], "k3");
        s.delete("openai").unwrap();
        s.delete("openai").unwrap();
        assert_eq!(
            s.load_all().unwrap().keys().collect::<Vec<_>>(),
            ["anthropic"]
        );
    }

    #[test]
    fn list_ids_returns_sorted_names_only_for_secrets_that_exist() {
        let (s, f) = secrets();
        assert!(s.list_ids().unwrap().is_empty());
        s.set("zeta", "v").unwrap();
        s.set("alpha", "v").unwrap();
        s.set("gone", "v").unwrap();
        f.delete(&account("gone")).unwrap();
        assert_eq!(s.list_ids().unwrap(), ["alpha", "zeta"]);
        s.delete("alpha").unwrap();
        assert_eq!(s.list_ids().unwrap(), ["zeta"]);
    }

    #[test]
    fn list_ids_fails_on_a_corrupt_index() {
        let (s, f) = secrets();
        f.set(INDEX_ACCOUNT, "{not json").unwrap();
        assert!(s.list_ids().is_err());
    }

    #[test]
    fn survives_a_new_instance_over_the_same_store() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        let again = PluginSecrets::new(Box::new(f));
        assert_eq!(again.load_all().unwrap()["a"], "1");
    }

    #[test]
    fn validates_ids_and_sizes() {
        let (s, _) = secrets();
        assert!(s.set("", "x").is_err());
        assert!(s.set("bad\nid", "x").is_err());
        assert!(s.set(&"a".repeat(257), "x").is_err());
        assert!(s.set("big", &"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert!(s.set("ok", &"x".repeat(MAX_SECRET_BYTES)).is_ok());
    }

    #[test]
    fn caps_the_number_of_secrets() {
        let (s, _) = secrets();
        for i in 0..MAX_SECRETS {
            s.set(&format!("id{i}"), "v").unwrap();
        }
        assert!(s.set("one-more", "v").is_err());
        s.set("id0", "changed").unwrap();
    }

    #[test]
    fn a_corrupt_index_is_an_error_and_is_not_overwritten() {
        let (s, f) = secrets();
        f.set(INDEX_ACCOUNT, "{not json").unwrap();
        assert!(s.load_all().is_err());
        assert!(s.set("a", "1").is_err());
        assert_eq!(f.get(INDEX_ACCOUNT).unwrap().unwrap(), "{not json");
    }

    #[test]
    fn a_listed_but_missing_secret_is_skipped() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        s.set("b", "2").unwrap();
        f.delete(&account("a")).unwrap();
        assert_eq!(s.load_all().unwrap().keys().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn service_name_follows_the_app_identifier() {
        assert_ne!(
            PluginSecrets::service_name("com.writer-computer.e2e"),
            PluginSecrets::service_name("com.writer-computer.app")
        );
    }
}
