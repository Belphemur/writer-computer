//! The agent roles, backend-neutral (ADR "Define agent roles once and map them to each agent
//! backend through adapters", spec `SPECs/agent-roles-spec.md`). Tauri-free.
//!
//! `shared/agent-roles.json` is the one definition of a role: purpose, prompt, model tier and
//! capabilities, with no vendor model name and no tool name (`features/agent/web/lib/agent-roles.ts` reads
//! the same file). A [`RoleAdapter`] maps it to one backend's config (`subagents.rs` is the Claude
//! adapter): capabilities become that backend's tools, tiers become models from that backend's tier
//! settings. This module owns what is common to every adapter: parsing, the availability flags, the
//! prompt and delegation text with the adapter's tool names filled in, and the one `writer-<id>`
//! name.

use super::mcp_wiring::ToolsAdapter;
use crate::cli::mcp;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The capability that needs the managed `writer` skills installed for the spawned CLI.
pub const WRITER_CLI_READ: &str = "writer-cli-read";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub tiers: Vec<String>,
    pub capabilities: BTreeMap<String, String>,
    pub roles: Vec<Role>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub purpose: String,
    /// Backend-neutral; `{<capability>}` is the adapter's tools for that capability.
    pub prompt: String,
    /// Appended to the prompt when the capability is granted.
    #[serde(default)]
    pub prompt_by_capability: BTreeMap<String, String>,
    pub tier: String,
    pub capabilities: Vec<String>,
    pub read_only: bool,
    /// Preconditions (see [`Flags`]); a role whose precondition is unmet is not offered.
    #[serde(default)]
    pub requires: Vec<String>,
    pub delegation: Delegation,
}

/// What the orchestrating agent is told about handing work to a role.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub lead: String,
    pub tasks: Vec<DelegationTask>,
    pub summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum DelegationTask {
    Plain(String),
    Gated { text: String, capability: String },
}

/// The registry, parsed once from the shared file.
pub fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/agent-roles.json"))
            .expect("agent-roles.json is malformed")
    })
}

/// The backend-visible name of a role: `writer-<id>` (derived here only, so chats and the
/// orchestration text keep one spelling).
pub fn backend_name(id: &str) -> String {
    format!("writer-{id}")
}

/// The label shown for a sub-agent: the role id of a `writer-<id>` name (the inverse of
/// [`backend_name`]), else the name as the backend gave it; control characters dropped, cut to 40.
pub fn role_label(sub_agent: &str) -> String {
    let id = registry()
        .roles
        .iter()
        .find(|r| backend_name(&r.id) == sub_agent)
        .map(|r| r.id.as_str())
        .unwrap_or(sub_agent);
    id.chars().filter(|c| !c.is_control()).take(40).collect()
}

// ---------------------------------------------------------------------------------------------
// Availability

/// Preconditions a role may name in `requires`. A flag turns true when the code and tests behind
/// it exist; this is the one place that says which are (ADR item 5 for `changes-coverage`).
#[derive(Debug, Clone)]
pub struct Flags(BTreeMap<&'static str, bool>);

/// Every precondition the registry may name, with its current value.
const FLAG_VALUES: &[(&str, bool)] = &[
    // Sub-agent edits reach the Changes card: snapshot before write, the turn open until every
    // sub-agent finished, per-role attribution, an answerable sub-agent permission card. All four
    // are implemented and pinned by `runner_tests::a_sub_agent_*`, `the_card_stays_open_*` and
    // `a_manual_mode_sub_agent_*` (fake `claude`) and `sub_tracker::tests`.
    ("changes-coverage", true),
];

impl Flags {
    pub fn current() -> Self {
        Flags(FLAG_VALUES.iter().copied().collect())
    }

    pub fn is_known(name: &str) -> bool {
        FLAG_VALUES.iter().any(|(n, _)| *n == name)
    }

    /// An unknown flag is unmet (a role is never offered on a typo).
    pub fn met(&self, name: &str) -> bool {
        self.0.get(name).copied().unwrap_or(false)
    }

    #[cfg(test)]
    pub fn with(mut self, name: &'static str, value: bool) -> Self {
        self.0.insert(name, value);
        self
    }
}

impl Role {
    pub fn offered(&self, flags: &Flags) -> bool {
        self.requires.iter().all(|f| flags.met(f))
    }

    /// The capabilities this session grants: all of them, minus `writer-cli-read` unless the
    /// managed `writer` skills are installed for the spawned CLI.
    pub fn granted(&self, writer_cli: bool) -> impl Iterator<Item = &str> {
        self.capabilities
            .iter()
            .map(String::as_str)
            .filter(move |c| writer_cli || *c != WRITER_CLI_READ)
    }

    fn has_granted(&self, writer_cli: bool, capability: &str) -> bool {
        self.granted(writer_cli).any(|c| c == capability)
    }
}

// ---------------------------------------------------------------------------------------------
// Adapters

/// What a backend does with one capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilitySupport {
    /// The backend's tool names for it, in a stable order.
    Tools(&'static [&'static str]),
    /// Not a tool but a backend setting, by its name there (Claude: `autoMemoryDirectory`, passed
    /// as `--settings` JSON by `claude_stream::memory_settings_json`).
    Setting(&'static str),
    /// The backend cannot grant it; what happens instead (the permission model, the prompt).
    Unsupported { fallback: &'static str },
}

/// The inputs of one render: what the session knows.
pub struct RenderInput<'a> {
    /// The managed `writer` skills are installed for the spawned CLI.
    pub writer_cli: bool,
    /// The backend's tier model settings by tier id, as the user set them (blank = default).
    pub tier_models: &'a BTreeMap<String, Option<String>>,
    pub flags: &'a Flags,
}

/// One role an adapter produced for this session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedRole {
    pub id: String,
    /// The backend-visible name ([`backend_name`]).
    pub name: String,
    /// The sentence that tells the orchestrator when to hand work to it.
    pub delegation: String,
}

/// What an adapter produced: the backend's config text (Claude: the `--agents` JSON) and the
/// roles in it. No roles means no config and no orchestration line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub config: Option<String>,
    /// How this backend says "launch a sub-agent", plural (`several {launch} in one message`).
    pub launch: &'static str,
    pub roles: Vec<RenderedRole>,
}

impl Rendered {
    /// A backend without sub-agents, or none offered.
    pub fn none() -> Self {
        Rendered {
            config: None,
            launch: "",
            roles: Vec::new(),
        }
    }
}

/// One backend's translation of the registry. Pure: no IO, no Tauri. A backend's role text names
/// Writer's own tools, so its adapter is also its [`ToolsAdapter`] (ADR 2026-11-19).
pub trait RoleAdapter: ToolsAdapter {
    /// Capability to this backend's tools. Every registry capability must answer (a test).
    fn capability(&self, capability: &str) -> CapabilitySupport;
    /// Roles, tiers and flags to this backend's config.
    fn render(&self, input: &RenderInput<'_>) -> Rendered;
    /// The backend reads skills, MCP servers, settings and instruction files only when its
    /// process starts, so Writer restarts a chat's process (`--resume`) when one of them changes
    /// (`config_sync.rs`, `agent.auto-reload`). A backend that reloads them itself answers
    /// `false` and none of that applies to it.
    fn restart_on_config_change(&self) -> bool;
}

/// The names the backend gives every read tool of Writer's server (the `writer-cli-read`
/// capability): the registry's read tools through the adapter's [`ToolsAdapter::read_rules`],
/// never a hand-kept list. Leaked, so a capability can hand them out as `'static`: an adapter
/// calls it once and keeps the result (the registry is static, so there are as many as backends).
pub fn leak_read_tools(adapter: &dyn ToolsAdapter) -> &'static [&'static str] {
    let names: Vec<&'static str> = adapter
        .read_rules(&mcp::tools())
        .into_iter()
        .map(|n| &*Box::leak(n.into_boxed_str()))
        .collect();
    Box::leak(names.into_boxed_slice())
}

/// The tool names a backend gives a role's granted capabilities, in order, without repeats.
pub fn role_tools(adapter: &dyn RoleAdapter, role: &Role, writer_cli: bool) -> Vec<&'static str> {
    let mut tools: Vec<&'static str> = Vec::new();
    for cap in role.granted(writer_cli) {
        if let CapabilitySupport::Tools(names) = adapter.capability(cap) {
            for n in names {
                if !tools.contains(n) {
                    tools.push(n);
                }
            }
        }
    }
    tools
}

/// Where a role's `promptByCapability` text asks for the search line (the one wording of the
/// main prompt, `writer_prompt::search_line`, with the backend's tool names).
const SEARCH_LINE_TOKEN: &str = "{search-line}";

/// The role's prompt for this backend: the neutral text with each `{<capability>}` replaced by the
/// backend's tool names (`A and B`), then the `promptByCapability` sentences of the granted
/// capabilities, with the search line in the backend's tool names.
pub fn role_prompt(adapter: &dyn RoleAdapter, role: &Role, writer_cli: bool) -> String {
    let mut prompt = role.prompt.clone();
    for cap in registry().capabilities.keys() {
        let token = format!("{{{cap}}}");
        if prompt.contains(&token) {
            let names = match adapter.capability(cap) {
                CapabilitySupport::Tools(names) => names.join(" and "),
                CapabilitySupport::Setting(_) | CapabilitySupport::Unsupported { .. } => {
                    String::new()
                }
            };
            prompt = prompt.replace(&token, &names);
        }
    }
    for cap in role.granted(writer_cli) {
        if let Some(extra) = role.prompt_by_capability.get(cap) {
            prompt.push(' ');
            prompt.push_str(extra);
        }
    }
    if prompt.contains(SEARCH_LINE_TOKEN) {
        prompt = prompt.replace(
            SEARCH_LINE_TOKEN,
            &super::writer_prompt::search_line(adapter),
        );
    }
    prompt
}

/// The sentence that tells the orchestrator to hand a kind of work to this role.
pub fn delegation_sentence(role: &Role, writer_cli: bool) -> String {
    let d = &role.delegation;
    let tasks: Vec<&str> = d
        .tasks
        .iter()
        .filter_map(|t| match t {
            DelegationTask::Plain(text) => Some(text.as_str()),
            DelegationTask::Gated { text, capability } => role
                .has_granted(writer_cli, capability)
                .then_some(text.as_str()),
        })
        .collect();
    let what = if tasks.is_empty() {
        d.lead.clone()
    } else {
        format!("{} ({})", d.lead, tasks.join(", "))
    };
    format!(
        "Delegate {what} to `{}`, {}.",
        backend_name(&role.id),
        d.summary
    )
}

/// The roles an adapter renders: offered ones only, with their delegation sentence.
pub fn offered_roles<'a>(flags: &'a Flags) -> impl Iterator<Item = &'static Role> + 'a {
    registry().roles.iter().filter(move |r| r.offered(flags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::claude_adapter::ClaudeAdapter;

    const TOOL_NAMES: &[&str] = &[
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "Edit",
        "MultiEdit",
        "Write",
        "NotebookEdit",
        "Task",
        "Agent",
    ];
    const VENDOR_WORDS: &[&str] = &["haiku", "sonnet", "opus", "claude", "anthropic", "gpt"];

    /// Every neutral text of the registry: prompts, purposes and delegation wording.
    fn neutral_texts(role: &Role) -> Vec<&str> {
        let mut out = vec![role.purpose.as_str(), role.prompt.as_str()];
        out.extend(role.prompt_by_capability.values().map(String::as_str));
        out.push(role.delegation.lead.as_str());
        out.push(role.delegation.summary.as_str());
        for t in &role.delegation.tasks {
            out.push(match t {
                DelegationTask::Plain(s) => s,
                DelegationTask::Gated { text, .. } => text,
            });
        }
        out
    }

    fn words(text: &str) -> Vec<&str> {
        text.split(|c: char| !c.is_alphanumeric() && c != '-')
            .filter(|w| !w.is_empty())
            .collect()
    }

    #[test]
    fn ids_tiers_and_capabilities_exist_and_are_unique() {
        let reg = registry();
        assert_eq!(reg.version, 1);
        assert_eq!(reg.tiers, ["cheap", "standard", "strong"]);
        let mut seen = Vec::new();
        for role in &reg.roles {
            assert!(
                !role.id.is_empty()
                    && role
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{}: not a lowercase slug",
                role.id
            );
            assert!(!seen.contains(&&role.id), "{}: duplicate id", role.id);
            seen.push(&role.id);
            assert!(reg.tiers.contains(&role.tier), "{}: unknown tier", role.id);
            for cap in &role.capabilities {
                assert!(
                    reg.capabilities.contains_key(cap),
                    "{}: unknown capability {cap}",
                    role.id
                );
            }
            for cap in
                role.prompt_by_capability
                    .keys()
                    .chain(role.delegation.tasks.iter().filter_map(|t| match t {
                        DelegationTask::Gated { capability, .. } => Some(capability),
                        DelegationTask::Plain(_) => None,
                    }))
            {
                assert!(
                    role.capabilities.contains(cap),
                    "{}: text gated on {cap}, which the role does not hold",
                    role.id
                );
            }
            for flag in &role.requires {
                assert!(Flags::is_known(flag), "{}: unknown flag {flag}", role.id);
            }
        }
    }

    #[test]
    fn read_only_roles_hold_no_write_capability() {
        for role in &registry().roles {
            if role.read_only {
                for cap in &role.capabilities {
                    assert!(
                        !["edit", "write", "bash-limited"].contains(&cap.as_str()),
                        "{}: read-only but holds {cap}",
                        role.id
                    );
                }
            } else {
                assert!(
                    role.capabilities
                        .iter()
                        .any(|c| c == "edit" || c == "write"),
                    "{}: not read-only but cannot edit",
                    role.id
                );
            }
        }
    }

    /// The prompts and wording never name a tool or a vendor model: adapters supply those.
    #[test]
    fn neutral_texts_name_no_tool_and_no_vendor() {
        for role in &registry().roles {
            for text in neutral_texts(role) {
                for w in words(text) {
                    assert!(
                        !TOOL_NAMES.contains(&w),
                        "{}: names the tool {w:?} in {text:?}",
                        role.id
                    );
                    assert!(
                        !VENDOR_WORDS.contains(&w.to_ascii_lowercase().as_str()),
                        "{}: names {w:?} in {text:?}",
                        role.id
                    );
                }
            }
        }
    }

    #[test]
    fn prompt_tokens_are_capabilities_the_role_holds() {
        for role in &registry().roles {
            let mut rest = role.prompt.as_str();
            while let Some(start) = rest.find('{') {
                let end = rest[start..].find('}').expect("an unclosed {");
                let cap = &rest[start + 1..start + end];
                assert!(
                    role.capabilities.iter().any(|c| c == cap),
                    "{}: token {{{cap}}} is not a capability of the role",
                    role.id
                );
                rest = &rest[start + end..];
            }
        }
    }

    #[test]
    fn the_adapter_covers_every_capability() {
        for cap in registry().capabilities.keys() {
            match ClaudeAdapter.capability(cap) {
                CapabilitySupport::Tools(t) => assert!(!t.is_empty(), "{cap}: no tools"),
                CapabilitySupport::Setting(key) => assert!(!key.is_empty(), "{cap}: no setting"),
                CapabilitySupport::Unsupported { fallback } => {
                    assert!(!fallback.is_empty(), "{cap}: no documented fallback")
                }
            }
        }
    }

    #[test]
    fn a_role_with_an_unmet_requirement_is_not_offered() {
        let off = Flags::current().with("changes-coverage", false);
        let on = Flags::current().with("changes-coverage", true);
        assert!(offered_roles(&off).all(|r| r.requires.is_empty()));
        assert!(offered_roles(&off).any(|r| r.id == "explorer"));
        assert!(offered_roles(&on).any(|r| r.id == "worker"));
    }

    /// Both built-in roles are offered by default (the user's decision, ADR item 5).
    #[test]
    fn both_roles_are_offered_by_default() {
        let ids: Vec<_> = offered_roles(&Flags::current())
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(ids, ["explorer", "worker"]);
    }

    #[test]
    fn the_name_is_derived_in_one_place() {
        assert_eq!(backend_name("explorer"), "writer-explorer");
        assert_eq!(role_label("writer-worker"), "worker");
        assert_eq!(role_label("Explore"), "Explore");
        assert_eq!(role_label(&"x\n".repeat(60)).chars().count(), 40);
    }

    #[test]
    fn delegation_names_the_cli_queries_only_with_the_cli() {
        let explorer = &registry().roles[0];
        assert!(delegation_sentence(explorer, true).contains("`writer` queries"));
        assert!(!delegation_sentence(explorer, false).contains("`writer`,"));
        assert_eq!(
            delegation_sentence(explorer, false),
            "Delegate mechanical work (exploring and searching the vault, reading many notes, summarising) to `writer-explorer`, a cheap read-only sub-agent that returns paths and short findings."
        );
    }
}
