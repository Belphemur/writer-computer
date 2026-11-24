//! The Rust half of the built-in feature `code-files` (SPECs/builtin-plugins-spec.md step 5, spec
//! `SPECs/code-files-spec.md`).
//!
//! The pure rules stay in core, `crate::code_files` (Tauri-free): the sidebar listing, the index
//! walker, the watcher, `NameCache`, `relocate` and the agent's change snapshots reach them there
//! and with the feature off they still need an answer, the notes-only one. That module is the one
//! seam: it holds the process-wide `Policy`, and this folder is what feeds it. The feature has no
//! command and no thread, so it has no hook either; it owns
//!
//! - the settings fragment (`../settings.schema.json`: the extension list, the ignored folders,
//!   the skills-folder switch, word wrap; the defaults the rules read live there too),
//! - [`STATE`], the one place that turns the settings and the feature's life into the policy:
//!   `Feature::apply_settings` (core calls it at startup and after every global write, whether or
//!   not the feature runs) stores the policy the settings ask for, `start` and `off` say whether
//!   the feature runs, and both publish through [`State::publish`]; the CLI has no lifecycle and
//!   calls [`apply_for_cli`].
//!
//! Not running (switched off, failed) the policy is `Policy::notes_only()`: no code
//! file and no skills folder is listed or opened as code, and the ignored-folder list is not
//! applied. It applies at once to the tree, the file watcher, rename and move. The index and quick open (`NameCache`) read the
//! policy when a workspace opens, so they follow at the next workspace open (the same rule as the
//! extension list). Safe mode and a web failure do not reach this half: they turn the web half
//! off for the session and the files stay listed.

mod extract;

use crate::code_files as cf;
use crate::config::{ConfigValue, Settings};
use crate::features::scope::FeatureScope;
use crate::features::{self, Feature, Manifest};
use crate::index::kinds::FileKind;
use parking_lot::Mutex;
use std::path::Path;
use tauri::{AppHandle, Runtime};

const MANIFEST: &str = include_str!("../feature.json");

pub struct CodeFiles;

impl<R: Runtime> Feature<R> for CodeFiles {
    fn manifest_source(&self) -> &'static str {
        MANIFEST
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    fn file_kinds(&self) -> &'static [FileKind] {
        &extract::KINDS
    }

    fn start(&self, _app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        STATE.set_running(true);
        Ok(())
    }

    fn off(&self) {
        STATE.set_running(false);
    }

    fn apply_settings(&self, settings: &Settings) {
        STATE.set_wanted(policy_for(settings));
    }
}

/// The policy the settings ask for while the feature runs, and whether it runs. Running is on
/// until the lifecycle says otherwise (`off` at install for a feature that does not start), so
/// the policy before `install` is the settings'.
pub static STATE: State = State::new();

pub struct State(Mutex<(bool, Option<cf::Policy>)>);

impl State {
    const fn new() -> Self {
        Self(Mutex::new((true, None)))
    }

    fn set_running(&self, running: bool) {
        let mut g = self.0.lock();
        g.0 = running;
        Self::publish(&g);
    }

    fn set_wanted(&self, wanted: cf::Policy) {
        let mut g = self.0.lock();
        g.1 = Some(wanted);
        Self::publish(&g);
    }

    fn publish(g: &(bool, Option<cf::Policy>)) {
        let (running, wanted) = g;
        if let Some(wanted) = wanted {
            cf::set_policy(policy_in_force(*running, wanted));
        }
    }
}

pub fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("code-files feature.json parses")
}

/// The policy in force: the settings' while the feature runs, notes-only (keeping the two core
/// listing settings and the gated kinds) while it does not.
fn policy_in_force(running: bool, wanted: &cf::Policy) -> cf::Policy {
    if running {
        return wanted.clone();
    }
    let mut off = cf::Policy::notes_only();
    off.show_images = wanted.show_images;
    off.show_pdfs = wanted.show_pdfs;
    off.features_off = wanted.features_off.clone();
    off
}

/// The policy the settings ask for while the feature runs: the four settings the rules read (plus
/// the two core listing settings, images and PDFs). Whether the feature runs is not a setting
/// here: it is the lifecycle's ([`STATE`]).
pub fn policy_for(settings: &Settings) -> cf::Policy {
    let list = |key: &str| match settings.get_global_or_default(key) {
        Some(ConfigValue::List(items)) => Some(items.clone()),
        _ => None,
    };
    let flag = |key: &str| {
        settings
            .get_global_or_default(key)
            .and_then(|v| v.as_bool())
    };
    let mut policy = cf::policy_from_settings(
        true,
        list(cf::SETTING_EXTENSIONS),
        list(cf::SETTING_IGNORED),
        flag(cf::SETTING_AGENT_FOLDERS),
        flag(cf::SETTING_IMAGES),
        flag(cf::SETTING_PDFS),
    );
    // the kinds a feature switch gates (`index::kinds::Gate::Feature`) follow the same policy
    policy.features_off = features::switched_off(|m| features::is_enabled(settings, m));
    policy
}

/// The `writer` CLI has no settings layer: it honours the kill switch (read from the global
/// `config` file) and uses the defaults for the rest.
pub fn apply_for_cli(data_dir: &Path) {
    let enabled = features::cli_enabled(data_dir, &manifest().id);
    let mut policy = cf::policy_from_settings(enabled, None, None, None, None, None);
    policy.features_off = features::switched_off(|m| features::cli_enabled(data_dir, &m.id));
    cf::set_policy(policy);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ConfigValue, Settings};
    use tempfile::TempDir;

    fn settings(values: &[(&str, ConfigValue)]) -> (TempDir, Settings) {
        let dir = TempDir::new().unwrap();
        let mut s = Settings::new(dir.path().to_path_buf()).unwrap();
        for (k, v) in values {
            s.set_global(k, v.clone()).unwrap();
        }
        (dir, s)
    }

    #[test]
    fn the_defaults_list_code_and_the_skills_folders() {
        let (_d, s) = settings(&[]);
        let p = policy_for(&s);
        assert!(p.code && p.show_agent_folders && p.show_images);
        assert!(p.extensions.contains("py") && p.ignored_folders.contains("node_modules"));
    }

    #[test]
    fn a_setting_changes_the_policy() {
        let (_d, s) = settings(&[
            (
                cf::SETTING_EXTENSIONS,
                ConfigValue::List(vec!["py".into(), ".RS".into()]),
            ),
            (
                cf::SETTING_IGNORED,
                ConfigValue::List(vec!["gen".into(), "out2".into()]),
            ),
            (cf::SETTING_AGENT_FOLDERS, ConfigValue::Bool(false)),
        ]);
        let p = policy_for(&s);
        assert_eq!(p.extensions.len(), 2);
        assert!(p.extensions.contains("rs"));
        assert!(p.ignored_folders.contains("gen") && !p.ignored_folders.contains("dist"));
        assert!(!p.show_agent_folders);
    }

    #[test]
    fn a_feature_that_is_not_running_gives_the_notes_only_policy_and_keeps_the_image_setting() {
        let (_d, s) = settings(&[]);
        let wanted = policy_for(&s);
        assert!(policy_in_force(true, &wanted).code);
        let p = policy_in_force(false, &wanted);
        assert!(!p.code && !p.show_agent_folders);
        assert!(p.extensions.is_empty() && p.ignored_folders.is_empty());
        assert!(p.show_images);
        let (_d, s) = settings(&[(cf::SETTING_IMAGES, ConfigValue::Bool(false))]);
        assert!(!policy_in_force(false, &policy_for(&s)).show_images);
    }

    #[test]
    fn the_cli_reads_the_switch_from_the_global_config_file() {
        let dir = TempDir::new().unwrap();
        assert!(features::cli_enabled(dir.path(), "code-files"));
        std::fs::write(
            dir.path().join("config"),
            "features.code-files.enabled = false\n",
        )
        .unwrap();
        assert!(!features::cli_enabled(dir.path(), "code-files"));
    }

    #[test]
    fn stopping_the_feature_degrades_the_policy_and_starting_it_brings_it_back() {
        // a state of its own and a policy of its own: nothing else's start or stop shows here
        let _policy = cf::test_policy_guard(cf::Policy::default());
        let (_d, s) = settings(&[]);
        let state = State::new();
        state.set_wanted(policy_for(&s));
        assert!(cf::policy().code, "running: code files are listed");
        state.set_running(false);
        assert!(!cf::policy().code, "stopped: notes only");
        state.set_running(true);
        assert!(cf::policy().code, "started again: code files are back");
    }
}
