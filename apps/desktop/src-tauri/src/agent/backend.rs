//! What differs between the agents a chat can run on, in one value per backend (spec
//! `SPECs/opencode-backend-spec.md` section 5): its id, how it names its tools and renders the
//! roles (the adapter, which also hands out the tool table) and everything that touches its
//! program ([`BackendOps`]: how a chat connects, how the program is found, the one-shot title
//! call, what is done when a chat is deleted). `Session` and `AgentSessions` ask a `Backend` and
//! name none.
//!
//! Claude is the one backend of the core ([`claude`]). Every other one reaches the agent through
//! the `agent.backends` provider point ([`super::api::BACKENDS`]): a feature answers it with its
//! own [`Backend`], so the agent never imports or names it, and with that feature off the point
//! has no answer and a chat of that backend says so.

use super::api::BACKEND_CLAUDE;
use super::binary::{self, AgentBinaryInfo};
use super::claude_adapter::ClaudeAdapter;
use super::config_sync::{McpProbe, ProbeTarget, MCP_LIST_TIMEOUT};
use super::env;
use super::events::McpServerStatus;
use super::mcp_menu::{Applies, SwitchSpec};
use super::mcp_wiring::ToolsAdapter;
use super::roles::RoleAdapter;
use super::title::{ClaudeAsker, TitleAsker};
use super::tool_table::ToolTable;
use super::transport::{Transport, TransportInit};
use crate::features::scope::Spawner;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// Where a one-shot helper call of a chat runs (the title).
pub struct HelperCtx<'a> {
    pub spawner: &'a Spawner,
    /// The program, as found for this chat.
    pub program: &'a Path,
    /// The chat's own directory.
    pub cwd: &'a Path,
    /// The window and its vault root (canonical): a backend that keeps a server per window and
    /// vault finds it by these.
    pub label: &'a str,
    pub root: &'a Path,
}

/// A deleted chat: what its backend may still hold of it.
pub struct ForgetCtx<'a> {
    pub label: &'a str,
    pub root: &'a Path,
    /// The backend's own id of the chat's session, as the chat note kept it.
    pub session_id: &'a str,
}

/// Everything about a backend that touches its program.
pub trait BackendOps: Send + Sync {
    /// The setting that holds the user's own path to the program (`agent.binary-path`).
    fn binary_setting(&self) -> &'static str;

    /// The program alone, without any probe. Blocking (login shell).
    fn find(&self, override_path: Option<&str>) -> Option<PathBuf>;

    /// Where the program is and what it says about itself. Blocking.
    fn detect(&self, spawner: &Spawner, override_path: Option<&str>) -> AgentBinaryInfo;

    /// The managed `writer` skills are installed where this backend reads them, so a prompt may
    /// name the `writer` command.
    fn skills_installed(&self, root: &Path) -> bool;

    /// The MCP servers menu's switches for this backend: the list setting that holds them (in
    /// the backend's own fragment, `agent.<id>.*-mcp-servers`), whether servers are on unless
    /// listed, and when a switch takes effect. A contract test holds each answer to its fragment.
    /// `None`: the backend has no switches yet, and neither the menu nor the commands exist for it.
    fn mcp_switches(&self) -> Option<SwitchSpec>;

    /// The MCP servers this backend knows, with their states (names and states only). Blocking,
    /// and may start servers: the menu asks it on a click, never on a timer.
    /// `probe` is the port a backend that runs its program's own list command uses (the one the
    /// tests replace); a backend that asks its server ignores it. The one list source of the menu
    /// and of the config watch's re-check: no backend runs a CLI list unless this does.
    fn mcp_list(
        &self,
        ctx: &HelperCtx<'_>,
        probe: &dyn McpProbe,
    ) -> Result<Vec<McpServerStatus>, String>;

    /// Put the switches in force beyond the next start of a chat (a backend whose lever is a
    /// config it owns rewrites it here). Blocking. Nothing to do by default: Claude's switch is an
    /// argument of each spawn, read from the settings then.
    fn mcp_apply(&self, _ctx: &HelperCtx<'_>) -> Result<(), String> {
        Ok(())
    }

    /// Whether `id` can be this backend's session id (a resumed chat passes the one it stored).
    fn session_id_ok(&self, id: &str) -> bool;

    /// The transport of one chat.
    fn connect(&self, init: TransportInit) -> Result<Arc<dyn Transport>, String>;

    /// The one-shot call behind the automatic title; `None` when this backend cannot make one.
    fn titler<'a>(&self, ctx: &HelperCtx<'a>) -> Option<Box<dyn TitleAsker + 'a>>;

    /// The chat was deleted (not archived): drop what the backend keeps of it. Best effort, quiet,
    /// blocking.
    fn forget(&self, _ctx: &ForgetCtx<'_>) {}
}

pub struct Backend {
    /// The id the `agent.turn-finished` point, the chat note and the settings know the backend by.
    pub id: &'static str,
    roles: &'static (dyn RoleAdapter + Sync),
    ops: Arc<dyn BackendOps>,
}

impl Backend {
    pub fn new(
        id: &'static str,
        roles: &'static (dyn RoleAdapter + Sync),
        ops: Arc<dyn BackendOps>,
    ) -> Self {
        Self { id, roles, ops }
    }

    /// How the backend renders the roles, names Writer's tools and takes its MCP server.
    pub fn roles(&self) -> &'static dyn RoleAdapter {
        self.roles
    }

    pub fn mcp(&self) -> &'static dyn ToolsAdapter {
        self.roles
    }

    /// Its own tools (shell, edits, launch): the shared table of `shared/agent-tools/`.
    pub fn tools(&self) -> &'static ToolTable {
        self.roles.tool_table()
    }

    pub fn ops(&self) -> &dyn BackendOps {
        &*self.ops
    }

    pub fn writer_skills_installed(&self, root: &Path) -> bool {
        self.ops.skills_installed(root)
    }

    pub fn connect(&self, init: TransportInit) -> Result<Arc<dyn Transport>, String> {
        self.ops.connect(init)
    }
}

/// The switches of a backend a test brings (no setting of the schema: tests that read the list
/// through `SettingsPort` give it).
#[cfg(test)]
pub(crate) const FAKE_SWITCHES: SwitchSpec = SwitchSpec {
    setting: "agent.fake.mcp",
    default_on: true,
    applies: Applies::NextStart,
};

struct ClaudeOps;

impl BackendOps for ClaudeOps {
    fn binary_setting(&self) -> &'static str {
        "agent.binary-path"
    }

    fn find(&self, override_path: Option<&str>) -> Option<PathBuf> {
        binary::find(override_path)
    }

    fn detect(&self, spawner: &Spawner, override_path: Option<&str>) -> AgentBinaryInfo {
        binary::detect(spawner, override_path)
    }

    fn skills_installed(&self, root: &Path) -> bool {
        crate::managed_skills::claude_skills_installed(root)
    }

    fn session_id_ok(&self, id: &str) -> bool {
        is_uuid(id)
    }

    /// Servers are on unless listed (the CLI starts them all); a listed one is denied through
    /// `--disallowedTools` at each spawn, so a switch applies when the chat's session restarts.
    fn mcp_switches(&self) -> Option<SwitchSpec> {
        Some(SwitchSpec {
            setting: "agent.claude.disabled-mcp-servers",
            default_on: true,
            applies: Applies::NextStart,
        })
    }

    /// The CLI's own `claude mcp list` in the vault (it reads its config, Writer reads none).
    fn mcp_list(
        &self,
        ctx: &HelperCtx<'_>,
        probe: &dyn McpProbe,
    ) -> Result<Vec<McpServerStatus>, String> {
        probe.probe(
            &ProbeTarget {
                program: ctx.program.to_path_buf(),
                cwd: ctx.cwd.to_path_buf(),
                env: env::current(None),
            },
            MCP_LIST_TIMEOUT,
            ctx.spawner,
        )
    }

    fn connect(&self, init: TransportInit) -> Result<Arc<dyn Transport>, String> {
        super::stdio_transport::connect(init)
    }

    fn titler<'a>(&self, ctx: &HelperCtx<'a>) -> Option<Box<dyn TitleAsker + 'a>> {
        Some(Box::new(ClaudeAsker {
            spawner: ctx.spawner,
            program: ctx.program,
            cwd: ctx.cwd,
        }))
    }
}

/// A uuid in its canonical text form (Claude's session id is the chat id).
pub fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn claude_arc() -> &'static Arc<Backend> {
    static CLAUDE: OnceLock<Arc<Backend>> = OnceLock::new();
    CLAUDE.get_or_init(|| {
        Arc::new(Backend::new(
            BACKEND_CLAUDE,
            &ClaudeAdapter,
            Arc::new(ClaudeOps),
        ))
    })
}

pub fn claude() -> &'static Backend {
    claude_arc()
}

/// The core's own backend as a shared handle (a `Session` holds its backend by `Arc`).
pub fn claude_shared() -> Arc<Backend> {
    Arc::clone(claude_arc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::McpState;

    #[test]
    fn claude_keeps_its_mcp_switches_in_the_agent_fragment_and_servers_start_on() {
        let ops = ClaudeOps;
        crate::agent::mcp_menu::assert_switch_contract(
            BACKEND_CLAUDE,
            &ops.mcp_switches().unwrap(),
            include_str!("../../../features/agent/settings.schema.json"),
        );
        assert!(ops.mcp_switches().unwrap().default_on);
    }

    /// Claude's list is the CLI's own `mcp list` in the vault: names with a space, a dot and a
    /// colon survive (capture K1), only names and states are kept, and the program is run in the
    /// given folder with no argument but `mcp list`.
    #[test]
    fn claude_lists_its_servers_through_mcp_list_in_the_vault() {
        use std::os::unix::fs::PermissionsExt;
        std::env::set_var("SHELL", "/bin/sh");
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(
            &program,
            "#!/bin/sh\n[ \"$1 $2\" = \"mcp list\" ] || exit 9\npwd > \"$(dirname \"$0\")/cwd.txt\"\n\
             echo 'Checking MCP server health...'\n\
             echo 'claude.ai Atlassian: https://secret.example/mcp (HTTP) - ! Needs authentication'\n\
             echo 'my:srv: /bin/node /secret/server.js - \u{2714} Connected'\n\
             echo 'broken: /bin/x - \u{2717} Failed to connect'\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let vault = tempfile::tempdir().unwrap();
        let spawner = Spawner::detached();
        let got = ClaudeOps
            .mcp_list(
                &HelperCtx {
                    spawner: &spawner,
                    program: &program,
                    cwd: vault.path(),
                    label: "w",
                    root: vault.path(),
                },
                &crate::agent::config_sync::CliMcpProbe,
            )
            .unwrap();
        let pairs: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.status)).collect();
        assert_eq!(
            pairs,
            [
                ("claude.ai Atlassian", McpState::NeedsAuth),
                ("my:srv", McpState::Connected),
                ("broken", McpState::Failed),
            ]
        );
        assert!(!format!("{got:?}").contains("secret"), "no target is kept");
        let cwd = std::fs::read_to_string(dir.path().join("cwd.txt")).unwrap();
        assert_eq!(
            std::fs::canonicalize(cwd.trim()).unwrap(),
            vault.path().canonicalize().unwrap()
        );
    }
}
