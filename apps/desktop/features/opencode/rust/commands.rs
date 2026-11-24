//! The OpenCode feature's commands, `plugin:opencode|*`: thin glue for Settings > Agent >
//! OpenCode. Status needs no server; the model list and the saved rules need one, so they start
//! the window's server (Writer's own configuration first, `Servers::ensure_up`). Every call
//! runs off the UI thread through `commands::blocking`, and no reply carries a provider's
//! headers, settings or a secret: the rows are `models.rs`'s.

use super::client::SHORT;
use super::models::{self, OpencodeModel, SavedRules};
use super::opencode_api as api;
use super::servers::Servers;
use crate::commands::blocking;
use crate::error::AppError;
use crate::features;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, Runtime};

/// Where the program is and whether Writer can use it.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// The version is one Writer was built against (unknown counts as supported).
    pub supported: bool,
    /// The oldest version Writer supports.
    pub min_version: String,
}

fn servers<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Arc<Servers<R>>, AppError> {
    features::state_of::<R, Servers<R>>(app, "opencode")
        .ok_or_else(|| AppError::FeatureUnavailable("opencode".into()))
}

/// The calling window's canonical workspace root.
fn root_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview: &tauri::Webview<R>,
) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    root.canonicalize().map_err(|e| AppError::Io(e.to_string()))
}

/// Finds the program and asks it for its version (`opencode --version`); never starts a server.
#[tauri::command]
#[specta::specta]
pub async fn opencode_status<R: Runtime>(
    binary_override: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<OpencodeStatus, AppError> {
    let servers = servers(&app)?;
    let label = webview.label().to_string();
    blocking(move || {
        let override_path = binary_override
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .or_else(|| servers.setting(&label, super::servers::BINARY_SETTING));
        let info = super::driver::detect(servers.spawner(), override_path.as_deref());
        Ok(OpencodeStatus {
            found: info.found,
            supported: info.supported.unwrap_or(true),
            path: info.path,
            version: info.version,
            min_version: info.min_version.unwrap_or_default(),
        })
    })
    .await
}

/// The models of the server, live, with provider names, prices and capabilities. The first answer
/// after a start can be empty (the server settles its providers a moment later), so it asks again
/// for a few seconds before it gives an empty list.
#[tauri::command]
#[specta::specta]
pub async fn opencode_models<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<OpencodeModel>, AppError> {
    let servers = servers(&app)?;
    let label = webview.label().to_string();
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let server = servers.ensure_up(&label, &root).map_err(AppError::Io)?;
        let conn = server
            .connection()
            .ok_or_else(|| AppError::Io("OpenCode is not running".into()))?;
        let client = conn.client.clone();
        let reply = server.io().call(
            async move {
                let mut rows = Vec::new();
                for attempt in 0..16 {
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    let Ok(models) = client.get(&api::MODELS, &[]).await else {
                        continue;
                    };
                    let providers = client
                        .get(&api::PROVIDERS, &[])
                        .await
                        .unwrap_or(Value::Null);
                    rows = models::from_replies(&models, &providers);
                    if !rows.is_empty() {
                        break;
                    }
                }
                rows
            },
            Duration::from_secs(12),
        );
        reply.ok_or_else(|| AppError::Io("OpenCode did not answer".into()))
    })
    .await
}

/// The rules the user saved with "Always allow" in OpenCode for this vault's project. A project
/// is the vault's when it holds the vault's folder (`models::project_of`); until the server knows
/// one, the list is every project's and read-only.
#[tauri::command]
#[specta::specta]
pub async fn opencode_saved_rules<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<SavedRules, AppError> {
    let servers = servers(&app)?;
    let label = webview.label().to_string();
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let server = servers.ensure_up(&label, &root).map_err(AppError::Io)?;
        let conn = server
            .connection()
            .ok_or_else(|| AppError::Io("OpenCode is not running".into()))?;
        server
            .io()
            .call(vault_rules(conn.client.clone(), root), SHORT * 2)
            .ok_or_else(|| AppError::Io("OpenCode did not answer".into()))?
            .map_err(|_| AppError::Io("OpenCode refused the request".into()))
    })
    .await
}

/// The vault's own project: what the server says for the vault's folder (`GET /api/location`),
/// else the project whose folder holds it (never a catch-all at the filesystem root).
async fn vault_project(
    client: &super::client::Client,
    root: &std::path::Path,
) -> Result<Option<String>, super::client::ApiError> {
    let dir = root.to_string_lossy();
    let asked = client
        .request(
            &api::LOCATION,
            &[],
            &[("location[directory]", dir.as_ref())],
            None,
            SHORT,
        )
        .await;
    if let Some(id) = asked.ok().as_ref().and_then(models::project_of_location) {
        return Ok(Some(id));
    }
    Ok(models::project_of(
        &client.get(&api::PROJECTS, &[]).await?,
        root,
    ))
}

/// The vault's saved rules, with whether they are the vault's project's alone.
pub(super) async fn vault_rules(
    client: super::client::Client,
    root: PathBuf,
) -> Result<SavedRules, super::client::ApiError> {
    let project = vault_project(&client, &root).await?;
    let query: Vec<(&str, &str)> = project
        .as_deref()
        .map(|p| vec![("projectID", p)])
        .unwrap_or_default();
    let reply = client
        .request(&api::SAVED_RULES, &[], &query, None, SHORT)
        .await?;
    Ok(SavedRules {
        rules: models::saved_rules(&reply, project.as_deref()),
        project_scoped: project.is_some(),
    })
}

/// Removes one saved rule (`psv_...`) of this vault's project; a rule that is already gone is not
/// an error. A rule of another project, or any rule while the vault's project is not known, is
/// refused: Settings only lists what it may remove.
#[tauri::command]
#[specta::specta]
pub async fn opencode_remove_saved_rule<R: Runtime>(
    id: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let servers = servers(&app)?;
    let label = webview.label().to_string();
    let root = root_of(&app, &webview)?;
    blocking(move || {
        // the id goes into a URL: only the shape the server hands out
        if !id.starts_with("psv_") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AppError::InvalidPath("not a saved rule id".into()));
        }
        let server = servers.ensure_up(&label, &root).map_err(AppError::Io)?;
        let conn = server
            .connection()
            .ok_or_else(|| AppError::Io("OpenCode is not running".into()))?;
        let client = conn.client.clone();
        server
            .io()
            .call(remove_rule(client, root, id), SHORT * 3)
            .ok_or_else(|| AppError::Io("OpenCode did not answer".into()))?
    })
    .await
}

pub(super) async fn remove_rule(
    client: super::client::Client,
    root: PathBuf,
    id: String,
) -> Result<(), AppError> {
    let mine = vault_rules(client.clone(), root)
        .await
        .map_err(|_| AppError::Io("OpenCode refused the request".into()))?;
    if !mine.project_scoped || !mine.rules.iter().any(|r| r.id == id) {
        return Err(AppError::InvalidPath(
            "not a saved rule of this project".into(),
        ));
    }
    match client
        .request(&api::SAVED_RULE_DELETE, &[("id", &id)], &[], None, SHORT)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.is_not_found() => Ok(()),
        Err(_) => Err(AppError::Io("OpenCode refused the request".into())),
    }
}
