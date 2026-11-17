//! Plugin secrets (`app.secretStorage`) in the operating system's credential store:
//! macOS Keychain, Windows Credential Manager, Linux Secret Service (via the `keyring`
//! crate). Nothing is ever written to disk by Writer.
//!
//! Layout: ONE credential (account `secrets:v2`) holds a JSON document
//! `{"version":2,"secrets":{"<id>":"<value>"}}`. One item means one access, so a rebuilt
//! (ad-hoc signed) app triggers one Keychain password prompt instead of one per secret. The
//! document is read once per process into memory; every change writes the whole document
//! back, and the cache is updated only after that write succeeded. A failed read is never
//! cached, so a retry (after the user denied a prompt, or unlocked the keychain) just works.
//! There is no migration from the earlier one-item-per-secret layout (`secret:<id>` plus
//! `__index__`): those items are ignored and the user re-enters keys.
//!
//! A corrupt document is an error and is never overwritten. Errors never contain secret
//! values. The service name derives from the app identifier, so the e2e build (a different
//! identifier) never touches the real keychain. Secrets are shared by every plugin and vault
//! of the user, like Obsidian's keychain.
//!
//! Item size: macOS Keychain and the Linux Secret Service accept far more than we need;
//! Windows Credential Manager caps a blob at 2560 bytes and `keyring` stores UTF-16, so the
//! whole document is capped at 1280 UTF-8 bytes there and 64 KiB elsewhere.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const DOC_ACCOUNT: &str = "secrets:v2";
const DOC_VERSION: u32 = 2;
const MAX_ID_LEN: usize = 256;
const MAX_SECRET_BYTES: usize = 2048;
const MAX_SECRETS: usize = 256;
#[cfg(windows)]
const MAX_DOC_BYTES: usize = 1280;
#[cfg(not(windows))]
const MAX_DOC_BYTES: usize = 64 * 1024;

pub trait SecretBackend: Send + Sync {
    /// `Ok(None)` when the credential does not exist.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
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
}

type Secrets = BTreeMap<String, String>;

pub struct PluginSecrets {
    backend: Box<dyn SecretBackend>,
    /// The cached document (`None` until a read succeeded). Also serialises read-modify-write.
    cache: Mutex<Option<Secrets>>,
}

#[derive(Serialize, Deserialize)]
struct Doc {
    version: u32,
    secrets: Secrets,
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN || id.chars().any(|c| c.is_control()) {
        return Err("EINVAL: secret id must be 1-256 characters without control characters".into());
    }
    Ok(())
}

fn encode(secrets: &Secrets) -> Result<String, String> {
    let raw = serde_json::to_string(&Doc {
        version: DOC_VERSION,
        secrets: secrets.clone(),
    })
    .map_err(|_| "EIO: could not encode the secrets".to_string())?;
    if raw.len() > MAX_DOC_BYTES {
        return Err(format!(
            "EINVAL: all secrets together are limited to {MAX_DOC_BYTES} bytes by the system credential store"
        ));
    }
    Ok(raw)
}

impl PluginSecrets {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self {
            backend,
            cache: Mutex::new(None),
        }
    }

    /// Service name for this build: the app identifier keeps dev, e2e and release apart.
    pub fn service_name(app_identifier: &str) -> String {
        format!("{app_identifier}.plugin-secrets")
    }

    /// Reads the document into the cache if it is not there yet. A failed read leaves the
    /// cache empty so the next call tries again.
    fn loaded<'a>(&self, guard: &'a mut Option<Secrets>) -> Result<&'a mut Secrets, String> {
        if guard.is_none() {
            let secrets = match self.backend.get(DOC_ACCOUNT)? {
                None => Secrets::new(),
                // Corrupt = error, never empty: writing over it would destroy the user's keys.
                // The parse error is not echoed: it can quote document content.
                Some(raw) => match serde_json::from_str::<Doc>(&raw) {
                    Ok(d) if d.version == DOC_VERSION => d.secrets,
                    Ok(_) => return Err("EIO: the secret store has an unsupported version".into()),
                    Err(e) => {
                        return Err(format!(
                            "EIO: the secret store is unreadable (line {}, column {})",
                            e.line(),
                            e.column()
                        ))
                    }
                },
            };
            *guard = Some(secrets);
        }
        Ok(guard.as_mut().expect("just loaded"))
    }

    /// Every secret as `id -> value`.
    pub fn load_all(&self) -> Result<Secrets, String> {
        let mut g = self.cache.lock();
        Ok(self.loaded(&mut g)?.clone())
    }

    /// Ids of the secrets, sorted. The Settings UI lists names only.
    pub fn list_ids(&self) -> Result<Vec<String>, String> {
        let mut g = self.cache.lock();
        Ok(self.loaded(&mut g)?.keys().cloned().collect())
    }

    /// Writes `next` as the whole document, then makes it the cache.
    fn commit(&self, guard: &mut Option<Secrets>, next: Secrets) -> Result<(), String> {
        let raw = encode(&next)?;
        self.backend.set(DOC_ACCOUNT, &raw)?;
        *guard = Some(next);
        Ok(())
    }

    pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
        check_id(id)?;
        if value.len() > MAX_SECRET_BYTES {
            return Err(format!(
                "EINVAL: a secret is limited to {MAX_SECRET_BYTES} bytes"
            ));
        }
        let mut g = self.cache.lock();
        // Never writes unless the full document was read first: no partial overwrite.
        let mut next = self.loaded(&mut g)?.clone();
        if !next.contains_key(id) && next.len() >= MAX_SECRETS {
            return Err(format!("EINVAL: at most {MAX_SECRETS} secrets"));
        }
        next.insert(id.to_string(), value.to_string());
        self.commit(&mut g, next)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        let mut g = self.cache.lock();
        let mut next = self.loaded(&mut g)?.clone();
        if next.remove(id).is_none() {
            return Ok(());
        }
        self.commit(&mut g, next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default, Clone)]
    struct Fake {
        map: Arc<Mutex<BTreeMap<String, String>>>,
        /// Fails get/set with this message while set (a denied or locked keychain).
        fail: Arc<Mutex<Option<String>>>,
        gets: Arc<Mutex<usize>>,
    }

    impl SecretBackend for Fake {
        fn get(&self, a: &str) -> Result<Option<String>, String> {
            *self.gets.lock() += 1;
            if let Some(m) = self.fail.lock().clone() {
                return Err(m);
            }
            Ok(self.map.lock().get(a).cloned())
        }
        fn set(&self, a: &str, v: &str) -> Result<(), String> {
            if let Some(m) = self.fail.lock().clone() {
                return Err(m);
            }
            self.map.lock().insert(a.into(), v.into());
            Ok(())
        }
    }

    fn secrets() -> (PluginSecrets, Fake) {
        let f = Fake::default();
        (PluginSecrets::new(Box::new(f.clone())), f)
    }

    #[test]
    fn fresh_install_is_empty_and_writes_nothing() {
        let (s, f) = secrets();
        assert!(s.load_all().unwrap().is_empty());
        assert!(s.list_ids().unwrap().is_empty());
        assert!(f.map.lock().is_empty());
    }

    #[test]
    fn set_load_overwrite_delete_list() {
        let (s, f) = secrets();
        s.set("openai", "k1").unwrap();
        s.set("anthropic", "k2").unwrap();
        s.set("openai", "k3").unwrap();
        assert_eq!(s.load_all().unwrap()["openai"], "k3");
        assert_eq!(s.list_ids().unwrap(), ["anthropic", "openai"]);
        s.delete("openai").unwrap();
        s.delete("openai").unwrap();
        assert_eq!(s.list_ids().unwrap(), ["anthropic"]);
        // exactly one keychain item, whatever the number of secrets
        assert_eq!(f.map.lock().keys().collect::<Vec<_>>(), [DOC_ACCOUNT]);
    }

    #[test]
    fn stores_the_documented_json_shape() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        let raw = f.get(DOC_ACCOUNT).unwrap().unwrap();
        assert_eq!(raw, r#"{"version":2,"secrets":{"a":"1"}}"#);
    }

    #[test]
    fn reads_the_keychain_once_per_process() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        *f.gets.lock() = 0;
        let again = PluginSecrets::new(Box::new(f.clone()));
        again.load_all().unwrap();
        again.list_ids().unwrap();
        again.set("b", "2").unwrap();
        again.delete("b").unwrap();
        assert_eq!(*f.gets.lock(), 1);
        assert_eq!(again.load_all().unwrap()["a"], "1");
    }

    #[test]
    fn legacy_items_are_ignored_and_left_alone() {
        let (s, f) = secrets();
        f.set("__index__", r#"["old"]"#).unwrap();
        f.set("secret:old", "legacy-value").unwrap();
        assert!(s.load_all().unwrap().is_empty());
        s.set("new", "v").unwrap();
        assert_eq!(s.list_ids().unwrap(), ["new"]);
        assert_eq!(f.get("secret:old").unwrap().unwrap(), "legacy-value");
    }

    #[test]
    fn a_corrupt_document_is_an_error_and_is_not_overwritten() {
        for bad in ["{not json", r#"{"version":1,"secrets":{}}"#, "[1,2]"] {
            let (s, f) = secrets();
            f.set(DOC_ACCOUNT, bad).unwrap();
            assert!(s.load_all().is_err());
            assert!(s.list_ids().is_err());
            assert!(s.set("a", "1").is_err());
            assert!(s.delete("a").is_err());
            assert_eq!(f.get(DOC_ACCOUNT).unwrap().unwrap(), bad);
        }
    }

    #[test]
    fn a_failed_read_is_not_cached_and_blocks_writes() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        let s = PluginSecrets::new(Box::new(f.clone()));
        *f.fail.lock() = Some("user canceled".into());
        assert!(s.load_all().is_err());
        assert!(s.set("b", "2").is_err());
        assert!(s.delete("a").is_err());
        *f.fail.lock() = None;
        // the retry works without a restart, and nothing was lost or overwritten
        assert_eq!(s.load_all().unwrap().len(), 1);
        s.set("b", "2").unwrap();
        assert_eq!(s.list_ids().unwrap(), ["a", "b"]);
    }

    #[test]
    fn a_failed_write_keeps_the_cache_and_the_store_unchanged() {
        let (s, f) = secrets();
        s.set("a", "1").unwrap();
        *f.fail.lock() = Some("keychain locked".into());
        assert!(s.set("b", "2").is_err());
        *f.fail.lock() = None;
        assert_eq!(s.list_ids().unwrap(), ["a"]);
    }

    #[test]
    fn validates_ids_and_sizes() {
        let (s, _) = secrets();
        assert!(s.set("", "x").is_err());
        assert!(s.set("bad\nid", "x").is_err());
        assert!(s.set(&"a".repeat(257), "x").is_err());
        assert!(s.set("big", &"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
    }

    #[test]
    fn the_document_has_a_size_cap_with_a_clear_error() {
        let (s, f) = secrets();
        let mut hit = None;
        for i in 0..(MAX_DOC_BYTES / 1000 + 2) {
            if let Err(e) = s.set(&format!("k{i}"), &"x".repeat(1000)) {
                hit = Some(e);
                break;
            }
        }
        let e = hit.expect("cap reached");
        assert!(e.contains("limited to") && e.contains("bytes"));
        assert!(f.get(DOC_ACCOUNT).unwrap().unwrap().len() <= MAX_DOC_BYTES);
    }

    #[test]
    fn caps_the_number_of_secrets() {
        // Many tiny secrets: the count cap (or the document cap on Windows) must trip cleanly.
        let (s, _) = secrets();
        let mut failed = false;
        for i in 0..=MAX_SECRETS {
            if s.set(&format!("i{i}"), "v").is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed);
        let n = s.list_ids().unwrap().len();
        assert!(n <= MAX_SECRETS);
        // replacing an existing id is still allowed at the cap
        s.set("i0", "w").unwrap();
    }

    #[test]
    fn errors_never_contain_values() {
        let (s, f) = secrets();
        let secret = "synthetic-secret-value-XYZ";
        s.set("a", secret).unwrap();
        let e = s
            .set("b", &format!("{secret}{}", "x".repeat(MAX_SECRET_BYTES)))
            .unwrap_err();
        assert!(!e.contains(secret));
        // a corrupt document whose type error would quote a value
        let s2 = PluginSecrets::new(Box::new(f.clone()));
        f.set(
            DOC_ACCOUNT,
            &format!(r#"{{"version":"{secret}","secrets":{{}}}}"#),
        )
        .unwrap();
        let e = s2.load_all().unwrap_err();
        assert!(!e.contains(secret), "{e}");
        let e = s2.set("c", "v").unwrap_err();
        assert!(!e.contains(secret), "{e}");
    }

    #[test]
    fn service_name_follows_the_app_identifier() {
        assert_ne!(
            PluginSecrets::service_name("com.writer-computer.e2e"),
            PluginSecrets::service_name("com.writer-computer.app")
        );
    }
}
