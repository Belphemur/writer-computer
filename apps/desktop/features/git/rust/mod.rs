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
//! contract in `crate::agent::api`); this feature extends them from `start` (ADR 2026-11-20 "let
//! features cooperate through owned points..."). The agent never learns git exists, and git works
//! alone: with the agent off it is still the history of the user's edits. The watcher is observed
//! through `watcher::observe_paths` (the one source of file changes, no second watcher).
//!
//! **Resources.** Everything the feature runs is owned by one struct, `runtime::Vaults`, kept in
//! the feature's scope (`scope.manage`) from `start`: the vaults' cadence state, the "stopped" and
//! "committing" flags. The ticker is a scope thread (it sleeps on the scope's token), the watcher
//! observer is `scope.observe`d and the point extensions are retracted when the scope stops
//! (`FeatureScope::shutdown` retracts every point the feature id extended); the observer and the
//! points call back into `Vaults`, which answers nothing after `shutdown()`. Busy is "a commit is
//! in progress". No static holds feature state and no raw thread is started.
//!
//! **Off, or on but the vault not set up**: nothing runs. With `features.git.enabled` off no
//! point is extended, its commands answer `FeatureUnavailable`, the web half goes at once, the CLI
//! commands answer "turned off" and the skill is not installed. A vault that is not set up
//! (Settings > Git) gets no commit, no timer action and no error from any hook.

mod bindings;
mod cli;
mod commands;
mod ipc;
pub(crate) mod runtime;
pub(crate) mod sync;
#[cfg(test)]
mod tests;

use crate::agent::api::{TURN_FINISHED, TURN_STARTED};
use crate::cli::registry::CommandSpec;
use crate::features::points;
use crate::features::scope::FeatureScope;
use crate::features::{Feature, InvokeHandler, WindowCtx};
use crate::ipc::IpcCommand;
use crate::managed_skills::{BundledFile, BundledSkill};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Runtime};

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

    fn ipc_commands(&self) -> &'static [IpcCommand] {
        ipc::COMMANDS
    }

    fn start(&self, app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        let vaults = scope.manage(runtime::Vaults::default());
        let weak = Arc::downgrade(&vaults);
        scope.on_stop({
            let w = weak.clone();
            move || {
                if let Some(v) = w.upgrade() {
                    v.shutdown();
                }
            }
        });
        scope.busy_probe({
            let w = weak.clone();
            move || {
                w.upgrade()
                    .and_then(|v| v.busy_reason())
                    .map(str::to_string)
            }
        });
        let handle = app.clone();
        points::extend(app, &TURN_STARTED, runtime::ID, move |args| {
            runtime::turn_started(&handle, args)
        });
        let handle = app.clone();
        points::extend(app, &TURN_FINISHED, runtime::ID, move |args| {
            runtime::turn_finished(&handle, args)
        });
        // every write in the vault, Writer's own included, resets the quiet timer
        scope
            .observe(Box::new(move |label, root, paths, _own| {
                if let Some(v) = weak.upgrade() {
                    v.written(label, root, &paths, Instant::now());
                }
            }))
            .map_err(|e| e.to_string())
    }

    fn on_workspace_open(&self, app: &AppHandle<R>, window: &WindowCtx<'_>) {
        let (Some(root), Some(v)) = (window.root, runtime::vaults(app)) else {
            return;
        };
        v.open(window.label, root);
        runtime::start_ticker(app);
    }

    fn on_workspace_close(&self, app: &AppHandle<R>, label: &str) {
        runtime::flush(app, label);
        if let Some(v) = runtime::vaults(app) {
            v.close(label);
        }
    }

    fn on_exit(&self, app: &AppHandle<R>) {
        if let Some(v) = runtime::vaults(app) {
            for label in v.labels() {
                runtime::flush(app, &label);
            }
            v.shutdown();
        }
    }
}
