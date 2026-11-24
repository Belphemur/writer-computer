//! The OpenCode agent backend: how Writer talks to `opencode serve` (spec
//! `SPECs/opencode-backend-spec.md`, ADR `2026-11-23-add-opencode-as-an-agent-backend-driven-
//! through-its-v2-server`). Everything OpenCode-specific is here; `agent/` and `features/agent/`
//! never name it (`import_graph_tests.rs` says so).
//!
//! Phase 2: the wire, the mapper, the server and the transport, tested against a fake OpenCode
//! server. Phase 3: the adapter, the config file, the permission modes as a policy and the
//! isolation of the server's environment. Phase 4 (this file): the feature itself. It answers the
//! agent's `agent.backends` point with the OpenCode [`driver`], owns one [`servers::Servers`] in
//! its scope (a server per window and vault, stopped with the window, the vault or the feature:
//! switched off, no process remains) and serves Settings > Agent > OpenCode through its commands.
//!
//! Off, or on but OpenCode not installed: nothing runs. With the switch off the point has no
//! answer (a chat of this backend says it is not available), the commands answer
//! `FeatureUnavailable` and the web half goes at once. Installed or not, no process starts until
//! a chat asks for one or Settings asks for the model list.
//!
//! - [`adapter`]: [`adapter::OpencodeAdapter`], the `RoleAdapter` and `ToolsAdapter` of OpenCode,
//!   with the tool table (`tools.json`).
//! - [`config`]: Writer's config file, built from the adapter's output and the vault.
//! - [`opencode_api`]: routes, request bodies and events, written once; the contract test pins
//!   them to `contract/openapi-2.4.0.json`.
//! - [`opencode_events`]: the pure mapper from one event to the neutral `AgentEvent`s.
//! - [`modes`]: the permission modes as rules of the session ([`modes::ModePolicy`], spec 10.9).
//! - [`client`]: HTTP with the Basic header, on the server's own runtime.
//! - [`server`]: [`server::OpencodeServer`], one per window and vault: the process, the one event
//!   stream, the fan-out to the chats.
//! - [`transport`]: [`transport::OpencodeTransport`], one per chat, the `Transport` of the agent.

pub mod adapter;
mod bindings;
pub mod client;
mod commands;
pub mod config;
pub mod driver;
pub mod in_force;
pub mod models;
pub mod modes;
pub mod opencode_api;
pub mod opencode_events;
pub mod server;
pub mod servers;
pub mod transport;

use crate::agent::api::BACKENDS;
use crate::features::scope::{FeatureScope, Kind};
use crate::features::{self, points, Feature, InvokeHandler};
use servers::Servers;
use std::sync::Arc;
use tauri::{AppHandle, Runtime};

pub struct Opencode;

/// The servers of the started feature, `None` while it is off.
pub(crate) fn servers_if_started<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Servers<R>>> {
    features::state_of::<R, Servers<R>>(app, driver::ID)
}

impl<R: Runtime> Feature<R> for Opencode {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn settings_source(&self) -> Option<&'static str> {
        Some(include_str!("../settings.schema.json"))
    }

    /// The `plugin:opencode|opencode_*` commands; the list is `bindings::builder`.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(Box::new(bindings::builder::<R>().invoke_handler()))
    }

    fn start(&self, app: &AppHandle<R>, scope: &FeatureScope) -> Result<(), String> {
        let servers = scope.manage(Servers::new(app.clone(), scope.spawner()));
        // the closures kept by the scope hold the state weakly, or it would outlive its stop
        let weak = Arc::downgrade(&servers);
        scope.adopt(Kind::Process, {
            let w = weak.clone();
            move || w.upgrade().map_or(0, |s| s.count())
        });
        scope.on_stop({
            let w = weak.clone();
            move || {
                if let Some(s) = w.upgrade() {
                    s.shutdown_all();
                }
            }
        });
        // turning it off while a turn runs would cut the turn short: the Features section asks first
        scope.busy_probe({
            let w = weak.clone();
            move || {
                let n = w.upgrade()?.running_turns();
                (n > 0)
                    .then(|| format!("{n} running OpenCode turn{}", if n == 1 { "" } else { "s" }))
            }
        });
        // the agent asks "give me backend <id>" when a chat starts; only this id is ours
        points::provide(app, &BACKENDS, driver::ID, move |id: &String| {
            (id == driver::ID)
                .then(|| weak.upgrade().map(driver::backend))
                .flatten()
        });
        Ok(())
    }

    /// The window closed or left its vault: its server, and every chat on it, go.
    fn on_workspace_close(&self, app: &AppHandle<R>, label: &str) {
        if let Some(s) = servers_if_started(app) {
            s.shutdown_window(label);
        }
    }

    /// `RunEvent::Exit`: no OpenCode process outlives the app.
    fn on_exit(&self, app: &AppHandle<R>) {
        if let Some(s) = servers_if_started(app) {
            s.shutdown_all();
        }
    }
}

#[cfg(test)]
mod events_tests;
#[cfg(test)]
mod fake_server_tests;
#[cfg(test)]
mod feature_tests;
#[cfg(test)]
mod fixtures_tests;
#[cfg(test)]
mod import_graph_tests;
#[cfg(test)]
mod server_tests;
#[cfg(test)]
mod transport_tests;
