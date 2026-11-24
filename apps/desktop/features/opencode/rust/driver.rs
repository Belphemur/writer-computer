//! What the agent asks of OpenCode through the `agent.backends` point: the [`Backend`] value
//! ([`backend`]) and its [`BackendOps`] ([`Driver`]): how a chat connects, how the program is
//! found, the title call and what is done when a chat is deleted. The pure pieces (the adapter,
//! the policy, the transport) are the siblings; this is the glue to the app's servers.

use super::adapter::{self, OpencodeAdapter};
use super::client::{Client, SHORT};
use super::config;
use super::modes::{Disabled, ModePolicy};
use super::opencode_api::{self as api, CreateSessionBody, GenerateBody, Location, ModelRef};
use super::server::{version_ok, OpencodeServer};
use super::servers::{delete_session, Servers, PROGRAM};
use super::transport::OpencodeTransport;
use crate::agent::backend::{Backend, BackendOps, ForgetCtx, HelperCtx};
use crate::agent::binary::{self, AgentBinaryInfo};
use crate::agent::config_sync::McpProbe;
use crate::agent::events::{McpServerStatus, McpState};
use crate::agent::mcp_menu::SwitchSpec;
use crate::agent::title::{sanitize_title, TitleAsker};
use crate::agent::transport::{Transport, TransportInit};
use crate::features::scope::Spawner;
use parking_lot::Mutex;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::Runtime;

/// The id of the backend: the chat note's `writer-chat-backend`, the settings' namespace.
pub const ID: &str = "opencode";
/// The setting with the slugs of the models switched off in Settings.
const DISABLED_MODELS_SETTING: &str = "agent.opencode.disabled-models";
/// How long the list of MCP servers may take.
const MCP_LIST_WAIT: Duration = Duration::from_secs(20);
/// How long a title call may take, in all (a session made, asked and deleted).
const TITLE_WAIT: Duration = Duration::from_secs(45);

pub struct Driver<R: Runtime> {
    servers: Arc<Servers<R>>,
}

/// The backend value the feature answers `agent.backends` with.
pub fn backend<R: Runtime>(servers: Arc<Servers<R>>) -> Arc<Backend> {
    Arc::new(Backend::new(
        ID,
        &OpencodeAdapter,
        Arc::new(Driver { servers }),
    ))
}

/// An OpenCode session id: `ses_` and letters or digits (the shape of the fixtures and of the
/// ids the server hands out). Checked before it reaches a URL.
pub fn session_id_ok(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

impl<R: Runtime> BackendOps for Driver<R> {
    fn binary_setting(&self) -> &'static str {
        super::servers::BINARY_SETTING
    }

    fn find(&self, override_path: Option<&str>) -> Option<PathBuf> {
        binary::find_program(&PROGRAM, override_path)
    }

    fn detect(&self, spawner: &Spawner, override_path: Option<&str>) -> AgentBinaryInfo {
        detect(spawner, override_path)
    }

    /// The managed skills are installed in `.claude/skills` and `.agents/skills` alike; Writer's
    /// config lists both folders for OpenCode (`skills`), so what is installed there is loaded.
    fn skills_installed(&self, root: &Path) -> bool {
        crate::managed_skills::claude_skills_installed(root)
    }

    fn session_id_ok(&self, id: &str) -> bool {
        session_id_ok(id)
    }

    /// The MCP switches (ADR 2026-11-24): `agent.opencode.enabled-mcp-servers`, off unless listed.
    /// They are in force at once: Writer's config file renders them as policies and placeholders
    /// and the server reads it again (`mcp_apply`).
    fn mcp_switches(&self) -> Option<SwitchSpec> {
        Some(config::MCP_SWITCHES)
    }

    /// What the server reports (`GET /api/mcp`, the one mapper of `SessionStarted`) together with
    /// the names it found in the user's config: a server held off by the deny-all policies is not
    /// listed by the server, so it is a `disabled` row. What the server listed is kept as known,
    /// so it can be switched (a built-in server too).
    fn mcp_list(
        &self,
        ctx: &HelperCtx<'_>,
        _probe: &dyn McpProbe,
    ) -> Result<Vec<McpServerStatus>, String> {
        let server = self.servers.ensure_up(ctx.label, ctx.root)?;
        let client = server.connection().ok_or("OpenCode is not running")?.client;
        let mut rows = server
            .io()
            .call(
                async move { client.get(&api::MCP, &[]).await },
                MCP_LIST_WAIT,
            )
            .ok_or("OpenCode did not answer")?
            .map(api::mcp_statuses)
            .map_err(|_| "OpenCode could not list its MCP servers".to_string())?;
        server.learn_mcp(rows.iter().map(|s| s.name.clone()));
        let held_off: Vec<McpServerStatus> = server
            .mcp_known()
            .into_iter()
            .filter(|n| !rows.iter().any(|s| &s.name == n))
            .map(|name| McpServerStatus {
                name,
                status: McpState::Disabled,
            })
            .collect();
        rows.extend(held_off);
        Ok(rows)
    }

    /// A switch changed: the config is rendered again and read again when no turn runs.
    fn mcp_apply(&self, ctx: &HelperCtx<'_>) -> Result<(), String> {
        self.servers.reapply(ctx.label)
    }

    fn connect(&self, init: TransportInit) -> Result<Arc<dyn Transport>, String> {
        let server = self.servers.server(&init.label, &init.root)?;
        // the models the user switched off, read at each start of the chat
        let (app, label) = (self.servers.app().clone(), init.label.clone());
        let disabled: Disabled =
            Arc::new(move || crate::config::global_list(&app, &label, DISABLED_MODELS_SETTING));
        let (app, label) = (self.servers.app().clone(), init.label.clone());
        let providers_off: Disabled = Arc::new(move || {
            crate::config::global_list(&app, &label, config::PROVIDERS_OFF_SETTING)
        });
        let policy = ModePolicy::new(adapter::table())
            .with_disabled(disabled)
            .with_providers_off(providers_off)
            .for_vault(init.root.clone());
        Ok(Arc::new(OpencodeTransport::new(
            init,
            server,
            Arc::new(policy),
        )))
    }

    fn titler<'a>(&self, ctx: &HelperCtx<'a>) -> Option<Box<dyn TitleAsker + 'a>> {
        // up already for a chat that is open; started (and its config written) for one that is not
        let server = self
            .servers
            .ensure_up(ctx.label, ctx.root)
            .inspect_err(|_| log::debug!(target: "opencode", "opencode: no title call (no server)"))
            .ok()?;
        // a title session that could not be deleted is kept to be deleted at the next start
        let (servers, root) = (Arc::clone(&self.servers), ctx.root.to_path_buf());
        let leaked: Leaked = Arc::new(move |id| servers.record(&root, id));
        Some(titler_for(server, ctx.cwd.to_path_buf(), leaked))
    }

    /// Deleted now when the server is up, else kept and deleted when one starts: nothing is started
    /// just to delete.
    fn forget(&self, ctx: &ForgetCtx<'_>) {
        if session_id_ok(ctx.session_id) {
            self.servers.forget(ctx.label, ctx.root, ctx.session_id);
        }
    }
}

/// The title call on `server`, run in the chat's own directory `cwd`.
pub(super) fn titler_for<'a>(
    server: Arc<OpencodeServer>,
    cwd: PathBuf,
    leaked: Leaked,
) -> Box<dyn TitleAsker + 'a> {
    Box::new(Asker {
        server,
        cwd,
        leaked,
    })
}

/// Told the id of a title session that is still there after the call (it could not be deleted, or
/// the call was cut short by the server stopping).
pub(super) type Leaked = Arc<dyn Fn(&str) + Send + Sync>;

/// The title call: a throwaway session on the model asked for (the cheap tier, so the cost of a
/// title is the cheap model's, never the chat's), one `generate`, then the session is deleted.
/// OpenCode's own title agent stays switched off in Writer's config (decision A5).
struct Asker {
    server: Arc<OpencodeServer>,
    cwd: PathBuf,
    leaked: Leaked,
}

/// The models a title call tries: the cheap tier's when it is a `provider/model`, then the
/// chat's own when it differs. A backend whose models are named `provider/model` has no default
/// to fall back to: with neither, no title.
pub fn title_candidates(setting: Option<&str>, chat_model: Option<&str>) -> Vec<Option<String>> {
    let usable = |m: Option<&str>| {
        m.map(str::trim)
            .and_then(ModelRef::parse)
            .map(|r| ModelRef { variant: None, ..r })
            .map(|r| r.slug())
    };
    let cheap = usable(setting);
    let chat = usable(chat_model).filter(|c| Some(c) != cheap.as_ref());
    [cheap, chat].into_iter().flatten().map(Some).collect()
}

impl TitleAsker for Asker {
    fn candidates(&self, setting: Option<&str>, chat_model: Option<&str>) -> Vec<Option<String>> {
        title_candidates(setting, chat_model)
    }

    fn ask(&self, model: Option<&str>, system: &str, prompt: &str) -> Option<String> {
        let model = ModelRef::parse(model?)?;
        let conn = self.server.connection()?;
        let client = conn.client.clone();
        let (directory, text) = (
            self.cwd.to_string_lossy().into_owned(),
            format!("{system}\n\n{prompt}"),
        );
        let open = Arc::new(Mutex::new(None));
        let title = self
            .server
            .io()
            .call(
                generate(
                    client,
                    Arc::clone(&self.server),
                    directory,
                    model,
                    text,
                    Arc::clone(&open),
                ),
                TITLE_WAIT,
            )
            .flatten();
        // the runtime may have stopped under the call (the window closed): the session is still
        // there, so it is kept to be deleted at the next start
        if let Some(id) = open.lock().take() {
            (self.leaked)(&id);
        }
        title.and_then(|t| sanitize_title(&t))
    }
}

/// Makes the session, asks, deletes it (whatever the answer was). `None` on any failure.
async fn generate(
    client: Client,
    server: Arc<OpencodeServer>,
    directory: String,
    model: ModelRef,
    prompt: String,
    open: Arc<Mutex<Option<String>>>,
) -> Option<String> {
    let body = CreateSessionBody {
        location: Location { directory },
        model: Some(model),
        // nothing to run in a title call: every tool is denied, whatever the agent's own rules
        permissions: Some(vec![
            json!({"action": "*", "resource": "*", "effect": "deny"}),
        ]),
        ..Default::default()
    };
    let made = client
        .send(&api::SESSION_CREATE, &[], &body, SHORT)
        .await
        .ok()?;
    let id = made["data"]["id"].as_str()?.to_string();
    // not a chat's turn: it must not hold a reload, nor count as a running turn
    server.untrack(&id);
    *open.lock() = Some(id.clone());
    let reply = client
        .send(
            &api::GENERATE,
            &[("sessionID", &id)],
            &GenerateBody { prompt },
            Duration::from_secs(30),
        )
        .await;
    // whatever the answer was, the session goes; one that is not deleted is the caller's to keep
    if delete_session(&client, &id).await {
        *open.lock() = None;
    }
    reply.ok()?["data"]["text"].as_str().map(str::to_string)
}

/// The program as found and probed, with the version rule filled in: the one detection, for a
/// chat's start and for Settings.
pub fn detect(spawner: &Spawner, override_path: Option<&str>) -> AgentBinaryInfo {
    let mut info = binary::detect_program(spawner, &PROGRAM, override_path, false);
    info.supported = info.version.as_deref().map(version_ok);
    info.min_version = Some(api::MIN_VERSION.to_string());
    info
}
