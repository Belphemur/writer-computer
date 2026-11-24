//! The adapter for OpenCode: how it names Writer's MCP tools, takes the server, which of its tools
//! each capability of a role grants and how the roles become agents of Writer's config file (ADR
//! "Define agent roles once and map them to each agent backend through adapters", ADR 2026-11-19,
//! spec `SPECs/opencode-backend-spec.md` sections 7 and 8). The counterpart of
//! `agent::claude_adapter::ClaudeAdapter`, with its names from the one table of this backend
//! (`tools.json`) and its permission rules from [`super::config`]. Tauri-free, pure.

use super::config::role_rules;
use super::opencode_api::ModelRef;
use crate::agent::mcp_wiring::{Launch, ToolsAdapter, WriterServer};
use crate::agent::roles::{
    backend_name, delegation_sentence, leak_read_tools, offered_roles, role_prompt, role_tools,
    CapabilitySupport, RenderInput, Rendered, RenderedRole, Role as RoleDef, RoleAdapter,
};
use crate::agent::tool_table::{is_writer_read_tool, Kind, Role, ToolTable};
use crate::cli::mcp::{self, ToolSpec};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The adapter for OpenCode.
#[derive(Debug)]
pub struct OpencodeAdapter;

/// OpenCode's tool table, `tools.json`.
pub fn table() -> &'static ToolTable {
    static TABLE: OnceLock<ToolTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        ToolTable::parse(include_str!("../tools.json")).expect("tools.json is a tool table")
    })
}

/// The tool names behind the capabilities of a role, read off the table (no name is spelled
/// here).
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
        let writes: Vec<&str> = t.names_of(Role::Create);
        CapabilityTools {
            // OpenCode has glob and grep of its own: finding files is a read
            read: [t.names_of(Role::Read), t.names_of_kind(Kind::Search)].concat(),
            // every edit that is not a whole-file write: `edit` and `apply_patch`
            edit: t
                .names_of_kind(Kind::Edit)
                .into_iter()
                .filter(|n| !writes.contains(n))
                .collect(),
            write: writes,
            shell: t.names_of(Role::Shell),
        }
    })
}

/// What the prompt calls a launch ("subagent calls"), built and leaked once.
fn launch_label() -> &'static str {
    static LABEL: OnceLock<&'static str> = OnceLock::new();
    LABEL.get_or_init(|| {
        let names = table().names_of(Role::Launch).join("/");
        Box::leak(format!("{names} calls").into_boxed_str())
    })
}

/// Writer's MCP server for OpenCode (ADR 2026-11-19): OpenCode names a server's tool
/// `<server>_<tool>` (the table's `mcp.prefix`), takes the server in its config file under
/// `mcp.servers` (a fragment the config builder merges), with codemode left on (U4), and lets a
/// tool run without a prompt through an allow rule of that name.
impl ToolsAdapter for OpencodeAdapter {
    fn tool_table(&self) -> &'static ToolTable {
        table()
    }

    fn tool_name(&self, tool: &ToolSpec) -> String {
        let prefix = &table()
            .mcp
            .as_ref()
            .expect("the table names the MCP prefix")
            .prefix;
        format!("{prefix}{}", tool.name)
    }

    fn launch(&self, server: &WriterServer) -> Launch {
        let command: Vec<&String> = std::iter::once(&server.command)
            .chain(&server.args)
            .collect();
        Launch::Config(
            json!({
                "mcp": {"servers": {mcp::SERVER_NAME: {"type": "local", "command": command}}}
            })
            .to_string(),
        )
    }

    fn read_rules(&self, tools: &[ToolSpec]) -> Vec<String> {
        tools
            .iter()
            .filter(|t| is_writer_read_tool(t))
            .map(|t| self.tool_name(t))
            .collect()
    }
}

/// Every read tool of Writer's server, by OpenCode's names. Made once.
fn writer_read_tools() -> &'static [&'static str] {
    static TOOLS: OnceLock<&'static [&'static str]> = OnceLock::new();
    TOOLS.get_or_init(|| leak_read_tools(&OpencodeAdapter))
}

/// The `model` of a role's agent (`provider/model`), from its tier setting; `None` inherits the
/// chat's. A tier that names no usable model (blank, `default`, `auto`, not `provider/model`)
/// inherits too: Writer has no model of its own to fall back to for OpenCode.
fn role_model(role: &RoleDef, tier_models: &BTreeMap<String, Option<String>>) -> Option<String> {
    let chosen = tier_models.get(&role.tier)?.as_deref()?.trim();
    if chosen.is_empty()
        || chosen.eq_ignore_ascii_case("default")
        || chosen.eq_ignore_ascii_case("auto")
    {
        return None;
    }
    ModelRef::parse(chosen).map(|m| m.slug())
}

impl RoleAdapter for OpencodeAdapter {
    /// OpenCode reads skills, instruction files and its config again on a location reload; the
    /// chat's session stays, so keeping the chat in step is cheap.
    fn restart_on_config_change(&self) -> bool {
        true
    }

    fn capability(&self, capability: &str) -> CapabilitySupport {
        match capability {
            "read" => CapabilitySupport::Tools(&tools().read),
            "writer-cli-read" => CapabilitySupport::Tools(writer_read_tools()),
            "edit" => CapabilitySupport::Tools(&tools().edit),
            "write" => CapabilitySupport::Tools(&tools().write),
            "bash-limited" => CapabilitySupport::Tools(&tools().shell),
            // not a tool: Writer keeps the memory and answers the chat's own writes to its
            // folder itself (`modes.rs`); a role never writes it (sub-agents get no memory)
            "memory-directory" => CapabilitySupport::Unsupported {
                fallback: "Writer keeps the memory: only the chat's own agent writes it",
            },
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
            def.insert("mode".into(), json!("subagent"));
            def.insert("description".into(), json!(role.purpose));
            // OpenCode's field is `system`, not `prompt` (spec 4.5)
            def.insert(
                "system".into(),
                json!(role_prompt(self, role, input.writer_cli)),
            );
            if let Some(model) = role_model(role, input.tier_models) {
                def.insert("model".into(), json!(model));
            }
            // the roles hold their own rules, the session's are empty outside of Plan (10.9):
            // what their capabilities grant, and nothing else is ever asked
            def.insert(
                "permissions".into(),
                Value::Array(role_rules(
                    table(),
                    &role_tools(self, role, input.writer_cli),
                )),
            );
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
    use crate::agent::mcp_wiring::wiring;
    use crate::agent::roles::{registry, Flags};
    use std::path::Path;

    fn tier_models() -> BTreeMap<String, Option<String>> {
        [
            ("cheap", "fake/cheap"),
            ("standard", "fake/standard"),
            ("strong", "default"),
        ]
        .map(|(t, m)| (t.to_string(), Some(m.to_string())))
        .into()
    }

    fn render(writer_cli: bool, tiers: &BTreeMap<String, Option<String>>) -> Rendered {
        OpencodeAdapter.render(&RenderInput {
            writer_cli,
            tier_models: tiers,
            flags: &Flags::current(),
        })
    }

    #[test]
    fn the_names_are_the_tables_and_the_servers_prefix() {
        assert_eq!(table().mcp.as_ref().unwrap().prefix, "writer_");
        let tool = mcp::tools()
            .into_iter()
            .find(|t| t.name == "search")
            .unwrap();
        assert_eq!(OpencodeAdapter.tool_name(&tool), "writer_search");
        assert_eq!(launch_label(), "subagent calls");
    }

    #[test]
    fn every_capability_of_the_registry_answers() {
        for cap in registry().capabilities.keys() {
            // a match arm or the fallback: never a panic, never an empty tool list
            if let CapabilitySupport::Tools(t) = OpencodeAdapter.capability(cap) {
                assert!(!t.is_empty(), "{cap}");
            }
        }
        let names = |c: &str| match OpencodeAdapter.capability(c) {
            CapabilitySupport::Tools(t) => t.to_vec(),
            other => panic!("{c}: {other:?}"),
        };
        assert_eq!(names("read"), ["read", "glob", "grep"]);
        assert_eq!(names("edit"), ["edit", "apply_patch"]);
        assert_eq!(names("write"), ["write"]);
        assert_eq!(names("bash-limited"), ["shell"]);
        // writer-cli-read is exactly the read tools of the registry, in OpenCode's spelling
        let reads = names("writer-cli-read");
        assert!(reads.contains(&"writer_search"));
        assert!(!reads.iter().any(|n| mcp::tools()
            .iter()
            .any(|t| t.writes && *n == format!("writer_{}", t.name))));
    }

    #[test]
    fn the_server_is_a_config_fragment_with_the_launcher_command() {
        let w = wiring(&OpencodeAdapter, Path::new("/b/writer"), Path::new("/v")).unwrap();
        let Launch::Config(f) = &w.launch else {
            panic!("a config fragment");
        };
        let v: Value = serde_json::from_str(f).unwrap();
        assert_eq!(
            v["mcp"]["servers"]["writer"]["command"],
            json!(["/b/writer", "vault=/v", "mcp"])
        );
        assert!(w.allowed.contains(&"writer_search".to_string()));
        assert!(!w.allowed.iter().any(|n| n == "writer_create"));
    }

    #[test]
    fn roles_become_subagents_with_their_own_rules_and_the_tiers_models() {
        let r = render(true, &tier_models());
        let agents: Value = serde_json::from_str(r.config.as_ref().unwrap()).unwrap();
        assert_eq!(
            r.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["writer-explorer", "writer-worker"]
        );
        for name in ["writer-explorer", "writer-worker"] {
            assert_eq!(agents[name]["mode"], "subagent");
            assert!(agents[name]["system"].as_str().unwrap().len() > 20);
            assert!(
                agents[name].get("prompt").is_none(),
                "the field is `system`"
            );
        }
        assert_eq!(agents["writer-explorer"]["model"], "fake/cheap");
        assert_eq!(agents["writer-worker"]["model"], "fake/standard");
        // the explorer's rules never list a write; the worker's edits ask (config.rs pins the rest)
        let listed = |n: &str, effect: &str| -> Vec<String> {
            agents[n]["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["effect"] == effect)
                .map(|r| r["action"].as_str().unwrap().to_string())
                .collect()
        };
        assert!(listed("writer-explorer", "ask").is_empty());
        assert_eq!(
            listed("writer-worker", "ask"),
            ["edit", "apply_patch", "write"]
        );
    }

    #[test]
    fn a_tier_with_no_usable_model_inherits_the_chats() {
        let mut tiers = tier_models();
        tiers.insert("cheap".into(), Some("auto".into()));
        tiers.insert("standard".into(), Some("not-a-slug".into()));
        let r = render(false, &tiers);
        let agents: Value = serde_json::from_str(r.config.as_ref().unwrap()).unwrap();
        assert!(agents["writer-explorer"].get("model").is_none());
        assert!(agents["writer-worker"].get("model").is_none());
        let r = render(false, &BTreeMap::new());
        assert!(r.config.unwrap().contains("writer-explorer"));
    }

    #[test]
    fn the_role_text_names_no_claude_tool() {
        let r = render(true, &tier_models());
        let text = r.config.unwrap();
        for claude in ["MultiEdit", "NotebookEdit", "mcp__writer__"] {
            assert!(!text.contains(claude), "{claude}");
        }
        // the search line names OpenCode's spelling of Writer's tools
        assert!(text.contains("writer_search"));
    }

    #[test]
    fn restart_on_config_change_is_a_location_reload() {
        assert!(OpencodeAdapter.restart_on_config_change());
    }
}
