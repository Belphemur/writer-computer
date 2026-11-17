//! Tauri glue for agent projects (spec `SPECs/native-agent-spec.md` section 4). The logic lives
//! in `agent/project.rs` and `agent/project_context.rs` (Tauri-free); this file resolves the
//! window's workspace root and maps errors. Every command is `async` and does its IO through
//! `blocking`.

use super::blocking;
use super::index::window_index;
use crate::agent::events::NewProjectRequest;
use crate::agent::project::{self, MakeOptions, ProjectDetail, ProjectError, ProjectUpdate};
use crate::agent::project_context::{self, Manifest};
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

fn map_err(e: ProjectError) -> AppError {
    match e {
        ProjectError::Invalid(m) => AppError::InvalidPath(m),
        ProjectError::NotFound(m) => AppError::NotFound(m),
        ProjectError::Exists(m) => AppError::AlreadyExists(m),
        ProjectError::Io(m) => AppError::Io(m),
    }
}

fn root_of(app: &tauri::AppHandle, webview: &tauri::Webview) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    Ok(root)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn agent_list_projects(
    include_archived: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<ProjectDetail>, AppError> {
    let root = root_of(&app, &webview)?;
    let include = include_archived.unwrap_or(false);
    blocking(move || project::list(&root, include).map_err(map_err)).await
}

#[tauri::command]
pub async fn agent_read_project(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || project::read(&root, &path).map_err(map_err)).await
}

#[tauri::command]
pub async fn agent_create_project(
    name: String,
    parent: Option<String>,
    description: String,
    inclusions: Vec<String>,
    instructions: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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
        project::create(&root, &request, now_ms())
            .map(|r| r.project)
            .map_err(map_err)
    })
    .await
}

#[tauri::command]
pub async fn agent_make_project(
    path: String,
    create_agents_md: bool,
    instructions: Option<String>,
    description: Option<String>,
    inclusions: Option<Vec<String>>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let opts = MakeOptions {
            create_agents_md,
            instructions: instructions.unwrap_or_default(),
            description: description.unwrap_or_default(),
            inclusions: inclusions.unwrap_or_default(),
        };
        project::make_with(&root, &path, &opts, now_ms())
            .map(|r| r.project)
            .map_err(map_err)
    })
    .await
}

#[tauri::command]
pub async fn agent_update_project(
    path: String,
    update: ProjectUpdate,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || project::update(&root, &path, &update, now_ms()).map_err(map_err)).await
}

#[tauri::command]
pub async fn agent_archive_project(
    path: String,
    archived: bool,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ProjectDetail, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || project::archive(&root, &path, archived, now_ms()).map_err(map_err)).await
}

/// What "Make project" would do to a folder, for the dialog's convert mode.
#[derive(Debug, Clone, Serialize)]
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
pub async fn agent_inspect_folder(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPreview {
    pub manifest: Manifest,
    pub text: String,
}

#[tauri::command]
pub async fn agent_project_manifest(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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
