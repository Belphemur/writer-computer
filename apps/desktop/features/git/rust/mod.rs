//! The Rust half of the built-in feature `git` (ADR 2026-11-18 "sync vaults with a built-in Git
//! feature", spec `SPECs/git-sync-spec.md`; phase 1: local version history).
//!
//! The engine is Tauri-free and lives in `crate::git` (repository access through gix, the commit
//! message builder, the managed ignore block, the cadence state machine) so `writer git:*` runs
//! the very same code. This folder is the glue:
//!
//! - `runtime.rs`: the vaults of the open windows, one ticker thread (a second's sleep, contained
//!   by `features::spawn`), the watcher observer, and the reactions to the agent's points;
//! - `commands.rs`: `plugin:git|git_*` (status, setup, commit now, pause);
//! - `cli.rs`: `writer git:status`, `git:log` (reads) and `git:commit` (write), which the MCP
//!   server turns into tools with no wiring of its own;
//! - the `writer-git` agent skill (`../skills/`).
//!
//! **How it cooperates.** The agent owns two points (`agent.turn-started`, `agent.turn-finished`,
//! contract in `crate::agent::api`); this feature extends them from `setup` (ADR 2026-11-20 "let
//! features cooperate through owned points..."). The agent never learns git exists, and git works
//! alone: with the agent off it is still the history of the user's edits. The watcher is observed
//! through `watcher::observe_paths` (the one source of file changes, no second watcher).
//!
//! **Resources.** Everything the feature runs is owned by one struct, `runtime::Vaults`, created
//! in `setup` and managed by the app: the vaults' cadence state, the ticker thread (through
//! `features::spawn`), the "stopped" and "committing" flags. The watcher observer and the point
//! extensions live in process-wide registries that cannot unregister; they call back into
//! `Vaults`, which answers nothing after `shutdown()` (that also retracts the extensions). No
//! static holds feature state and no raw thread is started.
//!
//! **Off, or on but the vault not set up**: nothing runs. With `features.git.enabled` off the
//! plugin is not added and no point is extended (restart), the web half goes at once, the CLI
//! commands answer "turned off" and the skill is not installed. A vault that is not set up
//! (Settings > Git) gets no commit, no timer action and no error from any hook.

mod bindings;
mod cli;
mod commands;
pub(crate) mod runtime;
#[cfg(test)]
mod tests;

use crate::agent::api::{TURN_FINISHED, TURN_STARTED};
use crate::cli::registry::CommandSpec;
use crate::features::points;
use crate::features::{Feature, InvokeHandler, WindowCtx};
use crate::managed_skills::{BundledFile, BundledSkill};
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime};

pub struct Git;

static SKILLS: &[BundledSkill] = &[BundledSkill {
    name: "writer-git",
    files: &[BundledFile {
        rel: "SKILL.md",
        content: include_str!("../skills/writer-git/SKILL.md"),
    }],
}];

impl<R: Runtime> Feature<R> for Git {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn skills(&self) -> &'static [BundledSkill] {
        SKILLS
    }

    fn setup(&self, app: &AppHandle<R>) -> Result<(), String> {
        if !app.manage(runtime::Vaults::default()) {
            return Err("git state is already managed".into());
        }
        let handle = app.clone();
        points::extend(app, &TURN_STARTED, "git", move |args| {
            runtime::turn_started(&handle, args)
        });
        let handle = app.clone();
        points::extend(app, &TURN_FINISHED, "git", move |args| {
            runtime::turn_finished(&handle, args)
        });
        // every write in the vault, Writer's own included, resets the quiet timer
        let handle = app.clone();
        crate::watcher::observe_paths(Box::new(move |label, root, paths, _own| {
            if let Some(v) = handle.try_state::<runtime::Vaults>() {
                v.written(label, root, &paths, Instant::now());
            }
        }));
        Ok(())
    }

    fn on_workspace_open(&self, app: &AppHandle<R>, window: &WindowCtx<'_>) {
        let (Some(root), Some(v)) = (window.root, app.try_state::<runtime::Vaults>()) else {
            return;
        };
        v.open(window.label, root);
        runtime::start_ticker(app);
    }

    fn on_workspace_close(&self, app: &AppHandle<R>, label: &str) {
        runtime::flush(app, label);
        if let Some(v) = app.try_state::<runtime::Vaults>() {
            v.close(label);
        }
    }

    fn on_exit(&self, app: &AppHandle<R>) {
        if let Some(v) = app.try_state::<runtime::Vaults>() {
            for label in v.labels() {
                runtime::flush(app, &label);
            }
            v.shutdown();
        }
    }
}
