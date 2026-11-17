//! The cheap sub-agents of an orchestrating chat (spec `SPECs/native-agent-spec.md`,
//! "Orchestration and sub-agents"): the JSON for the CLI's `--agents` flag. Tauri-free, one
//! function. The sub-agents run inside the chat's CLI process, so every tool call they make goes
//! through the same permission prompt and allow rules as the main agent's.

use super::title::cheapest_model;
use serde_json::{json, Value};

/// The sub-agent that explores, reads and summarises; the name the Writer block uses.
pub const EXPLORER: &str = "writer-explorer";

const EXPLORER_DESCRIPTION: &str = "Cheap read-only helper: finds, reads and summarises notes and runs read-only queries. Give it a self-contained question; it returns file paths and short findings.";
const EXPLORER_PROMPT: &str = "You explore a vault of Markdown notes for another agent. Find and read files, summarise them, and report vault-relative paths with short findings (a few lines per file, no full note text). Never edit, create, move or delete anything, and never run a command that writes. Find files with Glob and Grep.";
const EXPLORER_PROMPT_CLI: &str = " You may also run read-only `writer` commands (search, backlinks, links, properties, bases, base:query); no other command.";

/// The value of `--agents`. `model` is `agent.subagent-model` (blank or unsafe: the cheapest
/// alias); `writer_cli` adds Bash, for the read-only `writer` commands, only when the managed
/// skills are installed for the spawned CLI.
pub fn agents_json(model: Option<&str>, writer_cli: bool) -> String {
    let mut tools = vec!["Read", "Glob", "Grep"];
    let mut prompt = EXPLORER_PROMPT.to_string();
    if writer_cli {
        tools.push("Bash");
        prompt.push_str(EXPLORER_PROMPT_CLI);
    }
    let agents: Value = json!({
        EXPLORER: {
            "description": EXPLORER_DESCRIPTION,
            "prompt": prompt,
            "tools": tools,
            "model": cheapest_model(model),
        }
    });
    agents.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_is_read_only_and_cheap() {
        let v: Value = serde_json::from_str(&agents_json(None, false)).unwrap();
        let e = &v[EXPLORER];
        assert_eq!(e["model"], "haiku");
        assert_eq!(e["tools"], json!(["Read", "Glob", "Grep"]));
        for t in e["tools"].as_array().unwrap() {
            assert!(!["Edit", "Write", "NotebookEdit"].contains(&t.as_str().unwrap()));
        }
        assert!(!e["prompt"].as_str().unwrap().contains("`writer`"));
    }

    #[test]
    fn bash_only_with_the_cli_and_model_from_the_setting() {
        let v: Value = serde_json::from_str(&agents_json(Some(" sonnet "), true)).unwrap();
        assert_eq!(v[EXPLORER]["model"], "sonnet");
        assert_eq!(
            v[EXPLORER]["tools"],
            json!(["Read", "Glob", "Grep", "Bash"])
        );
        assert!(v[EXPLORER]["prompt"].as_str().unwrap().contains("`writer`"));
        let bad: Value = serde_json::from_str(&agents_json(Some("--x"), true)).unwrap();
        assert_eq!(bad[EXPLORER]["model"], "haiku");
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
            assert!(EXPLORER_PROMPT_CLI.contains(name));
        }
    }
}
