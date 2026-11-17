//! Tauri glue for the `/` menu's skills on disk (`agent/skills.rs`, Tauri-free). Resolves the
//! window's workspace root (never taken from the UI) and does the IO through `blocking`.

use super::blocking;
use crate::agent::skills::{self, DiskSkill, SkillsError};
use crate::error::AppError;
use crate::state::AppState;
use tauri::Manager;

/// Skills in `.claude/skills` and `.agents/skills` of `project_path` (vault-relative), the vault
/// root and, read-only, the user's home (`~/.claude/skills`, `~/.agents/skills`), de-duplicated by
/// name. Plugin-provided skills are not here: the CLI reports those in `session-started`. Logs
/// counts only.
#[tauri::command]
pub async fn agent_list_skills(
    project_path: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DiskSkill>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    blocking(move || {
        let root = root
            .canonicalize()
            .map_err(|e| AppError::Io(e.to_string()))?;
        let home = crate::plugin_env::home_dir();
        let found = skills::list_skills(&root, project_path.as_deref(), home.as_deref())
            .map_err(|SkillsError::Invalid(m)| AppError::InvalidPath(m))?;
        let global = found.iter().filter(|s| s.scope == "global").count();
        log::info!("agent skills: {} found ({global} global)", found.len());
        Ok(found)
    })
    .await
}
