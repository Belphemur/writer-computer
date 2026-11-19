//! Tasks: the Tauri-free core of the `tasks` feature (spec `SPECs/tasks-spec.md`, ADR
//! `2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases`).
//!
//! - `grammar`: list items, task lines, the emoji and Dataview field formats, byte-minimal edits;
//! - `status`, `recurrence`, `urgency`, `date`: the rules, no calendar crate;
//! - `settings`: the vault's format and custom statuses (read-only Obsidian layer);
//! - `edit`, `ops`: toggle, set a field, add a task: pure text, then the one vault write path;
//! - `block`: the `tasks` query block and its lowering to a `rows: tasks` base.
//!
//! The index (`index/`) stores what `grammar` reads; Bases rows are built from it
//! (`index/bases_source.rs`); the `writer` CLI and the Tauri glue in `features/tasks/` call
//! `ops`.

pub mod block;
pub mod date;
pub mod edit;
pub mod grammar;
pub mod ops;
pub mod page;
pub mod recurrence;
pub mod settings;
pub mod status;
pub mod urgency;
