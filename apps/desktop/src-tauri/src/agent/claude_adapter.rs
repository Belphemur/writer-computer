//! The adapter for the `claude` CLI: how Claude names Writer's MCP tools, takes the server, which
//! of its tools each capability grants and how the roles become the `--agents` JSON (ADR "Define
//! agent roles once and map them to each agent backend through adapters"; ADR 2026-11-19; spec
//! `SPECs/agent-roles-spec.md`, "Backend adapters"). With `claude_stream.rs` and the tool table
//! (`shared/agent-tools/claude.json`) the only code that spells Claude's tool names: the boundary
//! test (`boundary_tests.rs`) exempts exactly these three. Tauri-free, pure. The tier helpers
//! (`tier_model`) and the launch resolution stay in `subagents.rs`, which names no tool.

use super::mcp_wiring::{Launch, ToolsAdapter, WriterServer};
use super::roles::{
    backend_name, delegation_sentence, leak_read_tools, offered_roles, role_prompt, role_tools,
    CapabilitySupport, RenderInput, Rendered, RenderedRole, RoleAdapter,
};
use super::subagents::role_model;
use super::tool_table::{Role, ToolTable};
use crate::cli::mcp::{self, ToolSpec};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

/// The adapter for the `claude` CLI.
#[derive(Debug)]
pub struct ClaudeAdapter;

/// Claude's tool table, `shared/agent-tools/claude.json` (read by the web with the same file).
fn table() -> &'static ToolTable {
    static TABLE: OnceLock<ToolTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        ToolTable::parse(include_str!("../../../shared/agent-tools/claude.json"))
            .expect("shared/agent-tools/claude.json is a tool table")
    })
}

/// The tool names behind the capabilities of a role, read off the table's roles (no name is
/// spelled here).
struct CapabilityTools {
    read: Vec<&'static str>,
    edit: Vec<&'static str>,
    write: Vec<&'static str>,
    shell: Vec<&'static str>,
}

fn tools() -> &'static CapabilityTools {
    static TOOLS: OnceLock<CapabilityTools> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let t = table();
        CapabilityTools {
            read: t.names_of(Role::Read),
            edit: [t.names_of(Role::Replace), t.names_of(Role::MultiReplace)].concat(),
            write: t.names_of(Role::Create),
            shell: t.names_of(Role::Shell),
        }
    })
}

/// What the prompt calls a launch ("Agent/Task calls"): the launch tools of the table, built and
/// leaked once.
fn launch_label() -> &'static str {
    static LABEL: OnceLock<&'static str> = OnceLock::new();
    LABEL.get_or_init(|| {
        let names = table().names_of(Role::Launch).join("/");
        Box::leak(format!("{names} calls").into_boxed_str())
    })
}

/// Writer's MCP server for the CLI (ADR 2026-11-19 "Hand Writer's MCP server to every agent
/// backend through its adapter"): the CLI names a server's tool `mcp__<server>__<tool>`, takes
/// the server as `--mcp-config` JSON (added to the servers of the user's own settings, the argv
/// never carries `--strict-mcp-config`, no config file of the user is touched) and lets a tool
/// run without a prompt through an `--allowedTools` rule of that same name. The one place of
/// the app that knows these formats.
impl ToolsAdapter for ClaudeAdapter {
    fn tool_table(&self) -> &'static ToolTable {
        table()
    }

    fn launch(&self, server: &WriterServer) -> Launch {
        let config = json!({
            "mcpServers": {
                mcp::SERVER_NAME: {
                    "type": "stdio",
                    "command": server.command,
                    "args": server.args,
                }
            }
        });
        Launch::Argv(vec!["--mcp-config".into(), config.to_string()])
    }

    fn read_rules(&self, tools: &[ToolSpec]) -> Vec<String> {
        tools
            .iter()
            .filter(|t| !t.writes)
            .map(|t| self.tool_name(t))
            .collect()
    }
}

/// The `mcp__writer__*` names of every command the registry marks as a read (the same rules that
/// let the main agent call them without a prompt, [`ToolsAdapter::read_rules`]). Made once.
fn writer_read_tools() -> &'static [&'static str] {
    static TOOLS: OnceLock<&'static [&'static str]> = OnceLock::new();
    TOOLS.get_or_init(|| leak_read_tools(&ClaudeAdapter))
}

impl RoleAdapter for ClaudeAdapter {
    /// The CLI reads all of them once, at start.
    fn restart_on_config_change(&self) -> bool {
        true
    }

    fn capability(&self, capability: &str) -> CapabilitySupport {
        match capability {
            "read" => CapabilitySupport::Tools(&tools().read),
            // The installed CLI has no Glob or Grep: searching is Writer's own MCP server
            // (`cli::mcp`, ADR 2026-11-19), every tool of the registry that reads.
            "writer-cli-read" => CapabilitySupport::Tools(writer_read_tools()),
            "edit" => CapabilitySupport::Tools(&tools().edit),
            "write" => CapabilitySupport::Tools(&tools().write),
            "bash-limited" => CapabilitySupport::Tools(&tools().shell),
            // not a tool: the spawn's `--settings` JSON (`claude_stream::memory_settings_json`)
            "memory-directory" => CapabilitySupport::Setting("autoMemoryDirectory"),
            _ => CapabilitySupport::Unsupported {
                fallback: "not granted: the role prompt and the permission rules apply",
            },
        }
    }

    fn render(&self, input: &RenderInput<'_>) -> Rendered {
        let mut agents = Map::new();
        let mut roles = Vec::new();
        for role in offered_roles(input.flags) {
            let mut def = Map::new();
            def.insert("description".into(), json!(role.purpose));
            def.insert(
                "prompt".into(),
                json!(role_prompt(self, role, input.writer_cli)),
            );
            def.insert(
                "tools".into(),
                json!(role_tools(self, role, input.writer_cli)),
            );
            if let Some(model) = role_model(role, input.tier_models) {
                def.insert("model".into(), json!(model));
            }
            agents.insert(backend_name(&role.id), Value::Object(def));
            roles.push(RenderedRole {
                id: role.id.clone(),
                name: backend_name(&role.id),
                delegation: delegation_sentence(role, input.writer_cli),
            });
        }
        if roles.is_empty() {
            return Rendered::none();
        }
        Rendered {
            config: Some(Value::Object(agents).to_string()),
            launch: launch_label(),
            roles,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table's prefix is what the CLI makes of the server's name; the config key and the rule
    /// names must not drift apart.
    #[test]
    fn the_tables_mcp_prefix_is_the_servers_name_in_the_clis_form() {
        assert_eq!(
            ClaudeAdapter.server_prefix(mcp::SERVER_NAME),
            format!("mcp__{}__", mcp::SERVER_NAME)
        );
        assert_eq!(
            ClaudeAdapter.deny_server("claude.ai Atlassian"),
            "mcp__claude_ai_Atlassian__*"
        );
    }

    /// The role capabilities, read off the table's roles, are the lists the adapter used to spell.
    #[test]
    fn the_launch_label_is_the_launch_tools_of_the_table() {
        assert_eq!(launch_label(), "Agent/Task calls");
    }

    #[test]
    fn capabilities_are_the_tools_of_their_roles() {
        let tools = |c: &str| match ClaudeAdapter.capability(c) {
            CapabilitySupport::Tools(t) => t.to_vec(),
            other => panic!("{c}: {other:?}"),
        };
        assert_eq!(tools("read"), ["Read"]);
        assert_eq!(tools("edit"), ["Edit", "MultiEdit"]);
        assert_eq!(tools("write"), ["Write"]);
        assert_eq!(tools("bash-limited"), ["Bash"]);
    }
}
