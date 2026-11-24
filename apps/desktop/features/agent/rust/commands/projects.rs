//! Tauri glue for agent projects (spec `SPECs/native-agent-spec.md` section 4). The logic lives
//! in `agent/project.rs` and `agent/project_context.rs` (Tauri-free); this file resolves the
//! window's workspace root and maps errors. Every command is `async` and does its IO through
//! `blocking`.

use crate::agent::events::NewProjectRequest;
use crate::agent::project::{self, MakeOptions, ProjectDetail, ProjectError, ProjectUpdate};
use crate::agent::project_context::{self, Manifest};
use crate::commands::blocking;
use crate::commands::index::window_index;
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, Runtime};

fn map_err(e: ProjectError) -> AppError {
    match e {
        ProjectError::Invalid(m) => AppError::InvalidPath(m),
        ProjectError::NotFound(m) => AppError::NotFound(m),
        ProjectError::Exists(m) => AppError::AlreadyExists(m),
        ProjectError::Io(m) => AppError::Io(m),
    }
}

fn root_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview: &tauri::Webview<R>,
) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    Ok(root)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_list_projects<R: Runtime>(
    include_archived: Option<bool>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<ProjectDetail>, AppError> {
    let root = root_of(&app, &webview)?;
    let include = include_archived.unwrap_or(false);
    blocking(move || project::list(&root, include).map_err(map_err)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_read_project<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || project::read(&root, &path).map_err(map_err)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_create_project<R: Runtime>(
    name: String,
    parent: Option<String>,
    description: String,
    inclusions: Vec<String>,
    instructions: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    let request = NewProjectRequest {
        name,
        parent,
        description,
        inclusions,
        instructions,
    };
    blocking(move || {
        project::create(&root, &request, project::now_ms())
            .map(|r| r.project)
            .map_err(map_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_make_project<R: Runtime>(
    path: String,
    create_agents_md: bool,
    instructions: Option<String>,
    description: Option<String>,
    inclusions: Option<Vec<String>>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let opts = MakeOptions {
            create_agents_md,
            instructions: instructions.unwrap_or_default(),
            description: description.unwrap_or_default(),
            inclusions: inclusions.unwrap_or_default(),
        };
        project::make_with(&root, &path, &opts, project::now_ms())
            .map(|r| r.project)
            .map_err(map_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_update_project<R: Runtime>(
    path: String,
    update: ProjectUpdate,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || project::update(&root, &path, &update, project::now_ms()).map_err(map_err))
        .await
}

/// Archive or unarchive a project (spec 4.6): the one `project::archive`, after the project's idle
/// chats are closed (their processes run inside the folder that moves). Refused, nothing changed,
/// while a chat of it runs a turn or waits on a permission. Returns the project at its new path.
#[tauri::command]
#[specta::specta]
pub async fn agent_archive_project<R: Runtime>(
    path: String,
    archived: bool,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    let setting = archive_folder_setting(&app, webview.label());
    blocking(move || {
        let folder = project::archive_folder(&root, setting.as_deref()).map_err(map_err)?;
        if let Some(sessions) = super::super::sessions_if_started(&app) {
            let cwd = project::resolve_cwd(&root, Some(&path)).map_err(map_err)?;
            sessions
                .stop_idle_in(&cwd)
                .map_err(|busy| AppError::Refused(busy.to_string()))?;
        }
        project::archive(&root, &path, archived, &folder, project::now_ms()).map_err(map_err)
    })
    .await
}

/// `agent.projects-archive-folder` as the window's settings hold it (blank: the default).
fn archive_folder_setting<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Option<String> {
    crate::config::global_string(app, label, project::SETTING_ARCHIVE_FOLDER)
}

/// What "Make project" would do to a folder, for the dialog's convert mode.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    pub path: String,
    pub name: String,
    pub is_project: bool,
    pub has_project_md: bool,
    pub has_agents_md: bool,
    pub has_claude_md: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_inspect_folder<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<FolderInspection, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let root = root.canonicalize()?;
        let c = crate::vault_ops::confine(&root, &path)
            .map_err(|e| AppError::InvalidPath(e.to_string()))?;
        if !c.abs.is_dir() {
            return Err(AppError::NotFound(format!("{} is not a folder", c.rel)));
        }
        let has = |n: &str| c.abs.join(n).is_file();
        Ok(FolderInspection {
            name: c.rel.rsplit('/').next().unwrap_or(&c.rel).to_string(),
            is_project: project::read(&root, &c.rel).is_ok(),
            has_project_md: has(project::PROJECT_FILE),
            has_agents_md: has(project::AGENTS_FILE),
            has_claude_md: has(project::CLAUDE_FILE),
            path: c.rel,
        })
    })
    .await
}

/// The project's source manifest resolved through the window's vault index, with the exact text
/// the agent receives (the project home's "Preview manifest").
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPreview {
    pub manifest: Manifest,
    pub text: String,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_project_manifest<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ManifestPreview, AppError> {
    blocking(move || {
        let (state, index) = window_index(&app, &webview)?;
        let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
        let detail = project::read(&root, &path).map_err(map_err)?;
        let manifest = project_context::build_manifest(&detail, index.as_ref());
        let text = manifest.render();
        Ok(ManifestPreview { manifest, text })
    })
    .await
}
