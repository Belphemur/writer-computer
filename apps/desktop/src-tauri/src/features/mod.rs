//! First-party features as built-in plugins (SPECs/builtin-plugins-spec.md, ADR
//! 2026-11-17 "build first-party features as built-in plugins").
//!
//! A feature is one folder, `apps/desktop/features/<id>/` (the id is kebab-case): `feature.json`
//! (the manifest: id, `enabledByDefault`, `rust.commands`, `rust.events`), `rust/` (the Rust
//! half), `web/` (the React half, collected by `src/lib/features`) and an optional
//! `settings.schema.json` fragment. Its Tauri commands live in their own plugin named after the
//! id, so they are called as `plugin:<id>|<command>` and are gated by the `<id>:allow-<command>`
//! permissions that `build.rs` generates from the manifest. A capability file
//! `src-tauri/capabilities/features/<id>.json` (picked up by tauri-build's default glob, no code)
//! grants `<id>:default` to the windows `main` and `w-*`, and nothing else.
//!
//! Adding a feature touches this file in two adjacent places: the `#[path]` `mod` line and the
//! entry in [`registry`]:
//!
//! ```ignore
//! #[path = "../../../features/word-count/rust/mod.rs"]
//! mod word_count;
//! // in registry():  word_count::def(),
//! ```
//!
//! Nothing else in Rust: not `lib.rs`, not `commands/mod.rs`, not `build.rs`. The contract test
//! fails when the folder, the manifest, the handlers, the capability file or the settings
//! fragment disagree.
//!
//! Rules every feature follows:
//! - Events are named `<id>:<name>`: Tauri accepts only alphanumerics, `-`, `/`, `:` and `_`
//!   (a `.` is rejected), and `src/lib/features/events.ts` enforces the same rule.
//! - The plugin's `setup` only manages cheap, empty state. Expensive state sits in a [`lazy::Lazy`] and
//!   is built by the first command that needs it; threads, watchers, processes and SQLite handles
//!   never start from `setup`.
//! - Commands are `async` and do disk work through `commands::blocking` (the existing allowlist
//!   test scans this folder too).
//! - The release profile is `panic = "abort"`: a panic in a feature kills the app there. Error
//!   isolation is `Result` based (a failing plugin add is logged and the feature is skipped); a
//!   `catch_unwind` guard would only work in dev and test builds.
//! - `setup` runs while `install` holds the settings read lock: it must not write settings.

use crate::config::Settings;
use serde::Deserialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};

pub mod lazy;

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod fixture;

/// The parts of `feature.json` Rust reads. `build.rs` reads the same file for the ACL, so the
/// manifest is the only place a command name is declared.
// `name` and `rust` are read by the contract tests and by the first real feature.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
    #[serde(default)]
    pub rust: RustPart,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RustPart {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Manifest {
    /// Does the feature have a Rust half? A feature without commands or events is TypeScript-only:
    /// no plugin, no ACL, nothing in [`registry`].
    #[cfg(test)]
    pub fn has_rust(&self) -> bool {
        !self.rust.commands.is_empty() || !self.rust.events.is_empty()
    }

    /// The settings key of this feature's kill switch.
    pub fn enabled_key(&self) -> String {
        format!("features.{}.enabled", self.id)
    }
}

/// One registry entry. Generic over the runtime so the same registry can run under Tauri's mock
/// runtime later (it needs the `tauri` `test` feature, pending approval).
pub struct FeatureDef<R: Runtime> {
    /// `include_str!` of the feature's `feature.json`.
    pub manifest: &'static str,
    /// `include_str!` of the feature's `settings.schema.json` fragment, if it has settings.
    #[allow(dead_code)] // read by the contract test's schema drift check
    pub settings: Option<&'static str>,
    /// Builds the plugin; `tauri::plugin::Builder::new(<id>)`, the id equal to the manifest's.
    pub plugin: fn() -> TauriPlugin<R>,
}

impl<R: Runtime> FeatureDef<R> {
    pub fn manifest(&self) -> Result<Manifest, serde_json::Error> {
        serde_json::from_str(self.manifest)
    }
}

/// Every first-party feature that has a Rust half. Empty today: the first pilot lands next.
pub fn registry<R: Runtime>() -> Vec<FeatureDef<R>> {
    vec![]
}

/// Is the feature switched on? `features.<id>.enabled` at the global scope (a vault's config can
/// not switch a feature of the app), the manifest default when the setting is absent.
pub fn is_enabled(settings: &Settings, manifest: &Manifest) -> bool {
    settings
        .get_global_or_default(&manifest.enabled_key())
        .and_then(|v| v.as_bool())
        .unwrap_or(manifest.enabled_by_default)
}

/// The entries `install` registers: enabled features with a readable manifest. A setting for an
/// id that is not in `defs` is never looked at, so a stale `features.gone.enabled` is ignored.
pub fn plan<R: Runtime>(defs: Vec<FeatureDef<R>>, settings: &Settings) -> Vec<FeatureDef<R>> {
    defs.into_iter()
        .filter(|def| match def.manifest() {
            Ok(m) => is_enabled(settings, &m),
            Err(e) => {
                log::error!("feature manifest is unreadable, feature skipped: {e}");
                false
            }
        })
        .collect()
}

/// Adds the plugin of every enabled feature. Called once from `setup`, after the settings layer
/// exists (the webview already exists too, as for the updater plugin). A disabled feature is never
/// added: no state, and its commands are rejected as "plugin not found". A feature whose plugin
/// fails to initialise is logged and skipped; the app and the other features keep starting.
pub fn install<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    install_defs(app, registry::<R>(), settings);
}

fn install_defs<R: Runtime>(app: &AppHandle<R>, defs: Vec<FeatureDef<R>>, settings: &Settings) {
    for def in plan(defs, settings) {
        let id = def.manifest().map(|m| m.id).unwrap_or_default();
        if let Err(e) = app.plugin((def.plugin)()) {
            log::error!("feature {id} failed to start and is disabled for this session: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigValue;
    use tauri::Wry;

    pub(super) fn settings_with(dir: &std::path::Path, values: &[(&str, bool)]) -> Settings {
        let mut s = Settings::new(dir.to_path_buf()).unwrap();
        for (k, v) in values {
            s.set_global(k, ConfigValue::Bool(*v)).unwrap();
        }
        s
    }

    #[test]
    fn the_registry_is_empty_until_the_first_feature_lands() {
        assert!(registry::<Wry>().is_empty());
    }

    #[test]
    fn install_registers_enabled_features_only() {
        let dir = tempfile::tempdir().unwrap();
        let on = settings_with(dir.path(), &[]);
        assert_eq!(
            plan(fixture::registry::<Wry>(), &on).len(),
            1,
            "default is on"
        );

        let dir = tempfile::tempdir().unwrap();
        let off = settings_with(dir.path(), &[("features.fixture-hello.enabled", false)]);
        assert!(plan(fixture::registry::<Wry>(), &off).is_empty());
    }

    #[test]
    fn a_setting_for_an_unknown_feature_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(
            dir.path(),
            &[
                ("features.ghost.enabled", false),
                ("features.fixture-hello.enabled", true),
            ],
        );
        assert_eq!(plan(fixture::registry::<Wry>(), &s).len(), 1);
    }

    #[test]
    fn a_broken_manifest_skips_the_feature_instead_of_aborting() {
        fn plugin() -> TauriPlugin<Wry> {
            tauri::plugin::Builder::new("broken").build()
        }
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let broken = FeatureDef::<Wry> {
            manifest: "{ not json",
            settings: None,
            plugin,
        };
        assert!(plan(vec![broken], &s).is_empty());
    }
}
