//! Writer's OpenCode config file (spec `SPECs/opencode-backend-spec.md` section 8): one document
//! for the window's vault, built from what the adapter and the tool table already say, never by
//! hand and never in the vault (`<app data>/opencode/<vault id>.json`, passed as
//! `OPENCODE_CONFIG`; `server.rs` writes it).
//!
//! What it holds:
//!
//! - `permissions`: the base rule `*: ask`, the shape captured with 2.4.0, and `default_agent`;
//! - `agents`: the one primary agent `writer` (the session's agent, spec 10.9; only allows: the
//!   base ask comes from the top level), the roles as sub-agents (the adapter renders them, each
//!   with its own rules), the built-in agents switched off so a model cannot launch one of them
//!   past Writer's rules, and OpenCode's own title agent switched off (the one title trigger is
//!   `title.rs`, A5). Within one list no action is named twice: a rule never depends on which of
//!   two matches wins;
//! - `mcp.servers.writer`, with codemode left on (U4): the adapter's fragment;
//! - `instructions` and `skills` as absolute paths: with the project's own config off the vault's
//!   `AGENTS.md`, `CLAUDE.md` and skill folders load only when listed (spec 4.12).
//!
//! The permission modes are not in this file: only Plan has rules of the session (`modes.rs`), and
//! Writer's own `once` replies are not rules at all. Pure except [`discover`].

use crate::agent::mcp_wiring::{Launch, McpWiring};
use crate::agent::permission_update::rule_json;
use crate::agent::project::{AGENTS_FILE, CLAUDE_FILE};
use crate::agent::skills::SKILL_DIRS;
use crate::agent::tool_table::{Kind, Role, ToolTable};
use crate::fs_entry::{self, LinkTarget};
use crate::vault_ops;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The one primary agent of Writer's configuration; the session runs as it.
pub const AGENT: &str = "writer";

/// OpenCode's built-in agents. Every one of them is switched off: they come with rules of their
/// own (the default allows everything) and one of them is a sub-agent a model can launch by name,
/// which would run past the rules below. `summary` and `compaction` stay: they run without tools.
const BUILT_IN_AGENTS: [&str; 4] = ["build", "plan", "general", "explore"];
/// OpenCode's own title agent: switched off (spec A5).
const TITLE_AGENT: &str = "title";

/// The vault files that carry instructions for the agent, relative to the vault root.
const INSTRUCTION_FILES: [&str; 2] = [AGENTS_FILE, CLAUDE_FILE];

/// One rule of a ruleset on every resource: the one rule shape of the module.
pub fn rule(action: &str, effect: &str) -> Value {
    rule_json(action, "*", effect)
}

/// What the primary agent allows without asking: the tools that read, look things up, ask or
/// launch (the table's `read` and `search` kinds, its question, launch, skill and todo roles) and
/// Writer's own read tools (`mcp_reads`: the adapter's names).
pub fn read_allows(table: &ToolTable, mcp_reads: &[String]) -> Vec<String> {
    let mut names: Vec<String> = table
        .rows()
        .iter()
        .filter(|r| {
            matches!(r.kind, Kind::Read | Kind::Search)
                || matches!(
                    r.role,
                    Some(Role::Question | Role::Launch | Role::Skill | Role::Todo)
                )
        })
        .map(|r| r.name.clone())
        .collect();
    names.extend(mcp_reads.iter().cloned());
    names
}

/// The ruleset of the primary agent: allows only. The base `*: ask` is the top level's.
pub fn writer_rules(table: &ToolTable, mcp_reads: &[String]) -> Vec<Value> {
    read_allows(table, mcp_reads)
        .iter()
        .map(|n| rule(n, "allow"))
        .collect()
}

/// The ruleset of a role, from the tools its capabilities grant (`granted`, the adapter's
/// `role_tools`): nothing is allowed that is not listed and nothing unlisted ever asks, so the base
/// is `*: deny`. A granted tool that changes something (an edit, the shell) asks, like the main
/// agent's (a role never writes behind the user's back in manual mode); the rest is allowed, and
/// so is the question tool. The tools that launch, load a skill, keep a todo list or run code are
/// named as denies, first among the things a model might try.
pub fn role_rules(table: &ToolTable, granted: &[&str]) -> Vec<Value> {
    let mut rules = vec![rule("*", "deny")];
    for n in granted {
        let effect = match table.kind(n) {
            Kind::Edit | Kind::Execute => "ask",
            _ => "allow",
        };
        rules.push(rule(n, effect));
    }
    rules.extend(
        table
            .names_of(Role::Question)
            .into_iter()
            .map(|n| rule(n, "allow")),
    );
    for role in [Role::Launch, Role::Skill, Role::Todo, Role::Codemode] {
        rules.extend(table.names_of(role).into_iter().map(|n| rule(n, "deny")));
    }
    rules
}

/// The instruction files and skill folders of a vault that exist and stay inside it (a link that
/// leaves the vault is skipped), as absolute paths: what OpenCode's project config would have
/// loaded. OpenCode takes a skill folder whole, not entry by entry, so a folder with any entry
/// (or entry of a skill's own folder) that links out of the vault is left out entirely.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Discovered {
    pub instructions: Vec<String>,
    pub skills: Vec<String>,
}

/// How many entries of one skill folder are looked at before it is taken as unsafe.
const SKILL_ENTRIES_MAX: usize = 2000;

/// Whether no entry of the skill folder `dir` (nor of a folder below it, one level further, links
/// to folders inside the vault followed) links out of the vault. Only that drops the folder:
/// dotfiles (`.DS_Store`, a cloned skill's `.git`), special files, dangling links and links
/// that stay inside are of no concern here. A folder that cannot be read or has too many
/// entries is not clean either.
fn skill_folder_is_clean(dir: &Path, root_real: &Path) -> bool {
    fn walk(
        dir: &Path,
        root_real: &Path,
        depth: u32,
        seen: &mut usize,
        visited: &mut std::collections::HashSet<std::path::PathBuf>,
    ) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            *seen += 1;
            if *seen > SKILL_ENTRIES_MAX {
                return false;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            let real = if ft.is_symlink() {
                match fs_entry::link_target(&path, dir, Some(root_real)) {
                    LinkTarget::Inside { real, .. } => real,
                    LinkTarget::Outside | LinkTarget::NoRoot => return false,
                    // dangling: nothing to load; a loop back to a folder above is walked already
                    LinkTarget::Dangling | LinkTarget::Cycle => continue,
                }
            } else {
                path
            };
            if real.is_dir()
                && depth > 0
                && visited.insert(real.clone())
                && !walk(&real, root_real, depth - 1, seen, visited)
            {
                return false;
            }
        }
        true
    }
    let Ok(real) = dir.canonicalize() else {
        return false;
    };
    let mut visited = std::collections::HashSet::from([real.clone()]);
    walk(&real, root_real, 1, &mut 0, &mut visited)
}

/// Looks at the vault root (canonical). The only code of this module that touches the disk.
pub fn discover(root: &Path) -> Discovered {
    let found = |rel: &str, dir: bool| -> Option<String> {
        let c = vault_ops::confine(root, rel).ok()?;
        let ok = if dir { c.abs.is_dir() } else { c.abs.is_file() };
        ok.then(|| c.abs.to_str().map(String::from)).flatten()
    };
    Discovered {
        instructions: INSTRUCTION_FILES
            .iter()
            .filter_map(|f| found(f, false))
            .collect(),
        skills: SKILL_DIRS
            .iter()
            .filter_map(|d| found(d, true))
            .filter(|abs| {
                let clean = skill_folder_is_clean(Path::new(abs), root);
                if !clean {
                    log::warn!(
                        "opencode: a skill folder of the vault has an entry that leaves the vault, so it is not loaded"
                    );
                }
                clean
            })
            .collect(),
    }
}

/// What the document is built from.
pub struct ConfigInput<'a> {
    pub table: &'a ToolTable,
    /// The roles, as the adapter rendered them: a JSON object of agent name to definition
    /// (`LaunchConfig::agents`); `None` when orchestration is off.
    pub roles: Option<&'a str>,
    /// Writer's MCP server (the adapter's fragment and its read tools); `None` without launcher.
    pub mcp: Option<&'a McpWiring>,
    pub found: &'a Discovered,
}

/// Merges `from` into `into`: objects key by key, anything else replaced.
fn merge(into: &mut Value, from: Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        a.insert(k, v);
                    }
                }
            }
        }
        (slot, v) => *slot = v,
    }
}

/// The config document. Deterministic: the same input is the same text, so a rewrite that changes
/// nothing reloads nothing.
pub fn build(input: &ConfigInput<'_>) -> Value {
    let mcp_reads: &[String] = input.mcp.map_or(&[], |m| m.allowed.as_slice());
    let mut agents = Map::new();
    for name in BUILT_IN_AGENTS.iter().chain([&TITLE_AGENT]) {
        agents.insert((*name).to_string(), json!({"disabled": true}));
    }
    agents.insert(
        AGENT.to_string(),
        json!({
            "mode": "primary",
            "description": "Writer's agent for the notes of a vault",
            "permissions": writer_rules(input.table, mcp_reads),
        }),
    );
    if let Some(Value::Object(roles)) = input.roles.and_then(|r| serde_json::from_str(r).ok()) {
        agents.extend(roles);
    }
    let mut doc = json!({
        "permissions": [rule("*", "ask")],
        "default_agent": AGENT,
        "agents": Value::Object(agents),
    });
    if let Some(Launch::Config(fragment)) = input.mcp.map(|m| &m.launch) {
        if let Ok(v) = serde_json::from_str::<Value>(fragment) {
            merge(&mut doc, v);
        }
    }
    if !input.found.instructions.is_empty() {
        doc["instructions"] = json!(input.found.instructions);
    }
    if !input.found.skills.is_empty() {
        doc["skills"] = json!(input.found.skills);
    }
    doc
}

/// [`build`] as the text of the file.
pub fn render(input: &ConfigInput<'_>) -> String {
    serde_json::to_string_pretty(&build(input)).expect("a JSON value is text") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::mcp_wiring::wiring;
    use crate::agent::roles::{role_tools, Flags, RenderInput, RoleAdapter};
    use crate::agent::tool_table::is_writer_read_tool;
    use crate::cli::mcp;
    use crate::features::opencode::adapter::{table, OpencodeAdapter};
    use std::collections::BTreeMap;

    fn tier_models() -> BTreeMap<String, Option<String>> {
        [
            ("cheap", "fake/cheap-model"),
            ("standard", "fake/standard-model"),
        ]
        .map(|(t, m)| (t.to_string(), Some(m.to_string())))
        .into()
    }

    /// The document of a fixed fake vault, as the golden pins it.
    pub(crate) fn fixture_doc() -> Value {
        let roles = OpencodeAdapter
            .render(&RenderInput {
                writer_cli: true,
                tier_models: &tier_models(),
                flags: &Flags::current(),
            })
            .config;
        let mcp = wiring(
            &OpencodeAdapter,
            Path::new("/app/bin/writer"),
            Path::new("/vault"),
        );
        build(&ConfigInput {
            table: table(),
            roles: roles.as_deref(),
            mcp: mcp.as_ref(),
            found: &Discovered {
                instructions: vec!["/vault/AGENTS.md".into(), "/vault/CLAUDE.md".into()],
                skills: vec![
                    "/vault/.claude/skills".into(),
                    "/vault/.agents/skills".into(),
                ],
            },
        })
    }

    fn with_effect(rules: &Value, effect: &str) -> Vec<String> {
        rules
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["effect"] == effect)
            .map(|r| r["action"].as_str().unwrap().to_string())
            .collect()
    }

    fn defined(doc: &Value) -> Vec<(&String, &Value)> {
        doc["agents"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, d)| d["disabled"] != true)
            .collect()
    }

    #[test]
    fn the_document_is_pinned() {
        let actual = serde_json::to_string_pretty(&fixture_doc()).unwrap() + "\n";
        crate::agent::golden_tests::check_file(
            &crate::features::opencode::events_tests::feature_dir().join("goldens/config"),
            "file.json",
            &actual,
        );
    }

    /// The captured shape: the base ask is the top level's, the primary agent adds allows, and the
    /// lists of the agents never name an action twice (so no rule needs the last match to win).
    #[test]
    fn the_base_ask_is_the_top_levels_and_no_action_is_named_twice_in_a_list() {
        let doc = fixture_doc();
        assert_eq!(doc["permissions"], json!([rule("*", "ask")]));
        assert_eq!(doc["default_agent"], AGENT);
        let writer = &doc["agents"][AGENT]["permissions"];
        assert!(writer
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["action"] != "*" && r["effect"] == "allow"));
        for (name, def) in defined(&doc) {
            let mut seen = std::collections::HashSet::new();
            for r in def["permissions"].as_array().unwrap() {
                assert!(
                    seen.insert(r["action"].as_str().unwrap()),
                    "{name} names {} twice",
                    r["action"]
                );
            }
        }
    }

    #[test]
    fn a_role_denies_everything_it_does_not_list_and_lists_what_its_capabilities_grant() {
        let doc = fixture_doc();
        let t = table();
        for (id, writer_cli) in [("explorer", true), ("worker", true)] {
            let role = crate::agent::roles::registry()
                .roles
                .iter()
                .find(|r| r.id == id)
                .unwrap();
            let rules = &doc["agents"][format!("writer-{id}")]["permissions"];
            // the base comes first and denies
            assert_eq!(rules[0], rule("*", "deny"), "{id}");
            let granted = role_tools(&OpencodeAdapter, role, writer_cli);
            let mut listed: Vec<String> = with_effect(rules, "allow");
            listed.extend(with_effect(rules, "ask"));
            let mut want: Vec<String> = granted.iter().map(|n| n.to_string()).collect();
            want.extend(t.names_of(Role::Question).iter().map(|n| n.to_string()));
            listed.sort();
            want.sort();
            assert_eq!(
                listed, want,
                "{id}: what it may use is what its roles grant"
            );
            // none of the rows a role must never reach is allowed or asked for
            let mut never: Vec<&str> = Vec::new();
            for r in [Role::Launch, Role::Skill, Role::Todo, Role::Codemode] {
                never.extend(t.names_of(r));
            }
            let mut denied = with_effect(rules, "deny");
            denied.retain(|a| a != "*");
            let mut never_s: Vec<String> = never.iter().map(|n| n.to_string()).collect();
            denied.sort();
            never_s.sort();
            assert_eq!(denied, never_s, "{id}");
            for n in never {
                assert!(!listed.contains(&n.to_string()), "{id} lists {n}");
            }
        }
    }

    #[test]
    fn a_role_without_the_writer_commands_gets_no_writer_allow() {
        let roles = OpencodeAdapter
            .render(&RenderInput {
                writer_cli: false,
                tier_models: &tier_models(),
                flags: &Flags::current(),
            })
            .config
            .unwrap();
        assert!(!roles.contains("writer_search"), "no writer_* rule");
    }

    /// Nothing is allowed that writes: the table's edit and execute rows, the registry's writing
    /// tools and the wildcard never appear among the allows of any agent; a granted edit asks.
    #[test]
    fn nothing_but_reads_is_allowed_by_any_agent() {
        let doc = fixture_doc();
        let t = table();
        let mut forbidden: Vec<String> = t
            .rows()
            .iter()
            .filter(|r| matches!(r.kind, Kind::Edit | Kind::Execute))
            .map(|r| r.name.clone())
            .collect();
        forbidden.extend(t.names_of(Role::Codemode).iter().map(|n| n.to_string()));
        forbidden.extend(
            mcp::tools()
                .iter()
                .filter(|m| !is_writer_read_tool(m))
                .map(|m| format!("writer_{}", m.name)),
        );
        forbidden.push("*".into());
        for (name, def) in defined(&doc) {
            for a in with_effect(&def["permissions"], "allow") {
                assert!(!forbidden.contains(&a), "{name} allows {a}");
            }
        }
        let worker = &doc["agents"]["writer-worker"]["permissions"];
        assert_eq!(with_effect(worker, "ask"), ["edit", "apply_patch", "write"]);
        assert!(!with_effect(worker, "ask").contains(&"shell".to_string()));
    }

    #[test]
    fn the_title_agent_and_the_built_in_agents_are_off() {
        let doc = fixture_doc();
        for n in ["title", "build", "plan", "general", "explore"] {
            assert_eq!(doc["agents"][n], json!({"disabled": true}), "{n}");
        }
        assert_eq!(doc["agents"][AGENT]["mode"], "primary");
    }

    #[test]
    fn the_roles_carry_their_own_prompt_and_model() {
        let doc = fixture_doc();
        assert_eq!(doc["agents"]["writer-explorer"]["mode"], "subagent");
        assert_eq!(
            doc["agents"]["writer-explorer"]["model"],
            "fake/cheap-model"
        );
        assert_eq!(
            doc["agents"]["writer-worker"]["model"],
            "fake/standard-model"
        );
        // the explorer cannot edit, write or run a command: none of it is listed
        let explorer = &doc["agents"]["writer-explorer"]["permissions"];
        for n in ["edit", "write", "apply_patch", "shell"] {
            assert!(
                !with_effect(explorer, "allow").contains(&n.to_string())
                    && !with_effect(explorer, "ask").contains(&n.to_string()),
                "{n}"
            );
        }
    }

    #[test]
    fn writers_server_keeps_codemode_and_the_vault_files_are_listed_by_absolute_path() {
        let doc = fixture_doc();
        let server = &doc["mcp"]["servers"]["writer"];
        assert_eq!(server["type"], "local");
        assert_eq!(
            server["command"],
            json!(["/app/bin/writer", "vault=/vault", "mcp"])
        );
        assert!(server.get("codemode").is_none());
        for path in doc["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .chain(doc["skills"].as_array().unwrap())
        {
            assert!(path.as_str().unwrap().starts_with('/'), "{path}");
        }
    }

    #[test]
    fn nothing_the_user_must_keep_secret_is_in_the_document() {
        let text = serde_json::to_string(&fixture_doc())
            .unwrap()
            .to_lowercase();
        for word in ["password", "token", "secret", "apikey", "api_key"] {
            assert!(!text.contains(word), "{word}");
        }
        assert!(!text.contains("acceptedits"));
    }

    #[test]
    fn the_same_input_is_the_same_text() {
        let a = serde_json::to_string(&fixture_doc()).unwrap();
        assert_eq!(a, serde_json::to_string(&fixture_doc()).unwrap());
    }

    #[test]
    fn discovery_lists_only_what_exists_and_stays_in_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert_eq!(discover(&root), Discovered::default());
        std::fs::write(root.join("AGENTS.md"), "x").unwrap();
        std::fs::create_dir_all(root.join(".agents/skills")).unwrap();
        let d = discover(&root);
        assert_eq!(d.instructions, [root.join("AGENTS.md").to_string_lossy()]);
        assert_eq!(d.skills, [root.join(".agents/skills").to_string_lossy()]);
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("c.md"), "secret").unwrap();
            std::os::unix::fs::symlink(outside.path().join("c.md"), root.join("CLAUDE.md"))
                .unwrap();
            assert_eq!(discover(&root).instructions.len(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_skill_folder_with_an_entry_that_links_out_is_left_out_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("evil")).unwrap();
        std::fs::write(outside.path().join("evil/SKILL.md"), "x").unwrap();
        for dir in [".agents/skills", ".claude/skills"] {
            std::fs::create_dir_all(root.join(dir).join("fine")).unwrap();
            std::fs::write(root.join(dir).join("fine/SKILL.md"), "x").unwrap();
        }
        let both = [
            root.join(".claude/skills").to_string_lossy().into_owned(),
            root.join(".agents/skills").to_string_lossy().into_owned(),
        ];
        assert_eq!(discover(&root).skills, both);
        // a skill that is a link to a folder inside the vault is fine
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::os::unix::fs::symlink(root.join("shared"), root.join(".claude/skills/inner")).unwrap();
        assert_eq!(discover(&root).skills, both);
        // a skill folder that is a link out: only that skill folder (here the whole of
        // `.agents/skills`) goes, not the other one
        std::os::unix::fs::symlink(
            outside.path().join("evil"),
            root.join(".agents/skills/evil"),
        )
        .unwrap();
        assert_eq!(discover(&root).skills, [both[0].clone()]);
        // a link out inside a skill's own folder counts too
        std::os::unix::fs::symlink(
            outside.path().join("evil/SKILL.md"),
            root.join(".claude/skills/fine/extra.md"),
        )
        .unwrap();
        assert!(discover(&root).skills.is_empty());
        std::fs::remove_file(root.join(".claude/skills/fine/extra.md")).unwrap();
        std::fs::remove_file(root.join(".agents/skills/evil")).unwrap();
        assert_eq!(discover(&root).skills, both);
        // a link to a folder inside the vault is walked: a link out in it drops the folder
        std::os::unix::fs::symlink(outside.path().join("evil"), root.join("shared/out")).unwrap();
        assert_eq!(discover(&root).skills, [both[1].clone()]);
        std::fs::remove_file(root.join("shared/out")).unwrap();
        assert_eq!(discover(&root).skills, both);
    }

    /// Ordinary hidden files and odd entries never drop a skill folder.
    #[cfg(unix)]
    #[test]
    fn dotfiles_dangling_links_and_special_files_in_a_skill_do_not_drop_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let skills = root.join(".claude/skills");
        std::fs::create_dir_all(skills.join("cloned/.git/objects")).unwrap();
        std::fs::write(skills.join("cloned/.git/HEAD"), "ref").unwrap();
        std::fs::write(skills.join("cloned/SKILL.md"), "x").unwrap();
        std::fs::write(skills.join(".DS_Store"), "x").unwrap();
        std::fs::write(skills.join("cloned/.gitignore"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("gone"), skills.join("dangling")).unwrap();
        // a link into a hidden folder of the vault stays inside it
        std::os::unix::fs::symlink(skills.join("cloned/.git"), skills.join("to-git")).unwrap();
        // a cycle is walked once
        std::os::unix::fs::symlink(&skills, skills.join("cloned/loop")).unwrap();
        let _socket = std::os::unix::net::UnixListener::bind(skills.join("sock")).unwrap();
        assert_eq!(discover(&root).skills, [skills.to_string_lossy()]);
    }
}
