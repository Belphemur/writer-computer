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

/// The adapter for the `claude` CLI.
pub struct ClaudeAdapter;

impl RoleAdapter for ClaudeAdapter {
    fn capability(&self, capability: &str) -> CapabilitySupport {
        match capability {
            "read" => CapabilitySupport::Tools(&["Read"]),
            "search" => CapabilitySupport::Tools(&["Glob", "Grep"]),
            // The tool list cannot narrow Bash to `writer` reads; the role prompt and the
            // default allow rules (`Bash(writer search *)` ...) do.
            "writer-cli-read" => CapabilitySupport::Tools(&["Bash"]),
            "edit" => CapabilitySupport::Tools(&["Edit", "MultiEdit"]),
            "write" => CapabilitySupport::Tools(&["Write"]),
            "bash-limited" => CapabilitySupport::Tools(&["Bash"]),
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
            let setting = input.tier_models.get(&role.tier).and_then(|m| m.as_deref());
            if let Some(model) = tier_model(&role.tier, setting) {
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

    /// `explorer` as the CLI got it before the roles registry existed (`agents_json(None, false)`
    /// and `(None, true)`, captured 2026-11-17): the registry must reproduce it byte for byte.
    const EXPLORER_PLAIN: &str = r#"{"writer-explorer":{"description":"Cheap read-only helper: finds, reads and summarises notes and runs read-only queries. Give it a self-contained question; it returns file paths and short findings.","model":"haiku","prompt":"You explore a vault of Markdown notes for another agent. Find and read files, summarise them, and report vault-relative paths with short findings (a few lines per file, no full note text). Never edit, create, move or delete anything, and never run a command that writes. Find files with Glob and Grep.","tools":["Read","Glob","Grep"]}}"#;
    const EXPLORER_CLI: &str = r#"{"writer-explorer":{"description":"Cheap read-only helper: finds, reads and summarises notes and runs read-only queries. Give it a self-contained question; it returns file paths and short findings.","model":"haiku","prompt":"You explore a vault of Markdown notes for another agent. Find and read files, summarise them, and report vault-relative paths with short findings (a few lines per file, no full note text). Never edit, create, move or delete anything, and never run a command that writes. Find files with Glob and Grep. You may also run read-only `writer` commands (search, backlinks, links, properties, bases, base:query); no other command.","tools":["Read","Glob","Grep","Bash"]}}"#;

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

    #[test]
    fn explorer_output_is_byte_identical_to_before_the_registry() {
        let flags = Flags::current().with("changes-coverage", false);
        let none = BTreeMap::new();
        assert_eq!(render(false, &none, &flags).config.unwrap(), EXPLORER_PLAIN);
        assert_eq!(render(true, &none, &flags).config.unwrap(), EXPLORER_CLI);
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
        assert_eq!(e["tools"], json!(["Read", "Glob", "Grep"]));
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
        assert_eq!(
            w["tools"],
            json!(["Read", "Glob", "Grep", "Bash", "Edit", "MultiEdit", "Write"])
        );
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
    fn every_tier_has_a_setting_with_a_default() {
        for tier in &registry().tiers {
            assert!(
                tier_defaults().contains_key(tier),
                "no {} setting",
                tier_setting_key(tier)
            );
        }
    }

    /// The commands the prompt allows are the read-only ones of the default allow rules.
    #[test]
    fn prompt_commands_are_default_allowed_read_commands() {
        let rules = crate::config::settings_schema()
            .into_iter()
            .find(|d| d.key == "agent.allowed-tools")
            .unwrap();
        let crate::config::ConfigValue::List(rules) = rules.default else {
            panic!("a list")
        };
        let prompt = &registry().roles[0].prompt_by_capability["writer-cli-read"];
        for name in [
            "search",
            "backlinks",
            "links",
            "properties",
            "bases",
            "base:query",
        ] {
            assert!(
                rules
                    .iter()
                    .any(|r| r.starts_with(&format!("Bash(writer {name}"))),
                "{name} is not allowed by default"
            );
            assert!(prompt.contains(name));
        }
    }
}
