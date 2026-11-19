//! The Claude adapter of the agent roles (ADR "Define agent roles once and map them to each agent
//! backend through adapters"; spec `SPECs/agent-roles-spec.md`, "Backend adapters"): the registry
//! `shared/agent-roles.json` to the value of the CLI's `--agents` flag. Tauri-free, pure.
//!
//! The sub-agents run inside the chat's CLI process, so every tool call they make goes through the
//! same permission prompt and allow rules as the main agent's: a role narrows the tool list, it
//! never widens what the user's permission mode allows. Claude's tool list cannot restrict `Bash`
//! to `writer` subcommands, so `writer-cli-read` is "read-only by the role prompt plus the
//! `agent.allowed-tools` rules" (the table below says so).
//!
//! Tier to model: the user's `agent.claude.model-<tier>` settings. A blank, `auto` or unsafe value
//! is the tier's schema default (never a different vendor's model); `default` means "no `model`
//! key": the sub-agent uses the chat's own model.

use super::claude_stream::is_safe_value;
use super::roles::{
    backend_name, delegation_sentence, offered_roles, role_prompt, role_tools, CapabilitySupport,
    RenderInput, Rendered, RenderedRole, RoleAdapter,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

/// What the tier setting says to inherit: no `model` key, the chat's own model.
const INHERIT: &str = "default";

/// The settings key of a tier's model.
pub fn tier_setting_key(tier: &str) -> String {
    format!("agent.claude.model-{tier}")
}

/// The schema default of each tier's setting (`features/agent/settings.schema.json`: the one place
/// that names a default model).
fn tier_defaults() -> &'static HashMap<String, String> {
    static DEFAULTS: OnceLock<HashMap<String, String>> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        crate::config::settings_schema()
            .into_iter()
            .filter_map(|d| {
                let tier = d.key.strip_prefix("agent.claude.model-")?.to_string();
                Some((tier, d.default.as_str()?.to_string()))
            })
            .collect()
    })
}

/// The `--model` value of a tier, `None` to inherit the chat's model. `setting` is what the user
/// stored (`None` or blank: the tier's default).
pub fn tier_model(tier: &str, setting: Option<&str>) -> Option<String> {
    let usable = |m: &str| !m.is_empty() && !m.eq_ignore_ascii_case("auto") && is_safe_value(m);
    let chosen = setting
        .map(str::trim)
        .filter(|m| usable(m))
        .map(str::to_string)
        .or_else(|| tier_defaults().get(tier).cloned())?;
    (!chosen.eq_ignore_ascii_case(INHERIT)).then_some(chosen)
}

/// The `model` of a role's `--agents` entry (`None`: inherit the chat's), from its tier setting.
fn role_model(
    role: &super::roles::Role,
    tier_models: &std::collections::BTreeMap<String, Option<String>>,
) -> Option<String> {
    let setting = tier_models.get(&role.tier).and_then(|m| m.as_deref());
    tier_model(&role.tier, setting)
}

/// The tools that launch a sub-agent (`Task` in older CLIs, `Agent` now) and the input key that
/// names the sub-agent type.
const LAUNCH_TOOLS: [&str; 2] = ["Agent", "Task"];
const SUBAGENT_TYPE_KEY: &str = "subagent_type";

/// Whether `tool` launches a sub-agent.
pub fn is_launch_tool(tool: &str) -> bool {
    LAUNCH_TOOLS.contains(&tool)
}

/// The role label of a launch call's input (`writer-worker` -> `worker`), if it names a type.
pub fn launch_label(input: &Value) -> Option<String> {
    let name = input.get(SUBAGENT_TYPE_KEY)?.as_str()?;
    Some(super::roles::role_label(name))
}

/// Who a launch call starts and the model it runs (the `subagent-started` event).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchInfo {
    /// The registry role id; `None` for a sub-agent type Writer does not define.
    pub role: Option<String>,
    /// The type as the call named it.
    pub name: String,
    pub model: Option<String>,
}

/// The launch call's role and model, resolved the way [`ClaudeAdapter::render`] resolved them
/// when the process started: the role's tier through `tier_models`; a tier that inherits gets
/// `inherited` (the chat's model). A type that is not a Writer role keeps `model: None` (its own
/// definition decides, and Writer does not know it). `None` when the input names no type.
pub fn resolve_launch(
    input: &Value,
    tier_models: &std::collections::BTreeMap<String, Option<String>>,
    inherited: Option<&str>,
) -> Option<LaunchInfo> {
    let name = input.get(SUBAGENT_TYPE_KEY)?.as_str()?.to_string();
    let role = super::roles::registry()
        .roles
        .iter()
        .find(|r| backend_name(&r.id) == name);
    let model =
        role.and_then(|r| role_model(r, tier_models).or_else(|| inherited.map(String::from)));
    Some(LaunchInfo {
        role: role.map(|r| r.id.clone()),
        name,
        model,
    })
}

/// The `mcp__writer__*` names of every command the registry marks as a read (the rules that let
/// the main agent call them without a prompt, `mcp::read_tool_rules`): never a hand-kept list.
/// Made once; the registry is static, so the names live as long as the process.
fn writer_read_tools() -> &'static [&'static str] {
    static TOOLS: OnceLock<Vec<&'static str>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        crate::cli::mcp::read_tool_rules()
            .into_iter()
            .map(|n| &*Box::leak(n.into_boxed_str()))
            .collect()
    })
}

/// Where a role's `promptByCapability` text asks for the search line (the one wording of the
/// main prompt, `writer_prompt::search_line`).
const SEARCH_LINE_TOKEN: &str = "{search-line}";

/// The adapter for the `claude` CLI.
pub struct ClaudeAdapter;

impl RoleAdapter for ClaudeAdapter {
    /// The CLI reads all of them once, at start.
    fn restart_on_config_change(&self) -> bool {
        true
    }

    fn capability(&self, capability: &str) -> CapabilitySupport {
        match capability {
            "read" => CapabilitySupport::Tools(&["Read"]),
            // The installed CLI has no Glob or Grep: searching is Writer's own MCP server
            // (`cli::mcp`, ADR 2026-11-19), every tool of the registry that reads.
            "writer-cli-read" => CapabilitySupport::Tools(writer_read_tools()),
            "edit" => CapabilitySupport::Tools(&["Edit", "MultiEdit"]),
            "write" => CapabilitySupport::Tools(&["Write"]),
            "bash-limited" => CapabilitySupport::Tools(&["Bash"]),
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
                json!(role_prompt(self, role, input.writer_cli)
                    .replace(SEARCH_LINE_TOKEN, &super::writer_prompt::search_line())),
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
            launch: "Agent/Task calls",
            roles,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::roles::{registry, Flags};
    use std::collections::BTreeMap;

    fn models(pairs: &[(&str, &str)]) -> BTreeMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(t, m)| (t.to_string(), Some(m.to_string())))
            .collect()
    }

    fn render(
        writer_cli: bool,
        tiers: &BTreeMap<String, Option<String>>,
        flags: &Flags,
    ) -> Rendered {
        ClaudeAdapter.render(&RenderInput {
            writer_cli,
            tier_models: tiers,
            flags,
        })
    }

    fn agents(r: &Rendered) -> Value {
        serde_json::from_str(r.config.as_deref().expect("a config")).unwrap()
    }

    /// The tools the registry marks as reads, qualified as the model calls them.
    fn registry_read_tools() -> Vec<String> {
        crate::cli::registry::commands()
            .filter(|c| crate::cli::mcp::is_tool(c) && !c.writes)
            .map(crate::cli::mcp::qualified_name)
            .collect()
    }

    fn tool_list(role: &Value) -> Vec<String> {
        role["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn explorer_tools_are_read_and_exactly_the_registry_read_tools() {
        let flags = Flags::current().with("changes-coverage", false);
        let v = agents(&render(true, &BTreeMap::new(), &flags));
        let tools = tool_list(&v["writer-explorer"]);
        let mut expected = vec!["Read".to_string()];
        expected.extend(registry_read_tools());
        assert_eq!(tools, expected);
        assert!(tools.contains(&"mcp__writer__search".to_string()));
        for gone in ["Glob", "Grep", "Bash", "Edit", "MultiEdit", "Write"] {
            assert!(!tools.iter().any(|t| t == gone), "{gone}");
        }
        // no write tool of the registry either
        for c in crate::cli::registry::commands().filter(|c| c.writes) {
            assert!(
                !tools.contains(&crate::cli::mcp::qualified_name(c)),
                "{}",
                c.name
            );
        }
    }

    #[test]
    fn without_the_writer_tools_the_explorer_only_reads() {
        let flags = Flags::current().with("changes-coverage", false);
        let v = agents(&render(false, &BTreeMap::new(), &flags));
        assert_eq!(v["writer-explorer"]["tools"], json!(["Read"]));
    }

    #[test]
    fn the_explorer_prompt_carries_the_search_line_and_names_only_existing_tools() {
        let flags = Flags::current().with("changes-coverage", true);
        let v = agents(&render(true, &BTreeMap::new(), &flags));
        let granted = tool_list(&v["writer-explorer"]);
        for role in ["writer-explorer", "writer-worker"] {
            let prompt = v[role]["prompt"].as_str().unwrap();
            assert!(
                prompt.contains(&crate::agent::writer_prompt::search_line()),
                "{role}"
            );
            assert!(!prompt.contains("{search-line}"), "{role}");
            assert!(
                !prompt.contains("Glob") && !prompt.contains("Grep"),
                "{role}"
            );
        }
        // every `mcp__writer__x` and the bare tool names the line gives exist and are granted
        let prompt = v["writer-explorer"]["prompt"].as_str().unwrap();
        let line = crate::agent::writer_prompt::search_line();
        let first = format!("{}search", crate::cli::mcp::TOOL_PREFIX);
        assert!(line.contains(&first) && granted.contains(&first));
        for word in line.split('`').skip(1).step_by(2) {
            let name = word
                .strip_prefix(crate::cli::mcp::TOOL_PREFIX)
                .unwrap_or(word);
            if name == "writer" {
                continue;
            }
            let qualified = format!("{}{name}", crate::cli::mcp::TOOL_PREFIX);
            assert!(granted.contains(&qualified), "{qualified} is not granted");
        }
        assert!(prompt.starts_with("You explore a vault of Markdown notes"));
    }

    #[test]
    fn worker_is_absent_while_its_requirement_is_unmet() {
        let off = Flags::current().with("changes-coverage", false);
        let r = render(true, &BTreeMap::new(), &off);
        assert_eq!(
            r.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["writer-explorer"]
        );
        assert!(agents(&r).get("writer-worker").is_none());
    }

    #[test]
    fn explorer_is_read_only_and_cheap() {
        let flags = Flags::current().with("changes-coverage", true);
        let v = agents(&render(false, &BTreeMap::new(), &flags));
        let e = &v["writer-explorer"];
        assert_eq!(e["model"], "haiku");
        assert_eq!(e["tools"], json!(["Read"]));
        assert!(!e["prompt"].as_str().unwrap().contains("`writer`"));
        // whatever the capability table holds, no read-only role gets a writing tool
        for t in e["tools"].as_array().unwrap() {
            assert!(!["Edit", "MultiEdit", "Write", "NotebookEdit"].contains(&t.as_str().unwrap()));
        }
    }

    #[test]
    fn worker_edits_on_the_standard_tier_with_the_spec_prompt() {
        let flags = Flags::current().with("changes-coverage", true);
        let r = render(true, &BTreeMap::new(), &flags);
        let w = &agents(&r)["writer-worker"];
        assert_eq!(w["model"], "sonnet");
        let tools = tool_list(w);
        assert_eq!(tools.first().map(String::as_str), Some("Read"));
        assert_eq!(&tools[tools.len() - 3..], ["Edit", "MultiEdit", "Write"]);
        assert!(tools.contains(&"mcp__writer__search".to_string()));
        assert!(!tools
            .iter()
            .any(|t| ["Glob", "Grep", "Bash"].contains(&t.as_str())));
        let prompt = w["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("You make a bounded set of edits to Markdown notes"));
        assert!(prompt.contains("never rename or move files"));
        assert_eq!(
            r.roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["explorer", "worker"]
        );
    }

    #[test]
    fn tiers_take_the_model_of_their_setting() {
        let flags = Flags::current().with("changes-coverage", true);
        let tiers = models(&[("cheap", " claude-haiku-4-5 "), ("standard", "opus")]);
        let v = agents(&render(false, &tiers, &flags));
        assert_eq!(v["writer-explorer"]["model"], "claude-haiku-4-5");
        assert_eq!(v["writer-worker"]["model"], "opus");
    }

    #[test]
    fn a_blank_auto_or_unsafe_value_is_the_tier_default() {
        assert_eq!(tier_model("cheap", None).as_deref(), Some("haiku"));
        assert_eq!(tier_model("cheap", Some("  ")).as_deref(), Some("haiku"));
        assert_eq!(
            tier_model("cheap", Some(" Auto ")).as_deref(),
            Some("haiku")
        );
        assert_eq!(tier_model("cheap", Some("--x")).as_deref(), Some("haiku"));
        assert_eq!(
            tier_model("standard", Some("--x")).as_deref(),
            Some("sonnet")
        );
        assert_eq!(
            tier_model("cheap", Some("claude-haiku-4-5")).as_deref(),
            Some("claude-haiku-4-5")
        );
    }

    #[test]
    fn strong_and_default_inherit_the_chat_model() {
        // `strong` defaults to "default": no `model` key
        assert_eq!(tier_model("strong", None), None);
        assert_eq!(tier_model("strong", Some("opus")).as_deref(), Some("opus"));
        // any tier set to "default" omits the key
        let flags = Flags::current().with("changes-coverage", false);
        let v = agents(&render(false, &models(&[("cheap", "default")]), &flags));
        assert!(v["writer-explorer"].get("model").is_none());
    }

    #[test]
    fn launch_calls_are_labelled_by_their_sub_agent_type() {
        assert!(is_launch_tool("Agent") && is_launch_tool("Task") && !is_launch_tool("Read"));
        assert_eq!(
            launch_label(&json!({"subagent_type": "writer-worker"})).as_deref(),
            Some("worker")
        );
        assert_eq!(launch_label(&json!({"description": "x"})), None);
    }

    #[test]
    fn a_launch_resolves_its_role_and_the_model_of_its_tier() {
        let input = json!({"subagent_type": "writer-explorer"});
        let tiers = models(&[("cheap", " claude-haiku-4-5 ")]);
        let got = resolve_launch(&input, &tiers, Some("chat-model")).unwrap();
        assert_eq!(got.role.as_deref(), Some("explorer"));
        assert_eq!(got.name, "writer-explorer");
        assert_eq!(got.model.as_deref(), Some("claude-haiku-4-5"));
        // the schema default when nothing is set: the same value `render` puts in `--agents`
        let got = resolve_launch(&input, &BTreeMap::new(), None).unwrap();
        assert_eq!(got.model, tier_model("cheap", None));
        // the model in the event is the model in the config
        let flags = Flags::current().with("changes-coverage", true);
        let rendered = agents(&render(false, &tiers, &flags));
        assert_eq!(
            Some(rendered["writer-explorer"]["model"].as_str().unwrap()),
            resolve_launch(&input, &tiers, None)
                .unwrap()
                .model
                .as_deref()
        );
    }

    #[test]
    fn an_inheriting_tier_shows_the_chat_model_and_a_foreign_type_has_none() {
        let inherit = json!({"subagent_type": "writer-worker"});
        let tiers = models(&[("standard", "default")]);
        assert_eq!(
            resolve_launch(&inherit, &tiers, Some("chat-model"))
                .unwrap()
                .model
                .as_deref(),
            Some("chat-model")
        );
        let mine =
            resolve_launch(&json!({"subagent_type": "my-agent"}), &tiers, Some("x")).unwrap();
        assert_eq!((mine.role, mine.model), (None, None));
        assert_eq!(
            resolve_launch(&json!({"description": "x"}), &tiers, None),
            None
        );
    }

    #[test]
    fn every_tier_has_a_setting_with_a_default() {
        for tier in &registry().tiers {
            assert!(
                tier_defaults().contains_key(tier),
                "no {} setting",
                tier_setting_key(tier)
            );
        }
    }
}
