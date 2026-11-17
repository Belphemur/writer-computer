//! Secrets a built-in feature owns (SPECs/builtin-plugins-spec.md "Feature settings and
//! secrets"). A feature declares them in `feature.json` under `contributes.secrets`
//! (`{ key, label, description }`, the key spelled `features.<id>.<name>`); the values live in
//! the one secrets module (`plugin_secrets`, one Keychain item), never in a settings file, a log
//! line, an event or a bindings snapshot.
//!
//! The scope is enforced here, once: a read, write or delete names the feature id and the key,
//! and is refused unless that feature's manifest declares that key. The web half reaches this
//! through the `feature_secret_*` commands (`commands/features.rs`); a Rust half calls
//! [`secret`], [`set_secret`] and [`delete_secret`]. A value comes back as a [`SecretValue`]
//! that cannot be printed or serialized by accident.
//!
//! These calls read or write the Keychain: from a command or any async code run them through
//! `commands::blocking`.

use super::Manifest;
use crate::error::AppError;
use crate::plugin_secrets::PluginSecrets;
use serde::Deserialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};

include!(concat!(env!("OUT_DIR"), "/feature_manifests.rs"));

/// One entry of `contributes.secrets`. `label` and `description` are for the web UI and the
/// contract test; Rust reads only `key`.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct SecretDecl {
    /// The full key, `features.<id>.<name>`: the id the value is stored under.
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// A stored secret value. No `Display`, no `Serialize`, no `Clone`, and a redacted `Debug`, so a
/// `{:?}`, a log line or a struct that derives `Serialize` cannot leak it by accident.
pub struct SecretValue(String);

impl SecretValue {
    /// The value, for the one place that needs it (the request that uses the key).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(<redacted>)")
    }
}

/// Every feature's manifest (the ones `build.rs` found, TypeScript-only features included).
fn all_manifests() -> &'static [Manifest] {
    static ALL: OnceLock<Vec<Manifest>> = OnceLock::new();
    ALL.get_or_init(|| {
        FEATURE_MANIFESTS
            .iter()
            .filter_map(|raw| match serde_json::from_str::<Manifest>(raw) {
                Ok(m) => Some(m),
                Err(e) => {
                    log::error!("feature manifest is unreadable, its secrets are unavailable: {e}");
                    None
                }
            })
            .collect()
    })
}

fn refuse(message: String) -> AppError {
    AppError::Io(format!("EINVAL: {message}"))
}

/// The declaration of `key` in feature `id`, or an error: the scoping rule.
fn declared<'a>(
    manifests: &'a [Manifest],
    id: &str,
    key: &str,
) -> Result<&'a SecretDecl, AppError> {
    manifests
        .iter()
        .find(|m| m.id == id)
        .and_then(|m| m.contributes.secrets.iter().find(|s| s.key == key))
        .ok_or_else(|| refuse(format!("feature {id} declares no secret {key}")))
}

fn io(e: String) -> AppError {
    AppError::Io(e)
}

pub(crate) fn get_in(
    store: &PluginSecrets,
    manifests: &[Manifest],
    id: &str,
    key: &str,
) -> Result<Option<SecretValue>, AppError> {
    declared(manifests, id, key)?;
    Ok(store.feature_get(key).map_err(io)?.map(SecretValue))
}

pub(crate) fn set_in(
    store: &PluginSecrets,
    manifests: &[Manifest],
    id: &str,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    declared(manifests, id, key)?;
    store.feature_set(key, value).map_err(io)
}

pub(crate) fn delete_in(
    store: &PluginSecrets,
    manifests: &[Manifest],
    id: &str,
    key: &str,
) -> Result<(), AppError> {
    declared(manifests, id, key)?;
    store.feature_delete(key).map_err(io)
}

/// The declared keys of feature `id` that hold a value. Names only: what the Features section
/// shows as "set" / "not set".
pub(crate) fn keys_set_in(
    store: &PluginSecrets,
    manifests: &[Manifest],
    id: &str,
) -> Result<Vec<String>, AppError> {
    let keys: Vec<String> = manifests
        .iter()
        .filter(|m| m.id == id)
        .flat_map(|m| m.contributes.secrets.iter().map(|s| s.key.clone()))
        .collect();
    store.feature_keys_set(&keys).map_err(io)
}

fn store<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, PluginSecrets>, AppError> {
    app.try_state::<PluginSecrets>()
        .ok_or_else(|| io("EIO: the secret store is not available".into()))
}

/// The value of feature `id`'s secret `key`, `None` when it is not set.
pub fn secret<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    key: &str,
) -> Result<Option<SecretValue>, AppError> {
    get_in(&*store(app)?, all_manifests(), id, key)
}

pub fn set_secret<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    set_in(&*store(app)?, all_manifests(), id, key, value)
}

pub fn delete_secret<R: Runtime>(app: &AppHandle<R>, id: &str, key: &str) -> Result<(), AppError> {
    delete_in(&*store(app)?, all_manifests(), id, key)
}

pub fn secret_keys_set<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Vec<String>, AppError> {
    keys_set_in(&*store(app)?, all_manifests(), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::SecretBackend;
    use parking_lot::Mutex;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    pub(crate) const FIXTURE: &str =
        include_str!("../../tests/fixtures/features/fixture-secrets/feature.json");
    const KEY: &str = "features.fixture-secrets.api-token";
    const VALUE: &str = "synthetic-feature-secret-XYZ-12345";

    #[derive(Default, Clone)]
    struct Memory(Arc<Mutex<BTreeMap<String, String>>>);
    impl SecretBackend for Memory {
        fn get(&self, a: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().get(a).cloned())
        }
        fn set(&self, a: &str, v: &str) -> Result<(), String> {
            self.0.lock().insert(a.into(), v.into());
            Ok(())
        }
    }

    /// The fixture plus a second feature that declares its own secret.
    fn manifests() -> Vec<Manifest> {
        let other = r#"{"id":"other","name":"Other","contributes":{"secrets":[
            {"key":"features.other.token","label":"Token"}]}}"#;
        [FIXTURE, other]
            .iter()
            .map(|r| serde_json::from_str(r).unwrap())
            .collect()
    }

    fn store() -> (PluginSecrets, Memory) {
        let m = Memory::default();
        (PluginSecrets::new(Box::new(m.clone())), m)
    }

    #[test]
    fn a_feature_reads_writes_and_clears_its_declared_secret() {
        let (s, _) = store();
        let ms = manifests();
        assert!(get_in(&s, &ms, "fixture-secrets", KEY).unwrap().is_none());
        assert!(keys_set_in(&s, &ms, "fixture-secrets").unwrap().is_empty());
        set_in(&s, &ms, "fixture-secrets", KEY, VALUE).unwrap();
        assert_eq!(
            get_in(&s, &ms, "fixture-secrets", KEY)
                .unwrap()
                .unwrap()
                .expose(),
            VALUE
        );
        assert_eq!(keys_set_in(&s, &ms, "fixture-secrets").unwrap(), [KEY]);
        delete_in(&s, &ms, "fixture-secrets", KEY).unwrap();
        assert!(get_in(&s, &ms, "fixture-secrets", KEY).unwrap().is_none());
    }

    #[test]
    fn a_feature_cannot_reach_another_features_secret_or_an_undeclared_key() {
        let (s, _) = store();
        let ms = manifests();
        set_in(&s, &ms, "other", "features.other.token", VALUE).unwrap();
        // fixture-secrets names the other feature's key
        assert!(get_in(&s, &ms, "fixture-secrets", "features.other.token").is_err());
        assert!(set_in(&s, &ms, "fixture-secrets", "features.other.token", "x").is_err());
        assert!(delete_in(&s, &ms, "fixture-secrets", "features.other.token").is_err());
        // an undeclared key, in its own namespace and outside it, and an unknown feature
        for key in ["features.fixture-secrets.undeclared", "plain", ""] {
            assert!(get_in(&s, &ms, "fixture-secrets", key).is_err(), "{key}");
            assert!(
                set_in(&s, &ms, "fixture-secrets", key, "x").is_err(),
                "{key}"
            );
        }
        assert!(get_in(&s, &ms, "ghost", KEY).is_err());
        // the other feature's value is untouched and not listed for this one
        assert_eq!(
            get_in(&s, &ms, "other", "features.other.token")
                .unwrap()
                .unwrap()
                .expose(),
            VALUE
        );
        assert!(keys_set_in(&s, &ms, "fixture-secrets").unwrap().is_empty());
    }

    #[test]
    fn plugins_and_the_secrets_section_never_see_a_feature_secret() {
        let (s, _) = store();
        let ms = manifests();
        set_in(&s, &ms, "fixture-secrets", KEY, VALUE).unwrap();
        assert!(s.list_ids().unwrap().is_empty());
        assert!(s.load_all().unwrap().is_empty());
        assert!(s.set(KEY, "overwrite").is_err());
        assert!(s.delete(KEY).is_err());
    }

    #[test]
    fn the_value_stays_in_the_one_keychain_item_and_out_of_settings_files() {
        let (s, mem) = store();
        let ms = manifests();
        set_in(&s, &ms, "fixture-secrets", KEY, VALUE).unwrap();
        // one item, the existing document
        assert_eq!(mem.0.lock().len(), 1);
        // no setting entry exists for a secret key, so no settings file can hold it
        let schema_keys: Vec<String> = crate::config::settings_schema()
            .into_iter()
            .map(|d| d.key)
            .collect();
        assert!(!schema_keys.iter().any(|k| k == KEY));
        // the only place the value is stored is that one document
        assert!(mem.0.lock().values().all(|doc| doc.contains(VALUE)));
    }

    #[test]
    fn the_value_is_in_no_error_and_no_debug_output() {
        let (s, _) = store();
        let ms = manifests();
        set_in(&s, &ms, "fixture-secrets", KEY, VALUE).unwrap();
        let v = get_in(&s, &ms, "fixture-secrets", KEY).unwrap().unwrap();
        assert!(!format!("{v:?}").contains(VALUE));
        let too_big = format!("{VALUE}{}", "x".repeat(4096));
        let e = set_in(&s, &ms, "fixture-secrets", KEY, &too_big).unwrap_err();
        assert!(!e.to_string().contains(VALUE), "{e}");
        let e = set_in(&s, &ms, "other", KEY, VALUE).unwrap_err();
        assert!(!e.to_string().contains(VALUE), "{e}");
    }

    #[test]
    fn this_module_writes_no_log_line() {
        // A value passes through here: nothing in the non-test code may log, so no value (and no
        // argument) can reach a log. `log::error!` in `all_manifests` reports a manifest parse
        // error, which carries no secret.
        let src = include_str!("secrets.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        let logging: Vec<&str> = code
            .lines()
            .filter(|l| l.contains("log::") || l.contains("tracing::") || l.contains("println!"))
            .collect();
        assert_eq!(logging.len(), 1, "{logging:?}");
    }

    #[test]
    fn shipped_manifests_declare_no_secret_yet_so_the_real_lookup_refuses_every_key() {
        let all = all_manifests();
        assert!(all.iter().any(|m| m.id == "agent"));
        let (s, _) = store();
        assert!(get_in(&s, all, "agent", "features.agent.token").is_err());
    }
}
