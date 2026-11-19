//! Seams between the process runner (lane 1) and the code other lanes own. The runner never
//! imports `project*.rs` or `chat_store.rs`; it calls these traits through [`AgentPorts`], which
//! starts with working defaults so the runner is usable on its own.
//!
//! - Lane 3 (projects) implements [`ProjectPort`] and installs it once at startup with
//!   `AgentPorts::set_project(Arc::new(...))` (a one-line change in `lib.rs` setup).
//! - Lane 4 (chat store) implements [`ChatPort`] and installs it with `AgentPorts::set_chats`.
//!
//! Every method is synchronous and may block on disk: the runner calls them from blocking
//! threads only, never from the async pool and never while holding a session lock. Nothing here
//! may log note contents (spec section 8).

use super::events::AgentPermissionMode;
use super::mcp_wiring::ToolsAdapter;
use super::roles::Rendered;
use super::writer_prompt::MemoryNote;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `agent.inject-agents-md` (spec 4.5). A missing or unknown value is `Auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InjectAgentsMd {
    #[default]
    Auto,
    Always,
    Never,
}

impl InjectAgentsMd {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim) {
            Some("always") => Self::Always,
            Some("never") => Self::Never,
            _ => Self::Auto,
        }
    }
}

/// What the instruction layering needs at spawn time.
#[derive(Debug, Clone)]
pub struct SpawnContext<'a> {
    /// Canonical vault root.
    pub root: &'a Path,
    /// The CLI's working directory, already resolved by [`ProjectPort::resolve_cwd`].
    pub cwd: &'a Path,
    /// Vault-relative project folder, `None` for a vault-root chat.
    pub project_path: Option<&'a str>,
    /// Installed CLI version (`2.1.325`), `None` when the probe failed. Older than 2.1.325
    /// means "inject as if `always`" (spec 4.5, 7).
    pub cli_version: Option<&'a str>,
    pub inject_agents_md: InjectAgentsMd,
    /// `StartSessionRequest.append_system_prompt` as the UI sent it.
    pub requested_prompt: Option<&'a str>,
    /// The managed `writer` skills are installed for the spawned CLI (selects the Writer block's
    /// variant and whether sub-agents get Bash).
    pub writer_cli: bool,
    /// The sub-agent roles the backend adapter produced for this session (`None`: orchestration is
    /// off); the Writer block's orchestration line is rendered from them.
    pub orchestration: Option<&'a Rendered>,
    /// Where this chat's memory is (`agent.memory` = `vault`); the Writer block's memory line.
    pub memory: Option<MemoryNote<'a>>,
    /// The chat's backend: how the Writer block names Writer's tools.
    pub tools: &'a dyn ToolsAdapter,
}

/// Facts about a chat's CLI session, reported to the chat store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSessionInfo {
    pub chat_id: String,
    pub session_id: String,
    pub cli_version: Option<String>,
    pub model: Option<String>,
    pub project_path: Option<String>,
}

/// Lane 3. Project context and working directory.
pub trait ProjectPort: Send + Sync {
    /// The CLI's cwd: the project folder, or the vault root for `None`. MUST be canonical,
    /// existing, a directory and inside `root` (symlink escapes refused).
    fn resolve_cwd(&self, root: &Path, project_path: Option<&str>) -> Result<PathBuf, String>;

    /// The text for `--append-system-prompt` (shadowed `AGENTS.md` text, project header, source
    /// manifest). `Ok(None)` appends nothing. The value is never logged by the runner.
    fn append_system_prompt(&self, ctx: &SpawnContext<'_>) -> Result<Option<String>, String>;

    /// `writer-agent-mode` of the project's `project.md`, when set and valid. The runner applies
    /// it only when the UI asked for the default `manual` mode.
    fn project_permission_mode(
        &self,
        _root: &Path,
        _project_path: Option<&str>,
    ) -> Option<AgentPermissionMode> {
        None
    }

    /// A chat started in the project: bump `copilot-project-last-used`. Failures are the
    /// implementation's to log; the runner ignores them.
    fn touch_last_used(&self, _root: &Path, _project_path: &str) {}
}

/// Lane 4. Hooks the runner calls so the chat note stays in step with the CLI session.
pub trait ChatPort: Send + Sync {
    /// `system/init` arrived (repeats every turn; implementations must be idempotent).
    fn session_started(&self, _root: &Path, _info: &ChatSessionInfo) {}

    /// `--resume` found no conversation, so the runner started a NEW CLI session for the same
    /// chat. Persist `writer-chat-session-id = new_session_id` and keep `writer-chat-id`.
    fn session_replaced(
        &self,
        _root: &Path,
        _chat_id: &str,
        _old_session_id: &str,
        _new_session_id: &str,
    ) {
    }

    /// Text to put in front of the first user message of a replaced session: a capped replay of
    /// the note's last turns (spec 9, "Resumed from notes"). `None` seeds nothing.
    fn replay_seed(&self, _root: &Path, _chat_id: &str) -> Option<String> {
        None
    }
}

/// Default [`ProjectPort`]: confine the project folder inside the vault, append only what the UI
/// sent. Lane 3 replaces it.
#[derive(Debug, Default)]
pub struct DefaultProject;

impl ProjectPort for DefaultProject {
    fn resolve_cwd(&self, root: &Path, project_path: Option<&str>) -> Result<PathBuf, String> {
        let root = root
            .canonicalize()
            .map_err(|e| format!("vault root: {e}"))?;
        let Some(rel) = project_path.filter(|p| !p.is_empty()) else {
            return Ok(root);
        };
        let rel_path = Path::new(rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("project path must be inside the vault".into());
        }
        let cwd = root
            .join(rel_path)
            .canonicalize()
            .map_err(|e| format!("project folder: {e}"))?;
        if !cwd.starts_with(&root) || !cwd.is_dir() {
            return Err("project path must be a folder inside the vault".into());
        }
        Ok(cwd)
    }

    fn append_system_prompt(&self, ctx: &SpawnContext<'_>) -> Result<Option<String>, String> {
        Ok(ctx.requested_prompt.map(str::to_string))
    }
}

/// Default [`ChatPort`]: nothing to persist.
#[derive(Debug, Default)]
pub struct NoChats;

impl ChatPort for NoChats {}

/// The installed ports. Managed by `AgentSessions`; cheap to clone the `Arc`s out of.
pub struct AgentPorts {
    project: RwLock<Arc<dyn ProjectPort>>,
    chats: RwLock<Arc<dyn ChatPort>>,
}

impl Default for AgentPorts {
    fn default() -> Self {
        Self {
            project: RwLock::new(Arc::new(DefaultProject)),
            chats: RwLock::new(Arc::new(NoChats)),
        }
    }
}

impl AgentPorts {
    pub fn project(&self) -> Arc<dyn ProjectPort> {
        Arc::clone(&self.project.read())
    }

    pub fn chats(&self) -> Arc<dyn ChatPort> {
        Arc::clone(&self.chats.read())
    }

    pub fn set_project(&self, port: Arc<dyn ProjectPort>) {
        *self.project.write() = port;
    }

    pub fn set_chats(&self, port: Arc<dyn ChatPort>) {
        *self.chats.write() = port;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_setting_defaults_to_auto() {
        assert_eq!(InjectAgentsMd::parse(None), InjectAgentsMd::Auto);
        assert_eq!(InjectAgentsMd::parse(Some("bogus")), InjectAgentsMd::Auto);
        assert_eq!(
            InjectAgentsMd::parse(Some("always")),
            InjectAgentsMd::Always
        );
        assert_eq!(
            InjectAgentsMd::parse(Some(" never ")),
            InjectAgentsMd::Never
        );
    }

    #[test]
    fn default_project_confines_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("Projects/Demo")).unwrap();
        std::fs::write(root.join("note.md"), "x").unwrap();
        let p = DefaultProject;
        assert_eq!(p.resolve_cwd(&root, None).unwrap(), root);
        assert_eq!(
            p.resolve_cwd(&root, Some("Projects/Demo")).unwrap(),
            root.join("Projects/Demo")
        );
        assert!(p.resolve_cwd(&root, Some("../x")).is_err());
        assert!(p.resolve_cwd(&root, Some("/etc")).is_err());
        assert!(
            p.resolve_cwd(&root, Some("note.md")).is_err(),
            "not a folder"
        );
        assert!(p.resolve_cwd(&root, Some("missing")).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
            assert!(
                p.resolve_cwd(&root, Some("escape")).is_err(),
                "symlink escape"
            );
        }
    }
}
