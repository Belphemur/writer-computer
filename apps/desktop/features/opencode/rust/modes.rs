//! What Writer's permission modes mean to OpenCode, built from the evidence of spec section 10.9
//! (decided in auto mode, review):
//!
//! - the session's rules are **empty** in every mode but Plan, so a role's own (agent-level) rules
//!   hold and nothing is loosened for a sub-agent; Writer never writes a session-level allow;
//! - **Plan** is an allow-list at session level: deny everything, then allow the read tools of the
//!   tool table. A sub-agent inherits it (and is given it again on creation, and on a mode change);
//! - accepting edits is Writer's own `once` reply to the chat's own requests, never a rule.

use super::opencode_api::ModelRef;
use super::transport::Policy;
use crate::agent::events::AgentPermissionMode;
use crate::agent::tool_table::{writer_mcp_kind, Kind, Role, ToolTable};
use crate::cli::mcp::{self, ToolSpec};
use serde_json::{json, Value};

/// The one primary agent of Writer's OpenCode configuration (phase 3 writes its file).
pub const AGENT: &str = "writer";

/// The session rules of Plan, like Claude's plan mode: nothing is written and nothing has a side
/// effect, but the agent can still look things up and ask. An allow-list behind `*: deny`, all of
/// it derived from the tables (a tool's name is its permission action):
///
/// - the table's `read` and `search` tools, and its `fetch` tools (web fetch and search);
/// - the table's question tool (`Role::Question`) and its launch tool (`Role::Launch`: a
///   sub-agent is held to Plan as well, it inherits these rules and is given them again);
/// - Writer's own MCP tools whose class in `writer-mcp.json` is `read` or `search` and that the
///   registry does not mark as writing (both must say read), spelled with the table's MCP prefix.
///
/// Everything else stays denied: edit, write, patch, shell, the codemode `execute` tool (its inner
/// calls were never captured against session rules, so it is not allowed), todos, skills, and any
/// Writer tool that writes or controls the app.
pub fn plan_rules(table: &ToolTable, mcp_tools: &[ToolSpec]) -> Vec<Value> {
    let mut names: Vec<String> = table
        .rows()
        .iter()
        .filter(|r| {
            matches!(r.kind, Kind::Read | Kind::Search | Kind::Fetch)
                || matches!(r.role, Some(Role::Question | Role::Launch))
        })
        .map(|r| r.name.clone())
        .collect();
    if let Some(mcp) = &table.mcp {
        names.extend(
            mcp_tools
                .iter()
                .filter(|t| !t.writes)
                .filter(|t| matches!(writer_mcp_kind(&t.name), Some(Kind::Read | Kind::Search)))
                .map(|t| format!("{}{}", mcp.prefix, t.name)),
        );
    }
    let mut rules = vec![json!({"action": "*", "resource": "*", "effect": "deny"})];
    rules.extend(
        names
            .into_iter()
            .map(|n| json!({"action": n, "resource": "*", "effect": "allow"})),
    );
    rules
}

pub struct ModePolicy {
    plan: Vec<Value>,
    default_model: Option<ModelRef>,
}

impl ModePolicy {
    pub fn new(table: &ToolTable, default_model: Option<ModelRef>) -> Self {
        Self {
            plan: plan_rules(table, &mcp::tools()),
            default_model,
        }
    }
}

impl Policy for ModePolicy {
    fn session_rules(&self, mode: AgentPermissionMode) -> Vec<Value> {
        match mode {
            AgentPermissionMode::Plan => self.plan.clone(),
            _ => Vec::new(),
        }
    }

    fn child_rules(&self, mode: AgentPermissionMode) -> Option<Vec<Value>> {
        (mode == AgentPermissionMode::Plan).then(|| self.plan.clone())
    }

    fn agent(&self, _: AgentPermissionMode) -> Option<String> {
        Some(AGENT.into())
    }

    fn default_model(&self) -> Option<ModelRef> {
        self.default_model.clone()
    }

    fn auto_allow(&self, mode: AgentPermissionMode, action: &str, _: &[String]) -> bool {
        mode == AgentPermissionMode::AcceptEdits && action == "edit"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> &'static ToolTable {
        super::super::events_tests::table()
    }

    fn allowed(rules: &[Value]) -> Vec<String> {
        assert_eq!(rules[0]["effect"], "deny");
        assert_eq!(rules[0]["action"], "*");
        rules[1..]
            .iter()
            .map(|r| {
                assert_eq!(r["effect"], "allow");
                assert_eq!(r["resource"], "*");
                r["action"].as_str().unwrap().to_string()
            })
            .collect()
    }

    #[test]
    fn plan_allows_what_looks_things_up_asks_and_launches_and_nothing_that_writes() {
        let t = table();
        let names = allowed(&plan_rules(t, &mcp::tools()));
        // the table's own rows, by kind and role
        for n in [
            "read",
            "glob",
            "grep",
            "webfetch",
            "websearch",
            "question",
            "subagent",
        ] {
            assert!(names.contains(&n.to_string()), "{n}: {names:?}");
        }
        // every allowed tool of the table is a read, search, fetch, question or launch row
        for n in names.iter().filter(|n| !n.starts_with("writer_")) {
            let row = t.row(n).unwrap();
            assert!(
                matches!(row.kind, Kind::Read | Kind::Search | Kind::Fetch)
                    || matches!(row.role, Some(Role::Question | Role::Launch)),
                "{n}"
            );
        }
        // and none that changes anything or runs code
        for n in [
            "edit",
            "write",
            "apply_patch",
            "shell",
            "execute",
            "todowrite",
            "skill",
        ] {
            assert!(!names.contains(&n.to_string()), "{n} is allowed");
        }
    }

    #[test]
    fn plan_allows_the_writer_tools_that_read_by_class_and_by_the_registry_and_no_other() {
        let tools = mcp::tools();
        let names = allowed(&plan_rules(table(), &tools));
        let mcp_names: Vec<&String> = names.iter().filter(|n| n.starts_with("writer_")).collect();
        assert!(!mcp_names.is_empty());
        for t in &tools {
            let is_read =
                !t.writes && matches!(writer_mcp_kind(&t.name), Some(Kind::Read | Kind::Search));
            assert_eq!(
                names.contains(&format!("writer_{}", t.name)),
                is_read,
                "{} (writes: {})",
                t.name,
                t.writes
            );
        }
        // the search and read tools the agent uses are among them; a writing tool never is
        for n in ["writer_search", "writer_read"] {
            assert!(names.contains(&n.to_string()), "{n}");
        }
        assert!(
            tools.iter().any(|t| t.writes),
            "the registry has write tools to hold back"
        );
    }

    #[test]
    fn only_plan_has_session_rules_and_children_get_them_only_there() {
        let p = ModePolicy::new(table(), None);
        for mode in [
            AgentPermissionMode::Manual,
            AgentPermissionMode::AcceptEdits,
            AgentPermissionMode::Plan,
            AgentPermissionMode::Auto,
            AgentPermissionMode::DontAsk,
        ] {
            let rules = p.session_rules(mode);
            let child = p.child_rules(mode);
            if mode == AgentPermissionMode::Plan {
                // the allows are the reads, behind the deny that comes first
                assert_eq!(rules[0]["effect"], "deny");
                assert_eq!(child.as_deref(), Some(rules.as_slice()));
            } else {
                assert!(rules.is_empty() && child.is_none(), "{mode:?}");
            }
        }
    }
}
