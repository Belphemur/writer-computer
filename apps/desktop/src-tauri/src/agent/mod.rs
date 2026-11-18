//! First-party agent pane backend. Spec: `SPECs/native-agent-spec.md`.
//!
//! This module currently holds the CONTRACT only:
//!
//! - `events` — the typed events/commands shared with the frontend (generated into `features/agent/web/bindings.ts`);
//! - `claude_stream` — pure mapping between the claude CLI's stream-json lines and those events,
//!   plus the stdin encoders and the argument vector.
//!
//! The process runner, session registry, chat store and project library are separate lanes (spec,
//! "Implementation plan") and add their own sibling modules here.

pub mod binary;
pub mod changes;
pub mod chat_store;
pub mod claude_stream;
pub mod cli_launcher;
pub mod command_windows;
pub mod config_sync;
pub mod edit_inverse;
pub mod env;
pub mod events;
pub mod images;
pub mod line_diff;
pub mod memory;
pub mod permission_rules;
pub mod ports;
pub mod project;
pub mod project_context;
pub mod roles;
pub mod runner;
#[cfg(all(test, unix))]
mod runner_tests;
pub mod session;
pub mod skills;
pub mod sub_tracker;
pub mod subagents;
pub mod title;
pub mod writer_prompt;
