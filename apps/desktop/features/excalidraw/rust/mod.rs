//! The Rust half of the built-in feature `excalidraw` (ADR 2026-11-18 "draw natively with a
//! built-in Excalidraw feature compatible with Obsidian drawings", spec
//! `SPECs/excalidraw-spec.md`). All the logic that does not need the canvas lives here, Tauri-free,
//! so the `writer` CLI and the app share it:
//!
//! - `lz.rs`, `excalidraw_md.rs`: the codec of `.excalidraw.md` and `.excalidraw` (twin of the
//!   editor's TypeScript codec, both held to `shared/excalidraw-fixtures/`);
//! - `layout.rs`, `elements.rs`: the compact spec to elements (ids, sizes, bound text, arrow
//!   bindings, layered layout), reading a drawing back as a spec, and validation;
//! - `cli.rs`: the five `writer excalidraw:*` commands; `ipc.rs`: `excalidraw:export`, the one
//!   socket command, answered by the window;
//! - the `writer-excalidraw` (commands) and `writer-diagram` (workflow) agent skills (`../skills/`),
//!   contributed to the managed skills.
//!
//! The feature has no Tauri command, event or hook, so no plugin and no capability file: it is a
//! registry entry that contributes CLI commands, one socket command, a skill and settings. Each
//! contribution honours the kill switch itself (`cli::feature_off`, the socket's `feature_off`,
//! `managed_skills::sync_except`).

mod cli;
mod elements;
mod excalidraw_md;
mod extract;
mod ipc;
mod layout;
mod lint;
mod lz;
mod previews;

use crate::cli::registry::CommandSpec;
use crate::features::Feature;
use crate::index::kinds::FileKind;
use crate::ipc::IpcCommand;
use crate::managed_skills::{BundledFile, BundledSkill};
use tauri::Runtime;

pub struct Excalidraw;

static SKILLS: &[BundledSkill] = &[
    BundledSkill {
        name: "writer-excalidraw",
        files: &[
            BundledFile {
                rel: "SKILL.md",
                content: include_str!("../skills/writer-excalidraw/SKILL.md"),
            },
            BundledFile {
                rel: "references/examples.md",
                content: include_str!("../skills/writer-excalidraw/references/examples.md"),
            },
        ],
    },
    BundledSkill {
        name: "writer-diagram",
        files: &[BundledFile {
            rel: "SKILL.md",
            content: include_str!("../skills/writer-diagram/SKILL.md"),
        }],
    },
];

impl<R: Runtime> Feature<R> for Excalidraw {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    fn cli_commands(&self) -> &'static [CommandSpec] {
        cli::COMMANDS
    }

    fn file_kinds(&self) -> &'static [FileKind] {
        &extract::KINDS
    }

    fn ipc_commands(&self) -> &'static [IpcCommand] {
        ipc::COMMANDS
    }

    fn skills(&self) -> &'static [BundledSkill] {
        SKILLS
    }
}

#[cfg(test)]
mod tests;
