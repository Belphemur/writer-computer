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

    /// Whether the program has a `mcp list` command that tells which MCP servers connect, which
    /// the config watch runs again after a server failed (Claude). A backend that reports the
    /// health of its servers by itself says `false`: nothing is run for it.
    fn mcp_cli_probe(&self) -> bool {
        true
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
