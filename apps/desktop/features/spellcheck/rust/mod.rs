//! The Rust half of the built-in feature `spellcheck` (ADR 2026-11-18 "check spelling and
//! grammar locally with Harper, Hunspell dictionaries and lingua", spec
//! `SPECs/spellcheck-spec.md`).
//!
//! The engine is Tauri-free and lives in `crate::spellcheck` (mask, language, providers, cache,
//! dictionaries, personal dictionary) so the `writer check` command runs the very same code.
//! This folder is the glue:
//!
//! - `commands.rs`: the `plugin:spellcheck|<command>` handlers (typed through `bindings.rs`):
//!   check a note, list, install and remove dictionaries, and the personal dictionary;
//! - `cli.rs`: the `writer check` command, contributed to the CLI registry;
//! - `setup`: builds the engine state. The engine itself is cheap to build; Harper's English
//!   dictionary, a Hunspell dictionary and the language detector load on the first check that
//!   needs them, and Harper's worker thread starts through `features::spawn` (a panic in it fails
//!   this feature, not the app).
//!
//! No command here sends note text anywhere. The one network use is `spellcheck_install_dictionary`,
//! which the user starts, through the plugin store's egress-checked fetcher, for a file of the
//! pinned catalog.
//!
//! Switch off (`features.spellcheck.enabled`): at launch the plugin is not added (its commands are
//! "plugin not found" until the next launch) and the web half goes at once. `writer check`
//! answers that the feature is off.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::{Feature, InvokeHandler};
use crate::spellcheck::harper::Spawner;
use crate::spellcheck::{dictionaries, personal, Checker};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

pub struct Spellcheck;

/// The managed state: one engine for every window of the app (the cache is shared), and the
/// personal dictionary read through a file-stamp cache.
pub struct Engine {
    pub checker: Arc<Checker>,
    pub personal: personal::Loader,
}

impl<R: Runtime> Feature<R> for Spellcheck {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    /// The `plugin:spellcheck|spellcheck_*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn setup(&self, app: &AppHandle<R>) -> Result<(), String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let handle = app.clone();
        let spawner: Spawner = Arc::new(move |name, f| {
            crate::features::spawn(&handle, "spellcheck", name, f).map(drop)
        });
        let checker = Arc::new(Checker::new(dictionaries::dir(&data_dir), spawner));
        if !app.manage(Engine {
            checker,
            personal: personal::Loader::default(),
        }) {
            return Err("the spellcheck engine is already managed".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
