//! The Rust half of the built-in feature `spellcheck` (ADR 2026-11-18 "check spelling and
//! grammar locally with Harper, Hunspell dictionaries and lingua", spec
//! `SPECs/spellcheck-spec.md`).
//!
//! The engine is Tauri-free and lives in `crate::spellcheck` (mask, language, providers, cache,
//! dictionaries, personal dictionary) so the `writer check` command runs the very same code.
//! This folder is the glue:
//!
//! - `commands.rs`: the `plugin:spellcheck|<command>` handlers (typed through `bindings.rs`):
//!   check a note, list, install and remove dictionaries, the personal dictionary and the words
//!   ignored in one note;
//! - `cli.rs`: the `writer check` command, contributed to the CLI registry;
//! - `start`: builds the engine state in the feature's scope. The engine itself is cheap to
//!   build; Harper's English dictionary, a Hunspell dictionary and the language detector load on
//!   the first check that needs them, and Harper's worker thread starts on the scope (a panic in
//!   it fails this feature, not the app; stopping the feature drops the engine, which ends it).
//!
//! No command here sends note text anywhere. The one network use is `spellcheck_install_dictionary`,
//! which the user starts, through the plugin store's egress-checked fetcher, for a file of the
//! pinned catalog.
//!
//! Switch off (`features.spellcheck.enabled`): the engine is dropped and its commands answer
//! `FeatureUnavailable`; switched on again it starts without a restart. `writer check` answers
//! that the feature is off.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::scope::FeatureScope;
use crate::features::{Feature, InvokeHandler};
use crate::spellcheck::harper::Spawner;
use crate::spellcheck::{dictionaries, ignored, personal, Checker};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

pub struct Spellcheck;

/// The managed state: one engine for every window of the app (the cache is shared), and the
/// personal dictionary read through a file-stamp cache.
pub struct Engine {
    pub checker: Arc<Checker>,
    pub personal: personal::Loader,
    /// The per-note ignored words (device-local, in `data_dir`).
    pub ignored: ignored::Loader,
    /// Where the ignored words live: the app data dir (a test points it at a temp dir).
    pub data_dir: parking_lot::RwLock<std::path::PathBuf>,
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

    fn start(&self, app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let threads = scope.spawner();
        let spawner: Spawner = Arc::new(move |name, f| threads.spawn(name, move |_| f()));
        let checker = Arc::new(Checker::new(dictionaries::dir(&data_dir), spawner));
        // the move and delete hooks of `vault_events` have no app handle: they find the store here
        ignored::set_data_dir(data_dir.clone());
        scope.manage(Engine {
            checker,
            personal: personal::Loader::default(),
            ignored: ignored::Loader::default(),
            data_dir: parking_lot::RwLock::new(data_dir),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests;
