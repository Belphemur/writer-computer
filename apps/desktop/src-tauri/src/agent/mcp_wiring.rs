//! Writer's own MCP server for a chat (ADR 2026-11-19): the `writer mcp` stdio server over the
//! chat's vault, handed to the `claude` CLI as `--mcp-config`, and the permission rules that let
//! its read-only tools run without a prompt. Tauri-free; the tools themselves come from the
//! command registry (`cli::mcp`), never from a list here.
//!
//! The config is one more server for the CLI to start: it is added next to whatever the user's
//! own settings define (the argv never carries `--strict-mcp-config`), and no config file of
//! the user is read or written.

use crate::cli::mcp;
use serde_json::json;
use std::path::Path;

/// The `--mcp-config` JSON of a chat and the `--allowedTools` rules of its read-only tools.
#[derive(Debug, Clone, PartialEq)]
pub struct McpWiring {
    pub config: String,
    pub allowed: Vec<String>,
}

/// `vault=<root>` as the CLI grammar reads it: `\` is an escape there, so a backslash in the
/// path is doubled (it only occurs in Windows paths).
fn vault_arg(root: &str) -> String {
    format!("vault={}", root.replace('\\', "\\\\"))
}

/// The wiring for the `writer` launcher (`cli_launcher`, the app binary under its CLI name) and
/// the vault root. `None` when either path is not plain text the CLI can be given.
pub fn wiring(launcher: &Path, root: &Path) -> Option<McpWiring> {
    let (command, root) = (launcher.to_str()?, root.to_str()?);
    if [command, root]
        .iter()
        .any(|v| v.is_empty() || v.contains('\0'))
    {
        return None;
    }
    let config = json!({
        "mcpServers": {
            mcp::SERVER_NAME: {
                "type": "stdio",
                "command": command,
                // `vault=` has to come first, then the command (the CLI's grammar)
                "args": [vault_arg(root), "mcp"],
            }
        }
    });
    Some(McpWiring {
        config: config.to_string(),
        allowed: mcp::read_tool_rules(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn the_config_runs_the_launcher_on_the_vault() {
        let w = wiring(Path::new("/data/bin/writer"), Path::new("/Users/me/Notes")).unwrap();
        let v: Value = serde_json::from_str(&w.config).unwrap();
        let server = &v["mcpServers"]["writer"];
        assert_eq!(server["type"], "stdio");
        assert_eq!(server["command"], "/data/bin/writer");
        assert_eq!(server["args"], json!(["vault=/Users/me/Notes", "mcp"]));
        // the only server named: the user's own are the CLI's to merge, never ours to replace
        assert_eq!(v["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn the_vault_argument_survives_the_cli_grammar() {
        use crate::cli::args::parse;
        for root in ["/a b/c=d", "C:\\Users\\n\\Notes", "/we\"ird"] {
            let w = wiring(Path::new("/bin/writer"), Path::new(root)).unwrap();
            let v: Value = serde_json::from_str(&w.config).unwrap();
            let args: Vec<String> = v["mcpServers"]["writer"]["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_string())
                .collect();
            let inv = parse(&args).unwrap();
            assert_eq!(inv.vault.as_deref(), Some(root), "{root}");
            assert_eq!(inv.command, "mcp");
        }
    }

    #[test]
    fn only_read_tools_are_allowed_without_a_prompt() {
        let w = wiring(Path::new("/bin/writer"), Path::new("/v")).unwrap();
        assert!(w.allowed.contains(&"mcp__writer__search".to_string()));
        assert!(w
            .allowed
            .contains(&"mcp__writer__graph_backlinks".to_string()));
        for write in ["create", "append", "delete", "property_set", "move"] {
            assert!(
                !w.allowed.contains(&format!("mcp__writer__{write}")),
                "{write} must ask"
            );
        }
        assert!(!w.allowed.iter().any(|r| r.ends_with("__mcp")));
    }

    #[test]
    fn unusable_paths_give_no_wiring() {
        assert!(wiring(Path::new(""), Path::new("/v")).is_none());
        assert!(wiring(Path::new("/w"), Path::new("")).is_none());
        assert!(wiring(Path::new("/w"), Path::new("/v\0x")).is_none());
    }
}
