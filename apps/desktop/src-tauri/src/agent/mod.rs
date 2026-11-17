//! First-party agent pane backend. Spec: `SPECs/native-agent-spec.md`.
//!
//! This module currently holds the CONTRACT only:
//!
//! - `events` — the typed events/commands shared with the frontend (`src/lib/agent/events.ts`);
//! - `claude_stream` — pure mapping between the claude CLI's stream-json lines and those events,
//!   plus the stdin encoders and the argument vector.
//!
//! The process runner, session registry, chat store and project library are separate lanes (spec,
//! "Implementation plan") and add their own sibling modules here.

pub mod binary;
pub mod chat_store;
pub mod claude_stream;
pub mod consent;
pub mod env;
pub mod events;
pub mod permission_rules;
pub mod ports;
pub mod project;
pub mod project_context;
pub mod runner;
#[cfg(all(test, unix))]
mod runner_tests;
pub mod session;
