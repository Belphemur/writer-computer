//! What differs between the agents a chat can run on, in one value per backend (spec
//! `SPECs/opencode-backend-spec.md` section 5): its id, how it names its tools and renders the
//! roles (the adapter, which also hands out the tool table), whether its managed skills are
//! installed and how a chat connects to it (the [`Transport`]). `Session` and `AgentSessions` ask
//! a `Backend` and name none. Claude is the only backend until the `agent.backends` point
//! (phase 4); a second one is one more static here, never a branch elsewhere.

use super::api::BACKEND_CLAUDE;
use super::claude_adapter::ClaudeAdapter;
use super::mcp_wiring::ToolsAdapter;
use super::roles::RoleAdapter;
use super::tool_table::ToolTable;
use super::transport::{Transport, TransportInit};
use std::path::Path;
use std::sync::Arc;

pub struct Backend {
    /// The id the `agent.turn-finished` point and the settings know the backend by.
    pub id: &'static str,
    roles: &'static (dyn RoleAdapter + Sync),
    skills_installed: fn(&Path) -> bool,
    transport: fn(TransportInit) -> Result<Arc<dyn Transport>, String>,
}

impl Backend {
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

    /// The managed `writer` skills are installed where this backend reads them, so a prompt may
    /// name the `writer` command.
    pub fn writer_skills_installed(&self, root: &Path) -> bool {
        (self.skills_installed)(root)
    }

    /// The transport of one chat.
    pub fn connect(&self, init: TransportInit) -> Result<Arc<dyn Transport>, String> {
        (self.transport)(init)
    }
}

static CLAUDE: Backend = Backend {
    id: BACKEND_CLAUDE,
    roles: &ClaudeAdapter,
    skills_installed: crate::managed_skills::claude_skills_installed,
    transport: super::stdio_transport::connect,
};

pub fn claude() -> &'static Backend {
    &CLAUDE
}

/// The backend a new chat runs on.
pub fn for_new_chat() -> &'static Backend {
    claude()
}
