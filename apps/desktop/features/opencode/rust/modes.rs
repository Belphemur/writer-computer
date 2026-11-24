//! What Writer's permission modes mean to OpenCode, built from the evidence of spec section 10.9
//! (decided in auto mode, review):
//!
//! - the session's rules are **empty** in every mode but Plan, so a role's own (agent-level) rules
//!   hold and nothing is loosened for a sub-agent; Writer never writes a session-level allow;
//! - **Plan** is an allow-list at session level: deny everything, then allow the read tools of the
//!   tool table. A sub-agent inherits it (and is given it again on creation, and on a mode change);
//! - accepting edits, and the chat's own writes to its memory folder, are Writer's own `once`
//!   reply, never a rule (A12): the memory folder is the chat's own only, and in Plan the server
//!   denies the edit before anyone is asked. Under accept-edits a **worker** sub-agent of the chat
//!   is answered too, for an edit confined to the vault (decided with the user, 2026-11-24).

use super::config::{self, ConfigInput};
use super::opencode_api::ModelRef;
use super::transport::{Ask, Asker, Policy};
use crate::agent::events::AgentPermissionMode;
use crate::agent::roles::{backend_name, registry};
use crate::agent::tool_table::{is_writer_read_tool, Kind, Role, ToolTable};
use crate::agent::transport::LaunchConfig;
use crate::cli::mcp::{self, ToolSpec};
use crate::vault_ops;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The slugs of the models the user switched off.
pub type Disabled = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

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
                .filter(|t| is_writer_read_tool(t))
                .map(|t| format!("{}{}", mcp.prefix, t.name)),
        );
    }
    let mut rules = vec![config::rule("*", "deny")];
    rules.extend(names.into_iter().map(|n| config::rule(&n, "allow")));
    rules
}

/// The chat's own writes to its memory folder (`ask.memory`), decided fail-closed: the permission
/// is `edit` (the `write` tool asks for it too) and every resource is a file inside the folder:
///
/// - a relative resource is relative to the session's directory, also below a git worktree
///   (captured: `fixtures/tools/s37`, a directory below a `.git` shows `.memory/note.md`, not a
///   path from the worktree root); an absolute one is taken as it is;
/// - confined to the vault by `vault_ops::confine_with` (no `..`, no `.git`, and no link on the
///   way, in a folder or as the file itself), then below the memory folder;
/// - no pattern.
pub fn writes_only_memory(edit_action: &str, ask: &Ask<'_>) -> bool {
    let Some(memory) = ask.memory else {
        return false;
    };
    ask.action == edit_action
        && !ask.resources.is_empty()
        && ask.resources.iter().all(|r| in_memory(ask, memory, r))
}

fn in_memory(ask: &Ask<'_>, memory: &Path, resource: &str) -> bool {
    vault_file(ask, resource).is_some_and(|abs| abs != memory && abs.starts_with(memory))
}

/// The file a resource names, when it is one file inside the vault that no link leads out of: no
/// pattern, `vault_ops::confine_with` for the rest (the one confinement, memory's and a worker's).
fn vault_file(ask: &Ask<'_>, resource: &str) -> Option<PathBuf> {
    if resource.is_empty() || resource.contains(['*', '?', '[', '{', '\0']) {
        return None;
    }
    let path = Path::new(resource);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        ask.cwd.join(path)
    };
    let rel = abs
        .strip_prefix(ask.root)
        .ok()
        .and_then(Path::to_str)
        .filter(|r| !r.is_empty())?;
    // `.obsidian` and `.git` are never written unasked (the list is `vault_ops`'s own)
    if vault_ops::is_protected_rel(rel) {
        return None;
    }
    vault_ops::confine_with(ask.root, rel, &[])
        .ok()
        .map(|c| c.abs)
}

/// Whether `agent` is a role of Writer's that may write (the worker): a role of the registry, not
/// read-only. A name nobody knows, or none, is not.
fn may_write(agent: Option<&str>) -> bool {
    agent.is_some_and(|a| {
        registry()
            .roles
            .iter()
            .any(|r| !r.read_only && backend_name(&r.id) == a)
    })
}

pub struct ModePolicy {
    plan: Vec<Value>,
    /// The models the user switched off (read when a chat starts, so a change applies to the next
    /// start of a running chat too).
    disabled: Disabled,
    table: &'static ToolTable,
    /// The permission action of an edit (the table's replace tool: `write` asks for it as well).
    edit_action: Option<String>,
    /// The vault root (canonical): without it the policy does not own the config file.
    root: Option<PathBuf>,
}

impl ModePolicy {
    pub fn new(table: &'static ToolTable) -> Self {
        Self {
            plan: plan_rules(table, &mcp::tools()),
            disabled: Arc::new(Vec::new),
            table,
            edit_action: table.name_of(Role::Replace).map(String::from),
            root: None,
        }
    }

    /// The models switched off in Settings (`agent.opencode.disabled-models`), asked at each start.
    pub fn with_disabled(mut self, disabled: Disabled) -> Self {
        self.disabled = disabled;
        self
    }

    /// The policy of one vault: it builds the config file for it ([`Policy::config`]).
    pub fn for_vault(mut self, root: PathBuf) -> Self {
        self.root = Some(root);
        self
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
        Some(config::AGENT.into())
    }

    fn refuse_model(&self, model: &ModelRef) -> Option<String> {
        let slug = model.slug();
        (self.disabled)()
            .contains(&slug)
            .then(|| format!("The model {slug} is switched off in Settings > Agent > OpenCode"))
    }

    fn known_agents(&self) -> Vec<String> {
        std::iter::once(config::AGENT.to_string())
            .chain(registry().roles.iter().map(|r| backend_name(&r.id)))
            .collect()
    }

    /// The one place the rule lives. Own session: any edit under accept-edits, the chat's memory
    /// folder in the other modes (Plan and `dontAsk` nothing). A sub-agent of the chat, only under
    /// accept-edits: a writing role's edit whose every resource is one file inside the vault
    /// (never a link, never an explorer, never in Plan or manual).
    fn auto_allow(&self, ask: &Ask<'_>) -> bool {
        let Some(edit) = self.edit_action.as_deref() else {
            return false;
        };
        match (ask.mode, ask.from) {
            (AgentPermissionMode::AcceptEdits, Asker::Own) => ask.action == edit,
            (AgentPermissionMode::AcceptEdits, Asker::SubAgent(agent)) => {
                ask.action == edit
                    && may_write(agent)
                    && !ask.resources.is_empty()
                    && ask.resources.iter().all(|r| vault_file(ask, r).is_some())
            }
            // nothing is written in Plan, and in `dontAsk` nobody is asked
            (AgentPermissionMode::Plan | AgentPermissionMode::DontAsk, _) => false,
            (AgentPermissionMode::Manual | AgentPermissionMode::Auto, Asker::Own) => {
                writes_only_memory(edit, ask)
            }
            (AgentPermissionMode::Manual | AgentPermissionMode::Auto, Asker::SubAgent(_)) => false,
        }
    }

    fn config(&self, launch: &LaunchConfig) -> Result<Option<String>, String> {
        // without the config the server runs OpenCode's own agents: no chat may start on that
        let root = self
            .root
            .as_deref()
            .ok_or("the OpenCode policy has no vault, so it cannot write Writer's configuration")?;
        Ok(Some(config::render(&ConfigInput {
            table: self.table,
            roles: launch.agents.as_deref(),
            mcp: launch.mcp.as_ref(),
            found: &config::discover(root),
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tool_table::writer_mcp_kind;
    use serde_json::json;

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
        let p = ModePolicy::new(table());
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

    // ---- memory, the config file and the per-mode golden ----------------------------------------

    const MODES: [AgentPermissionMode; 5] = [
        AgentPermissionMode::Manual,
        AgentPermissionMode::AcceptEdits,
        AgentPermissionMode::Plan,
        AgentPermissionMode::Auto,
        AgentPermissionMode::DontAsk,
    ];

    /// A request as the policy sees it: `root` is the vault, `from` whose it is.
    fn ask<'a>(
        root: &'a Path,
        from: Asker<'a>,
        mode: AgentPermissionMode,
        action: &'a str,
        resources: &'a [String],
        cwd: &'a Path,
        memory: Option<&'a Path>,
    ) -> Ask<'a> {
        Ask {
            from,
            mode,
            action,
            resources,
            root,
            cwd,
            memory,
        }
    }

    fn allows(p: &ModePolicy, mode: AgentPermissionMode, action: &str, resource: &str) -> bool {
        let r = [resource.to_string()];
        p.auto_allow(&ask(
            Path::new("/vault"),
            Asker::Own,
            mode,
            action,
            &r,
            Path::new("/vault"),
            Some(Path::new("/vault/.writer/memory")),
        ))
    }

    fn capture(name: &str) -> Value {
        let t = std::fs::read_to_string(
            super::super::events_tests::fixtures_dir().join(format!("{name}.json")),
        )
        .unwrap();
        serde_json::from_str::<Value>(&t).unwrap()["results"].clone()
    }

    /// s37 (`fixtures/memory-base-*`): the write's permission is `edit` on `.memory/note.md` in all
    /// three layouts, so the resource is relative to the session's directory, and the policy
    /// reads it that way.
    #[test]
    fn the_captured_memory_writes_ask_for_the_same_relative_resource_and_are_read_from_the_cwd() {
        let r = capture("memory-base-no-git");
        let memory = Path::new("/vault/.memory");
        for (label, cwd) in [
            ("1-no-git-dir-is-root", "/vault"),
            ("2-git-dir-below", "/vault/sub/dir"),
            ("3-git-dir-is-root", "/vault"),
        ] {
            assert_eq!(
                r[label],
                json!([["edit", [".memory/note.md"], ".memory/note.md"]]),
                "{label}"
            );
            let res = [r[label][0][1][0].as_str().unwrap().to_string()];
            let a = ask(
                Path::new("/vault"),
                Asker::Own,
                AgentPermissionMode::AcceptEdits,
                "edit",
                &res,
                Path::new(cwd),
                Some(memory),
            );
            // from a directory below the root the same words name another file: not memory
            assert_eq!(writes_only_memory("edit", &a), cwd == "/vault", "{label}");
        }
    }

    /// s34 part b (`fixtures/plan-codemode`, `opencode-go/glm-5.3-flash`, run as the `build` agent,
    /// one prompt): under Plan's shape of rules (`*: deny` and one allowed `writer_` read) the model
    /// did not call `execute`; it called the allowed read directly, and nobody was asked. Whether
    /// `execute` was offered to it is not shown, nor whether an `execute`'s inner calls are gated
    /// per tool, so Plan keeps it denied.
    #[test]
    fn captured_plan_run_did_not_call_execute_and_the_allowed_read_ran_directly() {
        let r = capture("plan-codemode")["plan_codemode"].clone();
        let t = table();
        let execute = t.name_of(Role::Codemode).expect("a codemode row");
        let prefix = &t.mcp.as_ref().unwrap().prefix;
        assert_eq!(r["end"], "session.execution.succeeded");
        assert_eq!(r["asked"], json!([]));
        assert_eq!(r["tools_started"], json!(["writer_note_count"]));
        assert_eq!(r["results"], json!([["writer_note_count", "ok"]]));
        assert!(r["tools_started"][0].as_str().unwrap().starts_with(prefix));
        // the rules Writer sends: the same shape, `execute` never allowed, the reads by that spelling
        let names = allowed(&plan_rules(t, &mcp::tools()));
        assert!(!names.contains(&execute.to_string()));
        assert!(names.contains(&format!("{prefix}search")));
    }

    /// s36 (`fixtures/config-rule-order-*`): a read-allowing primary agent under the top-level ask
    /// reads quietly and its edit asks; a `[*: deny, read: allow]` list reads and asks nothing.
    /// (The `[*: ask, edit: deny]` capture proved nothing about order: the model never tried an
    /// edit, so no claim rests on it.)
    #[test]
    fn the_captured_rule_shapes_read_quietly_and_ask_for_the_edit() {
        let r = capture("config-rule-order-reads-allowed");
        assert_eq!(r["w"]["asked"].as_array().unwrap().len(), 1);
        assert_eq!(r["w"]["asked"][0][1], "edit");
        assert_eq!(r["w"]["tools"][0][1], "read");
        assert_eq!(r["w"]["tools"][0][2], "ok");
        assert_eq!(r["w"]["a.txt"], "alpha", "nothing was written");
        assert_eq!(r["w-role"]["asked"], json!([]));
        assert_eq!(r["w-role"]["tools"][0][1], "read");
        assert_eq!(r["w-role"]["tools"][0][2], "ok");
    }

    /// What a mode does, pinned: the agent, the rules of the session and of a child, and which
    /// requests of the chat's own session Writer answers itself.
    #[test]
    fn golden_every_mode_as_the_session_gets_it() {
        let p = ModePolicy::new(table());
        let probes = [
            ("edit", "notes.md"),
            ("edit", ".writer/memory/MEMORY.md"),
            ("edit", ".writer/memory/../../notes.md"),
            ("shell", "ls"),
            ("webfetch", "https://example.com"),
            ("read", "notes.md"),
        ];
        let mut out = serde_json::Map::new();
        for mode in MODES {
            let answered: Vec<Value> = probes
                .iter()
                .map(|(a, r)| json!({"action": a, "resource": r, "writerAnswersOnce": allows(&p, mode, a, r)}))
                .collect();
            out.insert(
                serde_json::to_value(mode)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string(),
                json!({
                    "agent": p.agent(mode),
                    "sessionRules": p.session_rules(mode),
                    "childRules": p.child_rules(mode),
                    "requests": answered,
                }),
            );
        }
        let actual = serde_json::to_string_pretty(&Value::Object(out)).unwrap() + "\n";
        crate::agent::golden_tests::check_file(
            &super::super::events_tests::feature_dir().join("goldens/config"),
            "modes.json",
            &actual,
        );
    }

    #[test]
    fn no_mode_but_plan_has_rules_of_the_session_and_none_ever_allows() {
        let p = ModePolicy::new(table());
        for mode in MODES {
            let all = p
                .session_rules(mode)
                .into_iter()
                .chain(p.child_rules(mode).into_iter().flatten());
            for r in all {
                // the one deny of Plan, then allows of reads only: a session-level allow beats a
                // role's own deny (spec 10.9), so there is never one for the write side
                if r["effect"] == "allow" {
                    assert_eq!(mode, AgentPermissionMode::Plan);
                    for w in [
                        "edit",
                        "write",
                        "apply_patch",
                        "shell",
                        "execute",
                        "skill",
                        "todowrite",
                    ] {
                        assert_ne!(r["action"], w);
                    }
                }
            }
        }
        // `auto` and `dontAsk` are not mapped: they ask like manual
        for mode in [AgentPermissionMode::Auto, AgentPermissionMode::DontAsk] {
            assert!(p.session_rules(mode).is_empty() && p.child_rules(mode).is_none());
        }
    }

    #[test]
    fn the_chats_own_memory_folder_is_written_without_a_card_and_nothing_near_it_is() {
        let p = ModePolicy::new(table());
        for mode in [AgentPermissionMode::Manual, AgentPermissionMode::Auto] {
            assert!(
                allows(&p, mode, "edit", ".writer/memory/MEMORY.md"),
                "{mode:?}"
            );
            assert!(allows(&p, mode, "edit", ".writer/memory/sub/fact.md"));
            assert!(allows(&p, mode, "edit", "/vault/.writer/memory/fact.md"));
            // out of the folder by `..`, beside it, the folder itself, a pattern, a note
            for bad in [
                ".writer/memory/../../notes.md",
                ".writer/memory/../notes.md",
                ".writer/memory",
                ".writer/memory2/x.md",
                ".writer/memory/*.md",
                ".writer/memory/{a,b}",
                "../.writer/memory/x.md",
                "../../../etc/hosts",
                "/etc/hosts",
                "notes.md",
                "",
            ] {
                assert!(!allows(&p, mode, "edit", bad), "{mode:?} {bad}");
            }
            // only the edit action: a shell command that names the folder is a card
            assert!(!allows(&p, mode, "shell", ".writer/memory/x.md"));
            assert!(!allows(&p, mode, "read", ".writer/memory/x.md"));
        }
        // the policy never loosens Plan, `dontAsk` or a chat with no memory
        for mode in [AgentPermissionMode::Plan, AgentPermissionMode::DontAsk] {
            assert!(
                !allows(&p, mode, "edit", ".writer/memory/MEMORY.md"),
                "{mode:?}"
            );
        }
        let r = [".writer/memory/x.md".to_string()];
        assert!(!p.auto_allow(&ask(
            Path::new("/vault"),
            Asker::Own,
            AgentPermissionMode::Manual,
            "edit",
            &r,
            Path::new("/vault"),
            None
        )));
        // one resource out of two is a card
        let two = [".writer/memory/a.md".to_string(), "notes.md".to_string()];
        assert!(!p.auto_allow(&ask(
            Path::new("/vault"),
            Asker::Own,
            AgentPermissionMode::Manual,
            "edit",
            &two,
            Path::new("/vault"),
            Some(Path::new("/vault/.writer/memory")),
        )));
        assert!(!p.auto_allow(&ask(
            Path::new("/vault"),
            Asker::Own,
            AgentPermissionMode::Manual,
            "edit",
            &[],
            Path::new("/vault"),
            Some(Path::new("/vault/.writer/memory")),
        )));
    }

    #[test]
    fn a_relative_resource_is_relative_to_the_sessions_directory_and_only_the_chats_folder_counts()
    {
        let p = ModePolicy::new(table());
        let (cwd, memory) = (Path::new("/vault/p/q"), Path::new("/vault/p/q/.memory"));
        let check = |r: &str| {
            let r = [r.to_string()];
            p.auto_allow(&ask(
                Path::new("/vault"),
                Asker::Own,
                AgentPermissionMode::Manual,
                "edit",
                &r,
                cwd,
                Some(memory),
            ))
        };
        assert!(check(".memory/a.md"));
        assert!(check("/vault/p/q/.memory/a.md"));
        assert!(
            !check("../../.writer/memory/a.md"),
            "the vault's memory is not this chat's"
        );
        assert!(!check("/vault/.writer/memory/a.md"));
        assert!(!check("a.md"));
        assert!(!check("../.memory/a.md"));
    }

    /// A real folder: a plain file in memory is answered; a link out of it, as a folder or as the
    /// file, never.
    #[cfg(unix)]
    #[test]
    fn memory_confinement_follows_no_link_and_reads_a_relative_resource_from_the_sessions_directory(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().canonicalize().unwrap();
        let root = outer.join("vault");
        let memory = root.join(".writer/memory");
        std::fs::create_dir_all(&memory).unwrap();
        let elsewhere = outer.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("f.md"), "x").unwrap();
        std::os::unix::fs::symlink(&elsewhere, memory.join("dir-out")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("f.md"), memory.join("file-out.md")).unwrap();
        std::fs::write(memory.join("plain.md"), "x").unwrap();
        let p = ModePolicy::new(table());
        let check = |cwd: &Path, r: &str| {
            let r = [r.to_string()];
            p.auto_allow(&ask(
                &root,
                Asker::Own,
                AgentPermissionMode::Manual,
                "edit",
                &r,
                cwd,
                Some(&memory),
            ))
        };
        let abs = |rel: &str| memory.join(rel).to_string_lossy().into_owned();
        assert!(check(&root, ".writer/memory/plain.md"));
        assert!(check(&root, ".writer/memory/new-fact.md"));
        assert!(check(&root, &abs("plain.md")));
        for bad in ["dir-out/x.md", "dir-out/f.md", "file-out.md"] {
            assert!(!check(&root, &format!(".writer/memory/{bad}")), "{bad}");
            assert!(!check(&root, &abs(bad)), "{bad}");
        }
        // below the root, a relative resource is the session's own: this chat's memory is its folder
        std::fs::create_dir_all(root.join("p/.memory")).unwrap();
        let below = |r: &str| {
            let r = [r.to_string()];
            p.auto_allow(&ask(
                &root,
                Asker::Own,
                AgentPermissionMode::Manual,
                "edit",
                &r,
                &root.join("p"),
                Some(&root.join("p/.memory")),
            ))
        };
        assert!(below(".memory/a.md"));
        assert!(!below(".writer/memory/plain.md"));
        // a `.git` above or at the root changes nothing: the base is the session's directory
        std::fs::create_dir_all(outer.join(".git")).unwrap();
        assert!(check(&root, ".writer/memory/plain.md"));
        assert!(below(".memory/a.md"));
    }

    #[test]
    fn accepting_edits_answers_any_edit_of_the_chat_and_nothing_else() {
        let p = ModePolicy::new(table());
        let m = AgentPermissionMode::AcceptEdits;
        assert!(allows(&p, m, "edit", "notes.md"));
        for other in ["shell", "webfetch", "read"] {
            assert!(!allows(&p, m, other, "x"), "{other}");
        }
    }

    /// A real vault with a link out of it: what a worker may edit unasked, in every mode.
    #[cfg(unix)]
    #[test]
    fn a_workers_confined_edit_is_answered_under_accept_edits_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().canonicalize().unwrap();
        let root = outer.join("vault");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "x").unwrap();
        let elsewhere = outer.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("f.md"), "x").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("dir-out")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("f.md"), root.join("file-out.md")).unwrap();
        let p = ModePolicy::new(table());
        let check = |mode, from, action: &str, resources: &[&str]| {
            let r: Vec<String> = resources.iter().map(|s| s.to_string()).collect();
            p.auto_allow(&ask(&root, from, mode, action, &r, &root, None))
        };
        let worker = Asker::SubAgent(Some("writer-worker"));
        let accept = AgentPermissionMode::AcceptEdits;
        // inside the vault: an existing note, a new one, an absolute path
        assert!(check(accept, worker, "edit", &["notes/a.md"]));
        assert!(check(accept, worker, "edit", &["notes/new.md"]));
        assert!(check(
            accept,
            worker,
            "edit",
            &[root.join("notes/a.md").to_str().unwrap()]
        ));
        // outside, through a link (folder or file), a pattern, one of two, none
        for bad in [
            "../elsewhere/f.md",
            "/etc/hosts",
            "dir-out/f.md",
            "dir-out/new.md",
            "file-out.md",
            "notes/*.md",
            ".git/config",
            "notes/.git/config",
            ".obsidian/app.json",
            ".Obsidian/plugins/p/data.json",
            "notes/.obsidian/x.md",
            ".obsidian\u{200C}/x.json",
            ".obsidian./x",
            "",
        ] {
            assert!(!check(accept, worker, "edit", &[bad]), "{bad}");
        }
        assert!(!check(accept, worker, "edit", &["notes/a.md", "../x.md"]));
        assert!(!check(accept, worker, "edit", &[]));
        // only the edit action
        for other in ["shell", "webfetch", "read"] {
            assert!(!check(accept, worker, other, &["notes/a.md"]), "{other}");
        }
        // a role that may not write, one nobody knows, one the server did not name
        for from in [
            Asker::SubAgent(Some("writer-explorer")),
            Asker::SubAgent(Some("general")),
            Asker::SubAgent(None),
        ] {
            assert!(!check(accept, from, "edit", &["notes/a.md"]), "{from:?}");
        }
        // never outside accept-edits, whatever the agent
        for mode in MODES.into_iter().filter(|m| *m != accept) {
            for from in [worker, Asker::SubAgent(Some("writer-explorer"))] {
                assert!(!check(mode, from, "edit", &["notes/a.md"]), "{mode:?}");
            }
        }
        // a sub-agent never writes the chat's memory unasked either
        let r = [".writer/memory/MEMORY.md".to_string()];
        assert!(!p.auto_allow(&ask(
            &root,
            worker,
            AgentPermissionMode::Manual,
            "edit",
            &r,
            &root,
            Some(&root.join(".writer/memory")),
        )));
    }

    #[test]
    fn a_policy_of_a_vault_builds_the_config_and_one_without_fails() {
        let launch = super::super::transport_tests::launch(AgentPermissionMode::Manual);
        assert!(ModePolicy::new(table()).config(&launch).is_err());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("AGENTS.md"), "x").unwrap();
        let text = ModePolicy::new(table())
            .for_vault(root.clone())
            .config(&launch)
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["agents"]["writer"]["mode"], "primary");
        assert_eq!(
            v["instructions"],
            json!([root.join("AGENTS.md").to_string_lossy()])
        );
        // the same launch is the same text: no rewrite, no reload
        assert_eq!(
            text,
            ModePolicy::new(table())
                .for_vault(root)
                .config(&launch)
                .unwrap()
                .unwrap()
        );
    }
}
