//! The OpenCode agent backend: how Writer talks to `opencode serve` (spec
//! `SPECs/opencode-backend-spec.md`, ADR `2026-11-23-add-opencode-as-an-agent-backend-driven-
//! through-its-v2-server`). Everything OpenCode-specific is here; `agent/` and `features/agent/`
//! never name it (`import_graph_tests.rs` says so).
//!
//! Phase 2 (this): the wire, the mapper, the server and the transport, tested against a fake
//! OpenCode server. Not registered and not reachable from the app: the `agent.backends` point, the
//! picker and the settings are phase 4, the adapters and the config file phase 3. Until then the
//! pieces have no caller outside the tests (`features/mod.rs` allows dead code outside test
//! builds, and says why).
//!
//! - [`opencode_api`]: routes, request bodies and events, written once; the contract test pins
//!   them to `contract/openapi-2.4.0.json`.
//! - [`opencode_events`]: the pure mapper from one event to the neutral `AgentEvent`s.
//! - [`modes`]: the permission modes as rules of the session ([`modes::ModePolicy`], spec 10.9).
//! - [`client`]: HTTP with the Basic header, on the server's own runtime.
//! - [`server`]: [`server::OpencodeServer`], one per window and vault: the process, the one event
//!   stream, the fan-out to the chats.
//! - [`transport`]: [`transport::OpencodeTransport`], one per chat, the `Transport` of the agent.

pub mod client;
pub mod modes;
pub mod opencode_api;
pub mod opencode_events;
pub mod server;
pub mod transport;

#[cfg(test)]
mod events_tests;
#[cfg(test)]
mod fake_server_tests;
#[cfg(test)]
mod fixtures_tests;
#[cfg(test)]
mod import_graph_tests;
#[cfg(test)]
mod server_tests;
#[cfg(test)]
mod transport_tests;
