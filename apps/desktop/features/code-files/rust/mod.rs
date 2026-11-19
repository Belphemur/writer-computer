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
//! - [`apply`], the one place that turns the settings and the kill switch into the policy
//!   (`commands::settings` calls it on every global write and at startup, the CLI calls
//!   [`apply_for_cli`]).
//!
//! Switched off (`features.code-files.enabled`) the policy is `Policy::notes_only()`: no code
//! file and no skills folder is listed or opened as code, and the ignored-folder list is not
//! applied. The switch is read from the settings on every write, so it applies at once to the
//! tree, the file watcher, rename and move. The index and quick open (`NameCache`) read the
//! policy when a workspace opens, so they follow at the next workspace open (the same rule as the
//! extension list). Safe mode and a web failure do not reach this half: they turn the web half
//! off for the session and the files stay listed.

use crate::code_files as cf;
use crate::config::{ConfigValue, Settings};
use crate::features::{self, Feature, Manifest};
use std::path::Path;
use tauri::Runtime;

const MANIFEST: &str = include_str!("../feature.json");

pub struct CodeFiles;

impl<R: Runtime> Feature<R> for CodeFiles {
    fn manifest_source(&self) -> &'static str {
        MANIFEST
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }
}

pub fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("code-files feature.json parses")
}

/// The policy the settings ask for: the switch (`features.code-files.enabled`) and the four
/// settings the rules read (plus the two core listing settings, images and PDFs).
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
    cf::policy_from_settings(
        features::is_enabled(settings, &manifest()),
        list(cf::SETTING_EXTENSIONS),
        list(cf::SETTING_IGNORED),
        flag(cf::SETTING_AGENT_FOLDERS),
        flag(cf::SETTING_IMAGES),
        flag(cf::SETTING_PDFS),
    )
}

/// Push the settings into the process-wide policy (at startup and after every global write).
pub fn apply(settings: &Settings) {
    cf::set_policy(policy_for(settings));
}

/// The `writer` CLI has no settings layer: it honours the kill switch (read from the global
/// `config` file) and uses the defaults for the rest.
pub fn apply_for_cli(data_dir: &Path) {
    let enabled = features::cli_enabled(data_dir, &manifest().id);
    cf::set_policy(cf::policy_from_settings(
        enabled, None, None, None, None, None,
    ));
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
    fn the_switch_off_gives_the_notes_only_policy_and_keeps_the_image_setting() {
        let (_d, s) = settings(&[("features.code-files.enabled", ConfigValue::Bool(false))]);
        let p = policy_for(&s);
        assert!(!p.code && !p.show_agent_folders);
        assert!(p.extensions.is_empty() && p.ignored_folders.is_empty());
        assert!(p.show_images);
        let (_d, s) = settings(&[
            ("features.code-files.enabled", ConfigValue::Bool(false)),
            (cf::SETTING_IMAGES, ConfigValue::Bool(false)),
        ]);
        assert!(!policy_for(&s).show_images);
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
}
