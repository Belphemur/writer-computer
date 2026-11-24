//! A backend's tool table: tool name -> neutral kind, role, argument names and label words
//! (spec `SPECs/opencode-backend-spec.md`, A11). Shared data, one file per backend
//! (`shared/agent-tools/claude.json`), read here (`include_str!` by the backend that owns it) and
//! by `features/agent/web/lib/tool-kinds.ts`. Tauri-free and pure.
//!
//! Only what Rust reads is parsed here (kinds, roles, argument names, the MCP prefix); the label
//! words and the MCP classes of the same file are the web's (`tool-kinds.ts`).
//!
//! Shared code asks this table what a tool is (`is_shell`, `is_edit`, `launch_args`, the edit's
//! argument names) and never spells a backend's tool name: a boundary test
//! (`boundary_tests.rs`) fails on a Claude tool name anywhere in `agent/` outside the table, the
//! Claude mapper and the Claude adapter.

use serde::Deserialize;

/// The web's kinds, the one vocabulary of every backend (`tool-kinds.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Execute,
    Edit,
    Read,
    Search,
    Fetch,
    Agent,
    Other,
}

/// What shared code needs of a tool beyond its kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// Reads one file's content (the `read` capability of a role).
    Read,
    /// The shell tool: its call's window blames file changes on it, prefix rules apply to it.
    Shell,
    /// An edit whose input is one `old` -> `new` replacement.
    Replace,
    /// An edit whose input is a list of replacements (`edits`).
    MultiReplace,
    /// An edit whose input is the whole new content.
    Create,
    /// Starts a sub-agent.
    Launch,
    /// A sub-agent delivers its report.
    Handback,
}

/// Input keys a tool's arguments go by.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Args {
    /// Tried in order for the one-line argument (the web's label; Rust reads it for a shell's
    /// command).
    #[serde(default)]
    pub primary: Vec<String>,
    /// For an edit: the input keys its file path is read from, tried in order.
    #[serde(default)]
    pub paths: Vec<String>,
    pub old: Option<String>,
    pub new: Option<String>,
    pub all: Option<String>,
    pub edits: Option<String>,
    pub content: Option<String>,
    /// A launch's sub-agent type.
    pub agent_type: Option<String>,
    /// A launch's "run in the background" flag.
    pub background: Option<String>,
}

/// One tool, as far as Rust reads it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(default)]
    pub name: String,
    pub kind: Kind,
    pub role: Option<Role>,
    #[serde(default)]
    pub args: Option<Args>,
}

#[derive(Debug, Deserialize)]
struct Raw {
    tools: Vec<Row>,
    #[serde(default)]
    mcp: Option<Mcp>,
}

/// Writer's own MCP tools are named `prefix` + the command name.
#[derive(Debug, Clone, Deserialize)]
pub struct Mcp {
    pub prefix: String,
}

#[derive(Debug)]
pub struct ToolTable {
    rows: Vec<Row>,
    pub mcp: Option<Mcp>,
}

impl ToolTable {
    /// Parses one table. A malformed table is a bug of the shipped file, so callers of the
    /// embedded ones `expect`; a test parses every table.
    pub fn parse(json: &str) -> Result<ToolTable, String> {
        let raw: Raw = serde_json::from_str(json).map_err(|e| format!("tool table: {e}"))?;
        let mut seen = std::collections::HashSet::new();
        for r in &raw.tools {
            if r.name.is_empty() || !seen.insert(r.name.as_str()) {
                return Err(format!("tool table: bad or repeated name {:?}", r.name));
            }
        }
        // every launch tool names its arguments alike: `launch_args` is the first one's
        let mut launches = raw.tools.iter().filter(|r| r.role == Some(Role::Launch));
        if let Some(first) = launches.next() {
            let keys = |r: &Row| {
                r.args
                    .as_ref()
                    .map(|a| (a.agent_type.clone(), a.background.clone()))
            };
            if launches.any(|r| keys(r) != keys(first)) {
                return Err("tool table: launch tools differ in their argument keys".into());
            }
        }
        Ok(ToolTable {
            rows: raw.tools,
            mcp: raw.mcp,
        })
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn row(&self, tool: &str) -> Option<&Row> {
        self.rows.iter().find(|r| r.name == tool)
    }

    /// The kind of `tool`; `Other` for a tool the table does not list.
    pub fn kind(&self, tool: &str) -> Kind {
        self.row(tool).map_or(Kind::Other, |r| r.kind)
    }

    /// The role of `tool`, `None` for a tool with none (or one the table does not list).
    pub fn role(&self, tool: &str) -> Option<Role> {
        self.row(tool).and_then(|r| r.role)
    }

    /// The shell tool: its call's window is when watcher changes are blamed on it.
    pub fn is_shell(&self, tool: &str) -> bool {
        self.role(tool) == Some(Role::Shell)
    }

    /// A tool that edits a file (its end is when the session's counts change).
    pub fn is_edit(&self, tool: &str) -> bool {
        self.kind(tool) == Kind::Edit
    }

    /// A tool that starts a sub-agent.
    pub fn is_launch(&self, tool: &str) -> bool {
        self.role(tool) == Some(Role::Launch)
    }

    /// A sub-agent's delivery of its report.
    pub fn is_handback(&self, tool: &str) -> bool {
        self.role(tool) == Some(Role::Handback)
    }

    /// The argument names of `tool`.
    pub fn args(&self, tool: &str) -> Option<&Args> {
        self.row(tool).and_then(|r| r.args.as_ref())
    }

    /// The input keys of an edit's file path, tried in order.
    pub fn path_keys(&self, tool: &str) -> &[String] {
        self.args(tool).map_or(&[], |a| a.paths.as_slice())
    }

    /// The input keys tried, in order, for the tool's one argument that says what it works on
    /// (its one-line label): the command of a shell, the path of a read.
    pub fn primary_keys(&self, tool: &str) -> &[String] {
        self.args(tool).map_or(&[], |a| a.primary.as_slice())
    }

    /// The argument names every launch tool shares (the first launch row's).
    pub fn launch_args(&self) -> Option<&Args> {
        self.rows
            .iter()
            .find(|r| r.role == Some(Role::Launch))
            .and_then(|r| r.args.as_ref())
    }

    /// The names of the tools with `role`, in table order.
    pub fn names_of(&self, role: Role) -> Vec<&str> {
        self.rows
            .iter()
            .filter(|r| r.role == Some(role))
            .map(|r| r.name.as_str())
            .collect()
    }

    /// The first tool with `role` (the one a prompt names), `None` when the backend has none.
    pub fn name_of(&self, role: Role) -> Option<&str> {
        self.rows
            .iter()
            .find(|r| r.role == Some(role))
            .map(|r| r.name.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::backend;

    const MINI: &str = r#"{
        "tools":[{"name":"sh","kind":"execute","role":"shell"},
                 {"name":"ed","kind":"edit","role":"replace","args":{"primary":["path"],"old":"o"}}]}"#;

    #[test]
    fn roles_and_kinds_are_read_from_the_rows() {
        let t = ToolTable::parse(MINI).unwrap();
        assert!(t.is_shell("sh") && !t.is_shell("ed") && !t.is_shell("nope"));
        assert!(t.is_edit("ed") && !t.is_edit("sh"));
        assert_eq!(t.kind("nope"), Kind::Other);
        assert_eq!(t.primary_keys("ed"), ["path"]);
        assert!(t.primary_keys("sh").is_empty());
        assert_eq!(t.name_of(Role::Shell), Some("sh"));
        assert_eq!(t.name_of(Role::Launch), None);
        assert!(t.launch_args().is_none());
    }

    #[test]
    fn a_repeated_or_missing_name_is_refused() {
        let dup = r#"{"tools":[
            {"name":"a","kind":"read"},{"name":"a","kind":"read"}]}"#;
        assert!(ToolTable::parse(dup).is_err());
        let anon = r#"{"tools":[{"kind":"read"}]}"#;
        assert!(ToolTable::parse(anon).is_err());
    }

    #[test]
    fn launch_tools_must_name_their_arguments_alike() {
        let alike = r#"{"tools":[
            {"name":"a","kind":"agent","role":"launch","args":{"agentType":"t"}},
            {"name":"b","kind":"agent","role":"launch","args":{"agentType":"t"}}]}"#;
        assert!(ToolTable::parse(alike).is_ok());
        let apart = r#"{"tools":[
            {"name":"a","kind":"agent","role":"launch","args":{"agentType":"t"}},
            {"name":"b","kind":"agent","role":"launch","args":{"agentType":"u"}}]}"#;
        assert!(ToolTable::parse(apart).is_err());
    }

    /// Claude's table is the old hand-kept lists, in their order (they were `EDIT_TOOLS` and
    /// `SHELL_TOOL` of `changes.rs`, `LAUNCH_TOOLS`, `SUBAGENT_TYPE_KEY` of `subagents.rs`,
    /// `HANDBACK_TOOL` of `sub_tracker.rs`, the `Bash` of `bash_rules.rs`).
    #[test]
    fn claudes_table_reproduces_the_old_lists() {
        let t = backend::claude().tools();
        let edits: Vec<&str> = t
            .rows()
            .iter()
            .filter(|r| r.kind == Kind::Edit)
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(edits, ["Edit", "MultiEdit", "Write", "NotebookEdit"]);
        assert_eq!(t.names_of(Role::Read), ["Read"]);
        assert_eq!(t.names_of(Role::Replace), ["Edit"]);
        assert_eq!(t.names_of(Role::MultiReplace), ["MultiEdit"]);
        assert_eq!(t.names_of(Role::Create), ["Write"]);
        assert_eq!(t.mcp.as_ref().unwrap().prefix, "mcp__writer__");
        assert_eq!(t.names_of(Role::Shell), ["Bash"]);
        assert_eq!(t.names_of(Role::Launch), ["Agent", "Task"]);
        assert_eq!(t.names_of(Role::Handback), ["SubagentHandback"]);
        let launch = t.launch_args().unwrap();
        assert_eq!(launch.agent_type.as_deref(), Some("subagent_type"));
        assert_eq!(launch.background.as_deref(), Some("run_in_background"));
        assert_eq!(t.primary_keys("Edit"), ["file_path", "path"]);
        assert_eq!(t.primary_keys("NotebookEdit"), ["notebook_path"]);
        // every edit tool captures the same keys (the old `PATH_KEYS` of `changes.rs`)
        for edit in edits {
            assert_eq!(
                t.path_keys(edit),
                ["file_path", "notebook_path", "path"],
                "{edit}"
            );
        }
        let edit = t.args("Edit").unwrap();
        assert_eq!(
            (
                edit.old.as_deref(),
                edit.new.as_deref(),
                edit.all.as_deref()
            ),
            (Some("old_string"), Some("new_string"), Some("replace_all"))
        );
        assert_eq!(t.args("MultiEdit").unwrap().edits.as_deref(), Some("edits"));
        assert_eq!(t.args("Write").unwrap().content.as_deref(), Some("content"));
    }

    /// Every row of the shipped table, as the vectors the web side pins too
    /// (`features/agent/tests/agent-tool-table.test.ts` reads the same file).
    #[test]
    fn every_row_of_claudes_table_has_its_kind() {
        let json: serde_json::Value =
            serde_json::from_str(include_str!("../../../shared/agent-tools/claude.json")).unwrap();
        let t = backend::claude().tools();
        let rows = json["tools"].as_array().unwrap();
        assert_eq!(rows.len(), t.rows().len());
        for r in rows {
            let name = r["name"].as_str().unwrap();
            let kind = r["kind"].as_str().unwrap();
            let got = format!("{:?}", t.kind(name)).to_lowercase();
            assert_eq!(got, kind, "{name}");
        }
    }
}
