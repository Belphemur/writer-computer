//! The CLI-to-app channel (ADR 2026-11-18 "let the writer CLI talk to the running app over a
//! local, authenticated socket"; spec `SPECs/writer-cli-spec.md` "Talking to the running app").
//!
//! Tauri-free, like `index/` and `cli/`: the app's glue is `commands/ipc.rs` (the `Host`
//! implementation over windows and features, start and stop) and the web half is
//! `src/lib/ipc-requests.ts`.
//!
//! * `protocol.rs` — the newline-JSON messages, the error codes, the 64 KiB and 5 s limits
//! * `endpoint.rs` / `windows.rs` — the owner-only socket or pipe and the per-launch token
//! * `registry.rs` / `commands.rs` — the allowlist of commands; features extend it through
//!   `Feature::ipc_commands`
//! * `server.rs` — the accept loop and the guards a request meets
//! * `client.rs` — the blocking client of the `writer` CLI
//! * `host.rs` — the port to the running app
//! * `bridge.rs` — asking a window's web half and waiting for its answer

pub mod bridge;
pub mod client;
pub mod commands;
pub mod endpoint;
pub mod host;
pub mod protocol;
pub mod registry;
pub mod server;
#[cfg(windows)]
mod windows;

#[cfg(test)]
mod tests;

pub use host::{BoxFuture, Host};
pub use protocol::{ErrorCode, IpcError};
pub use registry::{boxed, Call, IpcCommand, Registry, VaultRule};
