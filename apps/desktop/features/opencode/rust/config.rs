//! Writer's OpenCode config file (spec `SPECs/opencode-backend-spec.md` section 8): one document
//! for the window's vault, built from what the adapter and the tool table already say, never by
//! hand and never in the vault (`<app data>/opencode/<vault id>.json`, passed as
//! `OPENCODE_CONFIG`; `server.rs` writes it).
//!
//! What it holds:
//!
//! - `permissions`: the base rule `*: ask`, the shape captured with 2.4.0, and `default_agent`;
//! - `agents`: the one primary agent `writer` (the session's agent, spec 10.9; a head `*: ask`
//!   and then allows), the roles as sub-agents (the adapter renders them, each
//!   with its own rules), the built-in agents switched off so a model cannot launch one of them
//!   past Writer's rules, and OpenCode's own title agent switched off (the one title trigger is
//!   `title.rs`, A5). Within one list no action is named twice: a rule never depends on which of
//!   two matches wins;
//! - `mcp.servers.writer`, with codemode left on (U4): the adapter's fragment;
//! - `instructions` and `skills` as absolute paths: with the project's own config off the vault's
//!   `AGENTS.md`, `CLAUDE.md` and skill folders load only when listed (spec 4.12).
//!
//! On top of that document the server's one write path ([`overrides`], applied by
//! `OpencodeServer::apply_config`) adds what keeps the user's own OpenCode config, now loaded,
//! from running anything Writer did not switch on: the deny-all MCP policies and a placeholder
//! for every known server that is off, the agents of that config disabled by name, the providers
//! the user switched off, and the scalars Writer pins (`share`, `default_agent`, `automations`).
//!
//! The permission modes are not in this file: only Plan has rules of the session (`modes.rs`), and
//! Writer's own `once` replies are not rules at all. Pure except [`discover`].

use crate::agent::mcp_menu::{Applies, SwitchSpec};
use crate::agent::mcp_wiring::{server_key, Launch, McpWiring};
use crate::agent::permission_update::rule_json;
use crate::agent::project::{AGENTS_FILE, CLAUDE_FILE};
use crate::agent::skills::SKILL_DIRS;
use crate::agent::tool_table::{Kind, Role, ToolTable};
use crate::cli::mcp::SERVER_NAME;
use crate::fs_entry::{self, LinkTarget};
use crate::vault_ops;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
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

/// The ruleset of the primary agent: a head `*: ask`, then the allows. Rules are concatenated and
/// the last match wins, so with the user's own config loaded a global agent called `writer` could
/// otherwise out-rank the top level's ask (capture C5 V2); the head closes that (V6).
pub fn writer_rules(table: &ToolTable, mcp_reads: &[String]) -> Vec<Value> {
    std::iter::once(rule("*", "ask"))
        .chain(
            read_allows(table, mcp_reads)
                .iter()
                .map(|n| rule(n, "allow")),
        )
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

// ---------------------------------------------------------------------------------------------
// The overrides: Writer's file over the user's own config

/// The MCP switches of this backend: off unless listed, in force at once (a reload).
pub const MCP_SWITCHES: SwitchSpec = SwitchSpec {
    setting: "agent.opencode.enabled-mcp-servers",
    default_on: false,
    applies: Applies::Live,
};
/// The providers the user switched off, by id.
pub const PROVIDERS_OFF_SETTING: &str = "agent.opencode.disabled-providers";

/// What the server knows about the user's config and the user's switches, rendered over Writer's
/// document by [`overrides`]. Names only: no target, URL, environment or header of the user's
/// servers is ever held.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Overrides {
    /// The names allowed to start: the known servers that are switched on, and the switched-on
    /// keys not (yet) known. Writer's own server is always allowed and not listed here.
    pub mcp_on: Vec<String>,
    /// Every server name seen in the user's config or listed by the server. Each one that is not
    /// on gets a placeholder (a global `allow` policy of the user cannot start it).
    pub mcp_known: Vec<String>,
    /// Agents of the user's config (found by the server): disabled by name, as the built-in ones
    /// are ([`BUILT_IN_AGENTS`] is the seed of the set).
    pub foreign_agents: Vec<String>,
    /// Provider ids switched off.
    pub providers_off: Vec<String>,
}

/// The one list of the agents [`overrides`] disables: the built-in ones, OpenCode's title agent
/// and the ones the user's config adds.
fn disabled_agents(o: &Overrides) -> BTreeSet<String> {
    BUILT_IN_AGENTS
        .iter()
        .chain([&TITLE_AGENT])
        .map(|s| s.to_string())
        .chain(o.foreign_agents.iter().cloned())
        .collect()
}

/// A placeholder that is never run: `type` and `command` make the entry a full definition (a
/// partial `{disabled: true}` is ignored by 2.4.0, capture L1a), `disabled` keeps it off.
fn placeholder() -> Value {
    json!({"type": "local", "command": ["true"], "disabled": true})
}

fn policy(action: &str, resource: &str, effect: &str) -> Value {
    json!({"action": action, "resource": resource, "effect": effect})
}

/// The policies: deny every MCP server, then allow Writer's own and each one switched on (order
/// matters: the last match wins, so the deny comes first), then one deny per provider switched
/// off.
pub fn policies(o: &Overrides) -> Vec<Value> {
    let mut out = vec![
        policy("mcp.use", "*", "deny"),
        policy("mcp.use", SERVER_NAME, "allow"),
    ];
    let mut on: Vec<&String> = o.mcp_on.iter().filter(|n| *n != SERVER_NAME).collect();
    on.sort();
    on.dedup();
    out.extend(on.into_iter().map(|n| policy("mcp.use", n, "allow")));
    let mut off: Vec<&String> = o.providers_off.iter().collect();
    off.sort();
    off.dedup();
    out.extend(off.into_iter().map(|p| policy("provider.use", p, "deny")));
    out
}

/// Writer's document with the overrides on top. Both levers for MCP (capture C2): the policies
/// stop any server from starting, the placeholders beat a policy of the user's own, which is
/// applied after Writer's and wins over it. Agents Writer defines itself are never disabled.
/// Pure and deterministic: the same input is the same document.
pub fn overrides(mut doc: Value, o: &Overrides) -> Value {
    let Some(root) = doc.as_object_mut() else {
        return doc;
    };
    root.insert("policies".into(), Value::Array(policies(o)));
    // pinned: nothing the user's config sets for these applies in Writer (capture C6)
    root.insert("default_agent".into(), json!(AGENT));
    root.insert("automations".into(), json!(false));
    root.insert("share".into(), json!("disabled"));
    root.insert("update".into(), json!("disable"));
    let agents = root
        .entry("agents")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    if let Some(agents) = agents {
        for id in disabled_agents(o) {
            agents
                .entry(id)
                .or_insert_with(|| json!({"disabled": true}));
        }
    }
    let on: BTreeSet<String> = o.mcp_on.iter().map(|n| server_key(n)).collect();
    let mcp = root.entry("mcp").or_insert_with(|| json!({}));
    if let Some(servers) = mcp
        .as_object_mut()
        .map(|m| m.entry("servers").or_insert_with(|| json!({})))
        .and_then(Value::as_object_mut)
    {
        for name in &o.mcp_known {
            if name != SERVER_NAME && !on.contains(&server_key(name)) {
                servers.entry(name.clone()).or_insert_with(placeholder);
            }
        }
    }
    doc
}

/// The agents of the server's list that Writer did not configure and that could run: enabled, of
/// a mode a model or the user can pick, and not one of OpenCode's own hidden system agents.
pub fn foreign_agents(agents: &[Value], ours: &[String]) -> Vec<String> {
    agents
        .iter()
        .filter_map(|a| {
            let id = a["id"].as_str()?;
            let runs = a["disabled"] != true
                && matches!(a["mode"].as_str(), Some("subagent" | "primary" | "all"));
            let ok = ours.iter().any(|o| o == id)
                || (a["hidden"] == true && SYSTEM_AGENTS.contains(&id));
            (runs && !ok).then(|| id.to_string())
        })
        .collect()
}

/// OpenCode's own internal agents: hidden, never offered to the user, run by the server itself
/// (the context summary, its compaction). The contract (2.4.0) says only that an agent has a
/// `hidden` flag, not whether a model may launch a hidden sub-agent, so a hidden agent is trusted
/// by these names alone and any other one is as foreign as a visible one. (`title` is switched
/// off in Writer's config; it is listed in case a server shows it anyway.)
pub const SYSTEM_AGENTS: [&str; 3] = ["compaction", "summary", "title"];

/// The names Writer takes from the list of config documents (`GET /api/config`): the keys of
/// `info.mcp.servers` and whether a document sets an `mcp.use` policy that Writer did not write.
/// Keys and policy actions only: the same documents hold the servers' environment and headers,
/// which are never read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigNames {
    pub mcp: Vec<String>,
    /// A document other than Writer's sets an `mcp.use` policy (`own` is what Writer wrote).
    pub foreign_mcp_policy: bool,
}

/// Reads [`ConfigNames`] from the reply (a bare array of documents, or `{data: [...]}`). Writer's
/// own document is the one whose `path` is `own` (`settings.config_file`); an `mcp.use` policy in
/// any other document is the user's, whatever it says.
pub fn config_names(reply: &Value, own: &Path) -> ConfigNames {
    let same = |p: &str| {
        let (a, b) = (Path::new(p), own);
        a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
    };
    let docs = reply.get("data").unwrap_or(reply).as_array();
    let mut names = BTreeSet::new();
    let mut foreign = false;
    for doc in docs.into_iter().flatten() {
        let info = &doc["info"];
        if let Some(servers) = info["mcp"]["servers"].as_object() {
            names.extend(servers.keys().cloned());
        }
        let writers = doc["path"].as_str().is_some_and(same);
        foreign |= !writers
            && info["policies"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["action"] == "mcp.use");
    }
    names.remove(SERVER_NAME);
    ConfigNames {
        mcp: names.into_iter().collect(),
        foreign_mcp_policy: foreign,
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

    /// The captured shape: the base ask is the top level's and the primary agent's list repeats it
    /// as its head (a global agent called `writer` of the user's could out-rank the top level's,
    /// capture C5 V2), then allows; the lists of the agents never name an action twice (so no rule
    /// needs the last match to win).
    #[test]
    fn the_base_ask_is_the_top_levels_and_no_action_is_named_twice_in_a_list() {
        let doc = fixture_doc();
        assert_eq!(doc["permissions"], json!([rule("*", "ask")]));
        assert_eq!(doc["default_agent"], AGENT);
        let writer = doc["agents"][AGENT]["permissions"].as_array().unwrap();
        assert_eq!(
            writer[0],
            rule("*", "ask"),
            "the head closes a global agent's allow"
        );
        assert!(writer[1..]
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

    fn sample_overrides() -> Overrides {
        Overrides {
            mcp_on: vec!["g-a".into(), "my_srv".into(), "writer".into()],
            mcp_known: vec!["g-a".into(), "g-b".into(), "my.srv".into(), "writer".into()],
            foreign_agents: vec!["g-prim".into(), "build".into(), "writer".into()],
            providers_off: vec!["fake-b".into()],
        }
    }

    /// The fixture document with a fixed set of overrides, as the golden pins it.
    fn overridden_doc() -> Value {
        overrides(fixture_doc(), &sample_overrides())
    }

    #[test]
    fn the_overridden_document_is_pinned() {
        let actual = serde_json::to_string_pretty(&overridden_doc()).unwrap() + "\n";
        crate::agent::golden_tests::check_file(
            &crate::features::opencode::events_tests::feature_dir().join("goldens/config"),
            "overrides.json",
            &actual,
        );
    }

    /// Both levers of capture C2: the deny-all policies (deny first, the last match wins), the
    /// allows, and a placeholder for every known name that is off.
    #[test]
    fn mcp_is_denied_by_policy_and_by_a_placeholder_for_every_known_name_that_is_off() {
        let doc = overridden_doc();
        let pols: Vec<String> = doc["policies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| format!("{} {} {}", p["action"], p["resource"], p["effect"]))
            .collect();
        assert_eq!(
            pols,
            [
                "\"mcp.use\" \"*\" \"deny\"",
                "\"mcp.use\" \"writer\" \"allow\"",
                "\"mcp.use\" \"g-a\" \"allow\"",
                "\"mcp.use\" \"my_srv\" \"allow\"",
                "\"provider.use\" \"fake-b\" \"deny\"",
            ]
        );
        let servers = doc["mcp"]["servers"].as_object().unwrap();
        // off and known: a full definition that is disabled (a partial one is ignored)
        assert_eq!(
            servers["g-b"],
            json!({"type": "local", "command": ["true"], "disabled": true})
        );
        // `my.srv` is on under its key `my_srv`; `g-a` is on; Writer's own is never a placeholder
        assert!(servers.get("g-a").is_none() && servers.get("my.srv").is_none());
        assert_eq!(servers["writer"]["command"][0], "/app/bin/writer");
    }

    #[test]
    fn the_users_agents_are_disabled_by_name_and_writers_own_never_are() {
        let doc = overridden_doc();
        assert_eq!(doc["agents"]["g-prim"], json!({"disabled": true}));
        assert_eq!(doc["agents"]["build"], json!({"disabled": true}));
        // an agent Writer defines is never disabled, even when the server listed its name
        assert_ne!(doc["agents"][AGENT]["disabled"], true);
        assert_eq!(doc["agents"][AGENT]["mode"], "primary");
        // every built-in and the title agent are in the set whatever was learned
        let bare = overrides(fixture_doc(), &Overrides::default());
        for n in BUILT_IN_AGENTS.iter().chain([&TITLE_AGENT]) {
            assert_eq!(bare["agents"][n], json!({"disabled": true}), "{n}");
        }
    }

    /// Writer wins for these whatever the user's config says (capture C6).
    #[test]
    fn the_pinned_scalars_are_writers() {
        let doc = overridden_doc();
        assert_eq!(doc["default_agent"], AGENT);
        assert_eq!(doc["automations"], false);
        assert_eq!(doc["share"], "disabled");
        assert_eq!(doc["update"], "disable");
        // nothing the overrides add is a model, an instruction or a skill: those are the user's
        // and Writer's together
        assert!(doc.get("model").is_none());
        assert_eq!(doc["instructions"], fixture_doc()["instructions"]);
    }

    #[test]
    fn the_overrides_are_deterministic_and_idempotent() {
        let a = serde_json::to_string(&overridden_doc()).unwrap();
        assert_eq!(a, serde_json::to_string(&overridden_doc()).unwrap());
        assert_eq!(
            overrides(overridden_doc(), &sample_overrides()),
            overridden_doc(),
            "a document that already has them is unchanged"
        );
        // with nothing known the document still denies every server but Writer's
        let bare = overrides(json!({}), &Overrides::default());
        assert_eq!(bare["policies"].as_array().unwrap().len(), 2);
        assert!(bare["mcp"]["servers"].as_object().unwrap().is_empty());
    }

    /// A minimal check of a document against the pinned `Config.InfoEncoded`: unknown keys of an
    /// object that closes its properties, enum values, required keys and the types the rendered
    /// parts use. `$ref` and `anyOf` are followed (an `anyOf` holds when one member does).
    fn conforms(doc: &Value, schema: &Value, value: &Value, path: &str) -> Result<(), String> {
        if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
            let name = r.rsplit('/').next().unwrap();
            return conforms(doc, &doc["components"]["schemas"][name], value, path);
        }
        if let Some(any) = schema.get("anyOf").and_then(Value::as_array) {
            let tries: Vec<_> = any.iter().map(|m| conforms(doc, m, value, path)).collect();
            return if tries.iter().any(Result::is_ok) {
                Ok(())
            } else {
                Err(format!("{path}: no member of anyOf holds: {tries:?}"))
            };
        }
        if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
            if !allowed.contains(value) {
                return Err(format!("{path}: {value} is not one of {allowed:?}"));
            }
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("object") => {
                let obj = value.as_object().ok_or(format!("{path}: not an object"))?;
                let props = schema.get("properties").and_then(Value::as_object);
                for req in schema
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let k = req.as_str().unwrap();
                    if !obj.contains_key(k) {
                        return Err(format!("{path}: missing {k}"));
                    }
                }
                for (k, v) in obj {
                    let sub = props.and_then(|p| p.get(k));
                    match (sub, schema.get("additionalProperties")) {
                        (Some(sub), _) => conforms(doc, sub, v, &format!("{path}.{k}"))?,
                        (None, Some(extra)) if extra.is_object() => {
                            conforms(doc, extra, v, &format!("{path}.{k}"))?
                        }
                        (None, Some(Value::Bool(false))) => {
                            return Err(format!("{path}: unknown key {k}"))
                        }
                        (None, _) => {}
                    }
                }
                Ok(())
            }
            Some("array") => {
                let items = value.as_array().ok_or(format!("{path}: not an array"))?;
                match schema.get("items") {
                    Some(item) => items
                        .iter()
                        .enumerate()
                        .try_for_each(|(i, v)| conforms(doc, item, v, &format!("{path}[{i}]"))),
                    None => Ok(()),
                }
            }
            Some("string") if !value.is_string() => Err(format!("{path}: not a string")),
            Some("boolean") if !value.is_boolean() => Err(format!("{path}: not a boolean")),
            _ => Ok(()),
        }
    }

    /// The whole rendered document, overrides included, holds against the contract of the server
    /// it is pinned to: no key it would ignore or refuse.
    #[test]
    fn the_rendered_document_conforms_to_the_pinned_config_schema() {
        let contract: Value =
            serde_json::from_str(include_str!("../contract/openapi-2.4.0.json")).unwrap();
        let schema = contract["components"]["schemas"]["Config.InfoEncoded"].clone();
        for (name, doc) in [
            ("fixture", fixture_doc()),
            ("overridden", overridden_doc()),
            ("bare", overrides(json!({}), &Overrides::default())),
        ] {
            conforms(&contract, &schema, &doc, name).unwrap();
        }
        // and the checker does reject what it should
        let bad = json!({"policies": [{"action": "mcp.use", "resource": "x", "effect": "maybe"}]});
        assert!(conforms(&contract, &schema, &bad, "bad").is_err());
        let extra = json!({"not_a_key": 1});
        assert!(conforms(&contract, &schema, &extra, "extra").is_err());
    }

    const WRITERS: &str = "/app/opencode/vault.json";

    fn doc_at(path: &str, info: Value) -> Value {
        json!({"type": "file", "path": path, "info": info})
    }

    fn doc_entry(info: Value) -> Value {
        doc_at("/never/read", info)
    }

    /// `GET /api/config`: keys and the actions of the policies only; the servers' environment and
    /// headers are in the same documents and are never taken.
    #[test]
    fn the_names_are_the_keys_and_nothing_else_of_the_documents() {
        let own = Path::new(WRITERS);
        let reply = json!([
            doc_entry(json!({"mcp": {"servers": {
                "g-a": {"type": "local", "command": ["x"], "environment": {"TOKEN": "s3cret"}},
                "g-r": {"type": "remote", "url": "https://x", "headers": {"authorization": "s3cret"}},
                "writer": {"type": "local", "command": ["w"]},
            }}})),
            doc_at(
                WRITERS,
                json!({"policies": policies(&Overrides::default()), "mcp": {"servers": {"g-b": {}}}}),
            ),
        ]);
        let names = config_names(&reply, own);
        assert_eq!(
            names.mcp,
            ["g-a", "g-b", "g-r"],
            "sorted, Writer's own left out"
        );
        assert!(
            !names.foreign_mcp_policy,
            "Writer's own document is found by its path"
        );
        assert!(!format!("{names:?}").contains("s3cret"));
        // `{data: [...]}` reads the same
        assert_eq!(config_names(&json!({"data": reply}), own), names);
        assert_eq!(config_names(&json!(null), own), ConfigNames::default());
    }

    #[test]
    fn a_users_mcp_policy_is_seen_but_other_policies_are_not_one() {
        let own = Path::new(WRITERS);
        let allow_x = json!({"action": "mcp.use", "resource": "x", "effect": "allow"});
        let reply = json!([doc_entry(json!({"policies": [allow_x]}))]);
        assert!(config_names(&reply, own).foreign_mcp_policy);
        let provider = json!({"action": "provider.use", "resource": "x", "effect": "deny"});
        let reply = json!([doc_entry(json!({"policies": [provider]}))]);
        assert!(!config_names(&reply, own).foreign_mcp_policy);
        // Writer's own document, found by its path, is not the user's
        let mine = policies(&Overrides::default());
        let reply = json!([doc_at(WRITERS, json!({"policies": mine}))]);
        assert!(!config_names(&reply, own).foreign_mcp_policy);
        // a user document that holds exactly Writer's policies, at another path, is the user's
        let reply = json!([doc_entry(json!({"policies": mine}))]);
        assert!(config_names(&reply, own).foreign_mcp_policy);
    }

    /// The names step over the shape the real 2.4.0 gave (`fixtures/global-c2-levers.json`, N1:
    /// the user's document, its folder entry, Writer's, in that order; `global-c1-timing.json`:
    /// every entry has `type`, `path` and `info`). The capture scrubbed the path values, so they
    /// are synthetic here; what is pinned is that Writer's document is the one at its path.
    #[test]
    fn the_captured_documents_give_the_names_and_find_writers_by_its_path() {
        let dir = crate::features::opencode::events_tests::fixtures_dir();
        let read = |f: &str| -> Value {
            serde_json::from_str(&std::fs::read_to_string(dir.join(f)).unwrap()).unwrap()
        };
        let c1 = read("global-c1-timing.json");
        let keys: Vec<&str> = c1["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["result"]["top_level_keys"].as_array())
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        assert!(keys.contains(&"path") && keys.contains(&"info") && keys.contains(&"type"));
        let c2 = read("global-c2-levers.json");
        let n1 = c2["variants"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["variant"].as_str().is_some_and(|n| n.starts_with("N1")))
            .unwrap()["config_documents"]
            .as_array()
            .unwrap()
            .clone();
        let docs = |writer_path: &str| -> Value {
            Value::Array(
                n1.iter()
                    .enumerate()
                    .map(|(i, d)| {
                        let servers: Map<String, Value> = d["mcp_server_names"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| (n.as_str().unwrap().to_string(), json!({})))
                            .collect();
                        let path = if i == n1.len() - 1 {
                            writer_path.to_string()
                        } else {
                            format!("/user/{i}")
                        };
                        let mut info = json!({"mcp": {"servers": servers}});
                        if !d["policies"].is_null() {
                            info["policies"] = d["policies"].clone();
                        }
                        doc_at(&path, info)
                    })
                    .collect(),
            )
        };
        let names = config_names(&docs(WRITERS), Path::new(WRITERS));
        assert_eq!(names.mcp, ["g-a", "g-b", "g-r"]);
        assert!(
            !names.foreign_mcp_policy,
            "Writer's own policies are found by path"
        );
        // the capture does not show the path as the server spells it: when none matches, Writer's
        // own policies read as the user's, which falls back to Writer's config alone (closed)
        assert!(config_names(&docs("/elsewhere.json"), Path::new(WRITERS)).foreign_mcp_policy);
    }

    #[test]
    fn the_foreign_agents_are_the_enabled_ones_that_could_run_and_are_not_writers_or_systems() {
        let ours = vec!["writer".to_string()];
        let list = [
            json!({"id": "writer", "mode": "primary"}),
            json!({"id": "g-prim", "mode": "primary"}),
            json!({"id": "g-sub", "mode": "subagent", "disabled": false}),
            json!({"id": "off", "mode": "all", "disabled": true}),
            json!({"id": "tool", "mode": "tool"}),
            json!({"id": "summary", "mode": "primary", "hidden": true}),
        ];
        assert_eq!(foreign_agents(&list, &ours), ["g-prim", "g-sub"]);
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
