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
//! entry in [`registry`] (`impl<R: Runtime> Feature<R> for WordCount`, see [`Feature`]):
//!
//! ```ignore
//! #[path = "../../../features/word-count/rust/mod.rs"]
//! mod word_count;
//! // in registry():  &word_count::WordCount,
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
//!   isolation is `Result` based (a failing `setup` or plugin add is logged and the feature is
//!   skipped); the `catch_unwind` in [`guard`] only helps in dev and test builds.
//! - Hooks ([`Feature::setup`], `on_workspace_open`, `on_workspace_close`, `on_exit`) are called
//!   by this module's runner only for features that are enabled and whose `setup` succeeded; a
//!   failing hook is logged, never propagated. Teardown hooks run in reverse registry order.
//! - Pure contributions ([`Feature::cli_commands`], [`Feature::skills`], [`Feature::index_ddl`])
//!   are read from every registered feature whatever the toggle (the index and the CLI have no
//!   settings layer; a toggle must never rebuild the index). The tables that run them stay
//!   where they were: `cli::registry`, `managed_skills`, `index::schema`.
//! - `setup` runs while `install` holds the settings read lock: it must not write settings.

use crate::cli::registry::CommandSpec;
use crate::config::Settings;
use crate::managed_skills::BundledSkill;
use serde::Deserialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, Wry};

pub mod lazy;

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod fixture;
#[cfg(test)]
mod ipc_tests;

#[path = "../../../features/agent/rust/mod.rs"]
mod agent;
#[path = "../../../features/mouse-buttons/rust/mod.rs"]
mod mouse_buttons;

/// The parts of `feature.json` Rust reads. `build.rs` reads the same file for the ACL, so the
/// manifest is the only place a command name is declared.
// `name`, `version` and `rust` are read by the contract tests and by the contributions below.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
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
    /// The `Feature` hooks the feature implements (`setup`, `onWorkspaceOpen`, `onWorkspaceClose`,
    /// `onExit`): documentation for the Features section, vocabulary checked by the contract test.
    #[serde(default)]
    pub hooks: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Manifest {
    /// Does the feature have a Rust half? A feature without commands, events or hooks is
    /// TypeScript-only: no plugin, no ACL, nothing in [`registry`].
    #[cfg(test)]
    pub fn has_rust(&self) -> bool {
        !self.rust.commands.is_empty()
            || !self.rust.events.is_empty()
            || !self.rust.hooks.is_empty()
    }

    /// The settings key of this feature's kill switch.
    pub fn enabled_key(&self) -> String {
        format!("features.{}.enabled", self.id)
    }
}

/// The window a workspace hook runs for.
#[allow(dead_code)] // read by the first feature with a workspace hook (the agent pilot)
pub struct WindowCtx<'a> {
    pub label: &'a str,
    pub root: Option<&'a Path>,
}

/// One first-party feature. Generic over the runtime so the same registry runs under Tauri's mock
/// runtime in tests; implement it for every runtime (`impl<R: Runtime> Feature<R> for X`). Every
/// method but `manifest_source` has a no-op default, so a feature states only what it needs.
pub trait Feature<R: Runtime>: Send + Sync {
    /// `include_str!` of the feature's `feature.json` (the id, the kill-switch default, the
    /// commands and events).
    fn manifest_source(&self) -> &'static str;
    /// `include_str!` of the feature's `settings.schema.json` fragment, if it has settings.
    fn settings_source(&self) -> Option<&'static str> {
        None
    }

    /// The feature's commands, as a Tauri plugin named after the id; `None` without commands.
    fn tauri_plugin(&self) -> Option<TauriPlugin<R>> {
        None
    }

    /// Once, at app setup, after the settings layer exists. Register cheap state; start nothing
    /// heavy (threads, watchers, processes) unless the feature's own switch says so. An `Err` is
    /// logged and the feature stays off for the session (its plugin is not added, no hook runs).
    /// It runs while the settings read lock is held: never write settings here.
    fn setup(&self, _app: &AppHandle<R>) -> Result<(), String> {
        Ok(())
    }
    /// A window now has a workspace root (open, switch or restore).
    #[allow(dead_code)] // no feature uses it yet
    fn on_workspace_open(&self, _app: &AppHandle<R>, _window: &WindowCtx<'_>) {}
    /// A window was destroyed or left its workspace: stop what it started for `label`.
    fn on_workspace_close(&self, _app: &AppHandle<R>, _label: &str) {}
    /// `RunEvent::Exit`.
    fn on_exit(&self, _app: &AppHandle<R>) {}

    /// `writer` CLI commands, appended to `cli::registry::COMMANDS`.
    fn cli_commands(&self) -> &'static [CommandSpec] {
        &[]
    }
    /// Managed agent skills, appended to `managed_skills::SKILLS` (changing one needs a
    /// `BUNDLE_VERSION` bump, a test says so).
    fn skills(&self) -> &'static [BundledSkill] {
        &[]
    }
    /// SQL appended to the vault index schema; part of the index schema version.
    fn index_ddl(&self) -> Option<&'static str> {
        None
    }

    fn manifest(&self) -> Result<Manifest, serde_json::Error> {
        serde_json::from_str(self.manifest_source())
    }
}

/// Every registered first-party feature, in startup order (teardown runs reversed). A
/// TypeScript-only feature is not listed: its manifest alone is enough.
pub fn registry<R: Runtime>() -> Vec<&'static dyn Feature<R>> {
    vec![&agent::Agent, &mouse_buttons::MouseButtons]
}

/// Is the feature switched on? `features.<id>.enabled` at the global scope (a vault's config can
/// not switch a feature of the app), the manifest default when the setting is absent.
pub fn is_enabled(settings: &Settings, manifest: &Manifest) -> bool {
    settings
        .get_global_or_default(&manifest.enabled_key())
        .and_then(|v| v.as_bool())
        .unwrap_or(manifest.enabled_by_default)
}

/// The features `install` sets up: enabled ones with a readable manifest. A setting for an id
/// that is not in `features` is never looked at, so a stale `features.gone.enabled` is ignored.
pub fn plan<R: Runtime>(
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
) -> Vec<&'static dyn Feature<R>> {
    features
        .into_iter()
        .filter(|f| match f.manifest() {
            Ok(m) => is_enabled(settings, &m),
            Err(e) => {
                log::error!("feature manifest is unreadable, feature skipped: {e}");
                false
            }
        })
        .collect()
}

/// The features whose `setup` succeeded; the hooks below run over this list. Managed state.
pub struct Running<R: Runtime>(Vec<&'static dyn Feature<R>>);

/// Runs `f` and turns an `Err` or (dev and test builds only, see the module docs) a panic into a
/// message for the log.
fn guard<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => Err(format!(
            "panic: {}",
            crate::logging::describe_panic(p.as_ref())
        )),
    }
}

fn id_of<R: Runtime>(f: &dyn Feature<R>) -> String {
    f.manifest().map(|m| m.id).unwrap_or_default()
}

/// Sets up every enabled feature (`setup`, then its plugin) and remembers the ones that started.
/// Called once from `setup`, after the settings layer exists (the webview already exists too, as
/// for the updater plugin). A disabled feature is never touched: no state, no hook, and its
/// commands are rejected as "plugin not found". A feature whose `setup` or plugin fails is logged
/// and skipped; the app and the other features keep starting.
pub fn install<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    install_features(app, registry::<R>(), settings);
}

fn install_features<R: Runtime>(
    app: &AppHandle<R>,
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
) {
    let started = start_features(app, features, settings);
    for (id, error) in &started.failed {
        log::error!("feature {id} failed to start and is disabled for this session: {error}");
    }
    app.manage(Running(started.running));
}

struct Started<R: Runtime> {
    running: Vec<&'static dyn Feature<R>>,
    /// Feature id and the reason, for the log (and the tests).
    failed: Vec<(String, String)>,
}

fn start_features<R: Runtime>(
    app: &AppHandle<R>,
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
) -> Started<R> {
    let mut started = Started {
        running: Vec::new(),
        failed: Vec::new(),
    };
    for f in plan(features, settings) {
        let started_ok = guard(|| f.setup(app)).and_then(|()| match f.tauri_plugin() {
            Some(plugin) => guard(|| app.plugin(plugin).map_err(|e| e.to_string())),
            None => Ok(()),
        });
        match started_ok {
            Ok(()) => started.running.push(f),
            Err(e) => started.failed.push((id_of(f), e)),
        }
    }
    started
}

fn run_hooks<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    reverse: bool,
    hook: impl Fn(&dyn Feature<R>),
) {
    let Some(running) = app.try_state::<Running<R>>() else {
        return;
    };
    let mut list = running.0.clone();
    if reverse {
        list.reverse();
    }
    for f in list {
        if let Err(e) = guard(|| {
            hook(f);
            Ok(())
        }) {
            log::error!("feature {} failed in {name}: {e}", id_of(f));
        }
    }
}

/// A window now has a workspace root.
pub fn workspace_open<R: Runtime>(app: &AppHandle<R>, label: &str, root: &Path) {
    let window = WindowCtx {
        label,
        root: Some(root),
    };
    run_hooks(app, "on_workspace_open", false, |f| {
        f.on_workspace_open(app, &window)
    });
}

/// A window was destroyed or left its workspace (`commands::plugins::stop_window_work` calls this).
pub fn workspace_close<R: Runtime>(app: &AppHandle<R>, label: &str) {
    run_hooks(app, "on_workspace_close", true, |f| {
        f.on_workspace_close(app, label)
    });
}

/// The app is exiting.
pub fn exit<R: Runtime>(app: &AppHandle<R>) {
    run_hooks(app, "on_exit", true, |f| f.on_exit(app));
}

// Contributions: pure data. The registry is read for `Wry` only because a runtime must be
// named; none of these methods touch it.

/// Feature CLI commands, for `cli::registry`.
pub fn cli_commands() -> Vec<&'static CommandSpec> {
    cli_commands_of(&registry::<Wry>())
}

fn cli_commands_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static CommandSpec> {
    features.iter().flat_map(|f| f.cli_commands()).collect()
}

/// Feature skills, for `managed_skills`.
pub fn skills() -> Vec<&'static BundledSkill> {
    skills_of(&registry::<Wry>())
}

fn skills_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static BundledSkill> {
    features.iter().flat_map(|f| f.skills()).collect()
}

/// Settings fragments (`settings.schema.json` of each feature), for `config::settings_schema`,
/// which appends their entries to the core file. Every registered feature counts whatever its
/// toggle: a setting must keep its default and its place in the UI while the feature is off.
pub fn settings_fragments() -> Vec<&'static str> {
    settings_fragments_of(&registry::<Wry>())
}

fn settings_fragments_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static str> {
    features
        .iter()
        .filter_map(|f| f.settings_source())
        .collect()
}

/// Feature DDL, for `index::schema`.
pub fn index_ddl() -> Vec<&'static str> {
    index_ddl_of(&registry::<Wry>())
}

fn index_ddl_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static str> {
    features.iter().filter_map(|f| f.index_ddl()).collect()
}

/// Suffix of the index schema version: empty when no feature adds DDL (an app without such a
/// feature never rebuilds its indexes), else a hash of every DDL feature's id, manifest version
/// and DDL (a changed table or a bumped contract version rebuilds the cache). Registered
/// features count whatever their toggle, so switching one never rebuilds the index.
pub fn index_schema_suffix() -> String {
    index_schema_suffix_of(&registry::<Wry>())
}

fn index_schema_suffix_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a: stable across builds and platforms
    let mut any = false;
    for f in features {
        let Some(ddl) = f.index_ddl() else { continue };
        any = true;
        let m = f
            .manifest()
            .expect("feature manifest parses (contract test)");
        for b in
            m.id.bytes()
                .chain([0])
                .chain(m.version.bytes())
                .chain([0])
                .chain(ddl.bytes())
        {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    if any {
        format!("+{hash:016x}")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigValue;
    use std::sync::Mutex;
    use tauri::test::mock_app;

    pub(super) fn settings_with(dir: &std::path::Path, values: &[(&str, bool)]) -> Settings {
        let mut s = Settings::new(dir.to_path_buf()).unwrap();
        for (k, v) in values {
            s.set_global(k, ConfigValue::Bool(*v)).unwrap();
        }
        s
    }

    #[derive(Clone, Copy)]
    enum Mode {
        Ok,
        Error,
        Panic,
    }

    /// A feature that records every hook into a log shared with the test.
    struct Probe {
        manifest: &'static str,
        log: &'static Mutex<Vec<String>>,
        mode: Mode,
        ddl: Option<&'static str>,
    }

    impl Probe {
        fn note(&self, what: &str) {
            let id = Feature::<tauri::test::MockRuntime>::manifest(self)
                .unwrap()
                .id;
            self.log.lock().unwrap().push(format!("{what}:{id}"));
        }
    }

    impl<R: Runtime> Feature<R> for Probe {
        fn manifest_source(&self) -> &'static str {
            self.manifest
        }
        fn setup(&self, _app: &AppHandle<R>) -> Result<(), String> {
            self.note("setup");
            match self.mode {
                Mode::Ok => Ok(()),
                Mode::Error => Err("forced setup error".into()),
                Mode::Panic => panic!("forced setup panic"),
            }
        }
        fn on_workspace_open(&self, _app: &AppHandle<R>, w: &WindowCtx<'_>) {
            self.note(&format!("open({})", w.label));
        }
        fn on_workspace_close(&self, _app: &AppHandle<R>, label: &str) {
            self.note(&format!("close({label})"));
        }
        fn on_exit(&self, _app: &AppHandle<R>) {
            self.note("exit");
        }
        fn index_ddl(&self) -> Option<&'static str> {
            self.ddl
        }
    }

    const A: &str = r#"{"id":"probe-a","name":"A","version":"1.0.0"}"#;
    const B: &str = r#"{"id":"probe-b","name":"B","version":"1.0.0"}"#;

    fn entries(log: &Mutex<Vec<String>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn the_registry_lists_the_features_and_every_entry_has_a_valid_manifest() {
        let ids: Vec<String> = registry::<Wry>()
            .iter()
            .map(|f| f.manifest().expect("manifest parses").id)
            .collect();
        assert_eq!(ids, ["agent", "mouse-buttons"]);
    }

    #[test]
    fn fragments_are_read_from_every_registered_feature_whatever_its_toggle() {
        let all = settings_fragments();
        assert!(all.iter().any(|f| f.contains("\"agent.binary-path\"")));
        // the core defaults include the agent's, so a disabled feature keeps its settings
        assert!(crate::config::default_settings().contains_key("agent.pane-width"));
        assert_eq!(settings_fragments_of(&fixture::registry::<Wry>()).len(), 1);
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
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static BROKEN: Probe = Probe {
            manifest: "{ not json",
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let features: Vec<&'static dyn Feature<Wry>> = vec![&BROKEN];
        assert!(plan(features, &s).is_empty());
    }

    #[test]
    fn a_disabled_feature_is_never_set_up_and_gets_no_hooks() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static P: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[("features.probe-a.enabled", false)]);
        let app = mock_app();
        install_features(app.handle(), vec![&P], &s);
        workspace_open(app.handle(), "main", Path::new("/vault"));
        workspace_close(app.handle(), "main");
        exit(app.handle());
        assert!(entries(&LOG).is_empty(), "{:?}", entries(&LOG));
    }

    #[test]
    fn hooks_run_in_order_and_teardown_in_reverse() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static PA: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        static PB: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let app = mock_app();
        install_features(app.handle(), vec![&PA, &PB], &s);
        workspace_open(app.handle(), "w-1", Path::new("/vault"));
        workspace_close(app.handle(), "w-1");
        exit(app.handle());
        assert_eq!(
            entries(&LOG),
            [
                "setup:probe-a",
                "setup:probe-b",
                "open(w-1):probe-a",
                "open(w-1):probe-b",
                "close(w-1):probe-b",
                "close(w-1):probe-a",
                "exit:probe-b",
                "exit:probe-a",
            ]
        );
    }

    #[test]
    fn a_failing_or_panicking_setup_is_isolated_and_the_app_still_starts() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static BAD: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Error,
            ddl: None,
        };
        static WORSE: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Panic,
            ddl: None,
        };
        const C: &str = r#"{"id":"probe-c","name":"C"}"#;
        static GOOD: Probe = Probe {
            manifest: C,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let app = mock_app();
        let started = start_features(app.handle(), vec![&BAD, &WORSE, &GOOD], &s);
        assert_eq!(started.running.len(), 1, "only the healthy feature runs");
        let failed: Vec<(&str, &str)> = started
            .failed
            .iter()
            .map(|(id, e)| (id.as_str(), e.as_str()))
            .collect();
        assert_eq!(failed[0], ("probe-a", "forced setup error"));
        assert!(failed[1].1.contains("forced setup panic"), "{failed:?}");

        // the same path through `install_features`: it logs the failures, keeps going, and the
        // failed features get no hooks
        LOG.lock().unwrap().clear();
        install_features(app.handle(), vec![&BAD, &WORSE, &GOOD], &s);
        workspace_open(app.handle(), "main", Path::new("/vault"));
        assert!(
            entries(&LOG).contains(&"open(main):probe-c".to_string())
                && !entries(&LOG).iter().any(|e| e == "open(main):probe-a"),
            "{:?}",
            entries(&LOG)
        );
    }

    #[test]
    fn contributions_are_collected_from_features() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static PLAIN: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        static WITH_DDL: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Ok,
            ddl: Some("CREATE TABLE feature_b(id INTEGER);"),
        };
        static WITH_DDL_V2: Probe = Probe {
            manifest: r#"{"id":"probe-b","name":"B","version":"2.0.0"}"#,
            log: &LOG,
            mode: Mode::Ok,
            ddl: Some("CREATE TABLE feature_b(id INTEGER);"),
        };
        let plain: Vec<&'static dyn Feature<Wry>> = vec![&PLAIN];
        assert!(cli_commands_of(&plain).is_empty());
        assert!(skills_of(&plain).is_empty());
        assert!(index_ddl_of(&plain).is_empty());
        assert_eq!(
            index_schema_suffix_of(&plain),
            "",
            "no DDL: the core schema version is unchanged"
        );

        let with: Vec<&'static dyn Feature<Wry>> = vec![&PLAIN, &WITH_DDL];
        assert_eq!(index_ddl_of(&with), ["CREATE TABLE feature_b(id INTEGER);"]);
        let suffix = index_schema_suffix_of(&with);
        assert!(suffix.starts_with('+') && suffix.len() == 17, "{suffix}");
        assert_eq!(suffix, index_schema_suffix_of(&with), "stable");
        let v2: Vec<&'static dyn Feature<Wry>> = vec![&WITH_DDL_V2];
        assert_ne!(
            suffix,
            index_schema_suffix_of(&v2),
            "manifest version counts"
        );
    }

    #[test]
    fn the_core_tables_are_unchanged_while_no_feature_contributes() {
        assert!(cli_commands().is_empty());
        assert!(skills().is_empty());
        assert!(index_ddl().is_empty());
        assert_eq!(index_schema_suffix(), "");
        assert_eq!(crate::index::schema_version(), "2");
        assert_eq!(
            crate::cli::registry::commands().count(),
            crate::cli::registry::COMMANDS.len()
        );
        assert_eq!(
            crate::managed_skills::all_skills().count(),
            crate::managed_skills::SKILLS.len()
        );
    }
}
