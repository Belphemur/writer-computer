//! Writer's own MCP server for a chat (ADR 2026-11-19 "Hand Writer's MCP server to every agent
//! backend through its adapter"): what the server is, and the one seam a backend implements to
//! be handed it. Tauri-free; the tools come from the command registry (`cli::mcp`), never from a
//! list here, and nothing in this module is one backend's format.
//!
//! - [`WriterServer`]: the `writer` launcher on the chat's vault (`vault=<root> mcp`).
//! - [`ToolsAdapter`]: how a backend names the tools, takes the server and lets the read tools
//!   run without a prompt. One implementation per backend, next to its `RoleAdapter` (Claude:
//!   `claude_adapter::ClaudeAdapter`).
//!
//! The server is one more for the backend to start, added next to whatever the user's own
//! settings define; no config file of the user is read or written.

use super::tool_table::ToolTable;
use crate::cli::mcp::{self, ToolSpec};
use std::path::Path;

/// The server a chat is given: the launcher and its arguments, with no backend's config format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriterServer {
    pub command: String,
    pub args: Vec<String>,
}

/// `vault=<root>` as the CLI grammar reads it: `\` is an escape there, so a backslash in the
/// path is doubled (it only occurs in Windows paths).
fn vault_arg(root: &str) -> String {
    format!("vault={}", root.replace('\\', "\\\\"))
}

impl WriterServer {
    /// The server for the `writer` launcher (`cli_launcher`, the app binary under its CLI name)
    /// and the vault root. `None` when either path is not plain text the CLI can be given.
    pub fn new(launcher: &Path, root: &Path) -> Option<Self> {
        let (command, root) = (launcher.to_str()?, root.to_str()?);
        if [command, root]
            .iter()
            .any(|v| v.is_empty() || v.contains('\0'))
        {
            return None;
        }
        Some(WriterServer {
            command: command.to_string(),
            // `vault=` has to come first, then the command (the CLI's grammar)
            args: vec![vault_arg(root), "mcp".to_string()],
        })
    }
}

/// How a backend is handed the server: what it adds to the process it spawns. Only `Argv` is
/// implemented (Claude); a backend that needs the others adds its consumer with its adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// Extra command-line arguments (Claude: `--mcp-config <json>`).
    Argv(Vec<String>),
    /// Extra environment variables for the process.
    Env(Vec<(String, String)>),
    /// A fragment for the backend's own config, merged by the spawner.
    Config(String),
}

/// One backend's translation of Writer's server. Pure: no IO, no Tauri. Small on purpose: a
/// backend implements only what it uses (the roles are `RoleAdapter`).
pub trait ToolsAdapter: std::fmt::Debug {
    /// The backend's own tools (shell, edits, sub-agent launch): the shared table of
    /// `shared/agent-tools/<backend>.json`, the one place shared code learns a tool name from.
    fn tool_table(&self) -> &'static ToolTable;
    /// How the backend names a tool of the server to the model (Claude: `mcp__<server>__<tool>`).
    fn tool_name(&self, tool: &ToolSpec) -> String;
    /// How the backend is handed the server.
    fn launch(&self, server: &WriterServer) -> Launch;
    /// How the read tools skip the permission prompt, from the registry's tools (Claude:
    /// `--allowedTools` entries). The write tools are never in it, so each call asks.
    fn read_rules(&self, tools: &[ToolSpec]) -> Vec<String>;
}

/// A chat's server as one backend takes it: the launch and the rules of its read tools.
#[derive(Debug, Clone, PartialEq)]
pub struct McpWiring {
    pub launch: Launch,
    pub allowed: Vec<String>,
}

/// The wiring of the `writer` launcher on the vault root for `adapter`'s backend. `None` when
/// either path is not plain text the CLI can be given.
pub fn wiring(adapter: &dyn ToolsAdapter, launcher: &Path, root: &Path) -> Option<McpWiring> {
    let server = WriterServer::new(launcher, root)?;
    Some(McpWiring {
        launch: adapter.launch(&server),
        allowed: adapter.read_rules(&mcp::tools()),
    })
}

/// A second backend, for tests only: another naming (`writer.<tool>`), its server handed over in
/// the environment. It proves the seam: nothing but this implementation knows its formats.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct FakeAdapter;

#[cfg(test)]
impl ToolsAdapter for FakeAdapter {
    fn tool_table(&self) -> &'static ToolTable {
        crate::agent::backend::claude().tools()
    }

    fn tool_name(&self, tool: &ToolSpec) -> String {
        format!("{}.{}", mcp::SERVER_NAME, tool.name)
    }

    fn launch(&self, server: &WriterServer) -> Launch {
        Launch::Env(vec![("WRITER_MCP".into(), server.args.join(" "))])
    }

    fn read_rules(&self, tools: &[ToolSpec]) -> Vec<String> {
        tools
            .iter()
            .filter(|t| !t.writes)
            .map(|t| self.tool_name(t))
            .collect()
    }
}

#[cfg(test)]
impl crate::agent::roles::RoleAdapter for FakeAdapter {
    fn capability(&self, capability: &str) -> crate::agent::roles::CapabilitySupport {
        use crate::agent::roles::{leak_read_tools, CapabilitySupport};
        match capability {
            "writer-cli-read" => CapabilitySupport::Tools(leak_read_tools(self)),
            other => crate::agent::claude_adapter::ClaudeAdapter.capability(other),
        }
    }

    fn render(&self, _: &crate::agent::roles::RenderInput<'_>) -> crate::agent::roles::Rendered {
        crate::agent::roles::Rendered::none()
    }

    fn restart_on_config_change(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::roles::RoleAdapter;
    use std::path::PathBuf;

    /// The Rust files that are not tests, with the text before their test module.
    fn production_sources(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !["target", "tests", "node_modules"].contains(&name.as_str()) {
                    production_sources(&path, out);
                }
            } else if name.ends_with(".rs") && !name.contains("test") {
                let text = std::fs::read_to_string(&path).unwrap();
                let code = text.split("#[cfg(test)]").next().unwrap().to_string();
                out.push((path, code));
            }
        }
    }

    /// ADR 2026-11-19: a backend's tool name is written once, by its adapter. Any other file
    /// (outside tests) that spells Claude's prefix has copied knowledge that belongs there.
    #[test]
    fn no_claude_tool_prefix_outside_the_claude_adapter() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut sources = Vec::new();
        production_sources(&manifest.join("src"), &mut sources);
        production_sources(&manifest.join("../features"), &mut sources);
        assert!(sources.len() > 50, "the scan found {} files", sources.len());
        let literal = ["mcp__", "writer__"].concat();
        let offenders: Vec<_> = sources
            .iter()
            .filter(|(path, code)| {
                !path.ends_with("agent/claude_adapter.rs") && code.contains(&literal)
            })
            .map(|(path, _)| path.display().to_string())
            .collect();
        assert!(offenders.is_empty(), "{offenders:?}");
    }

    #[test]
    fn a_wiring_is_what_its_adapter_makes_of_the_server() {
        let w = wiring(&FakeAdapter, Path::new("/bin/writer"), Path::new("/v")).unwrap();
        assert_eq!(
            w.launch,
            Launch::Env(vec![("WRITER_MCP".into(), "vault=/v mcp".into())])
        );
        assert!(w.allowed.contains(&"writer.search".to_string()));
        assert!(!w.allowed.contains(&"writer.create".to_string()));
        assert!(FakeAdapter.capability("read") != FakeAdapter.capability("edit"));
    }

    #[test]
    fn the_server_runs_the_launcher_on_the_vault() {
        let s =
            WriterServer::new(Path::new("/data/bin/writer"), Path::new("/Users/me/Notes")).unwrap();
        assert_eq!(s.command, "/data/bin/writer");
        assert_eq!(s.args, ["vault=/Users/me/Notes", "mcp"]);
    }

    #[test]
    fn the_vault_argument_survives_the_cli_grammar() {
        use crate::cli::args::parse;
        for root in ["/a b/c=d", "C:\\Users\\n\\Notes", "/we\"ird"] {
            let s = WriterServer::new(Path::new("/bin/writer"), Path::new(root)).unwrap();
            let inv = parse(&s.args).unwrap();
            assert_eq!(inv.vault.as_deref(), Some(root), "{root}");
            assert_eq!(inv.command, "mcp");
        }
    }

    #[test]
    fn unusable_paths_give_no_server() {
        assert!(WriterServer::new(Path::new(""), Path::new("/v")).is_none());
        assert!(WriterServer::new(Path::new("/w"), Path::new("")).is_none());
        assert!(WriterServer::new(Path::new("/w"), Path::new("/v\0x")).is_none());
    }
}
