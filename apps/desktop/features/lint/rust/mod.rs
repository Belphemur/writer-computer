//! The Rust half of the built-in feature `lint` (ADR 2026-11-19 "lint Markdown with rumdl in a
//! built-in lint feature, safe fixes on save", spec `SPECs/markdown-lint-spec.md`).
//!
//! The engine is Tauri-free and lives in `crate::lint` (the rule registry, the Obsidian guard,
//! UTF-16 positions, the fix loop) so `writer lint` runs the very same code. This folder is the
//! glue:
//!
//! - `commands.rs`: `plugin:lint|lint_check` and `lint_fix`, over the calling window's settings;
//! - `cli.rs`: `writer lint` (reads) and `writer lint:fix` (writes through `vault_ops`), which the
//!   MCP server turns into a read tool and a write tool with no wiring of its own;
//! - the `writer-lint` agent skill (`../skills/`), contributed to the managed skills.
//!
//! Nothing here touches the network and no command logs note text. There is no state and no hook:
//! the feature is a plugin of two commands, CLI commands and a skill.
//!
//! Switch off (`features.lint.enabled`): at launch the plugin is not added (its commands are
//! "plugin not found" until the next launch), the web half goes at once, `writer lint` answers
//! that the feature is off and the skill is not installed.

mod bindings;
mod cli;
mod commands;

use crate::cli::registry::CommandSpec;
use crate::features::{Feature, InvokeHandler};
use crate::managed_skills::{BundledFile, BundledSkill};
use tauri::Runtime;

pub struct Lint;

static SKILLS: &[BundledSkill] = &[BundledSkill {
    name: "writer-lint",
    files: &[BundledFile {
        rel: "SKILL.md",
        content: include_str!("../skills/writer-lint/SKILL.md"),
    }],
}];

impl<R: Runtime> Feature<R> for Lint {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    /// The `plugin:lint|lint_*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn skills(&self) -> &'static [BundledSkill] {
        SKILLS
    }
}

#[cfg(test)]
mod tests;
