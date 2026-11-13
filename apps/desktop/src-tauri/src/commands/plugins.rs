// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri commands + the `writer-plugin` URI scheme for the Obsidian plugin
//! host. Policy lives in `crate::plugins` / `crate::plugin_store`; this layer
//! resolves the calling window's vault, confines it with
//! `WorkspaceState::authorize_path`, and maps errors to `AppError`.

use crate::error::AppError;
use crate::plugin_store;
use crate::plugins::{self, Served};
use crate::state::{AppState, WorkspaceState};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

const TRUST_FILE: &str = "plugins_trust.json";

#[derive(Debug, Serialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub manifest: Value,
}

#[derive(Debug, Serialize)]
pub struct PluginsState {
    pub trusted: bool,
    pub enabled: Vec<String>,
    pub installed: Vec<InstalledPlugin>,
}

struct Ctx {
    root: PathBuf,
    trust_file: PathBuf,
}

impl Ctx {
    fn trusted(&self) -> bool {
        plugins::is_trusted(&self.trust_file, &self.root)
    }

    fn require_trusted(&self) -> Result<(), AppError> {
        if self.trusted() {
            Ok(())
        } else {
            Err(AppError::InvalidPath(
                "plugins are in restricted mode for this vault".into(),
            ))
        }
    }
}

fn trust_file(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.join(TRUST_FILE))
}

/// The window's canonical workspace root, confined through `authorize_path`
/// (this resolves a symlinked `.obsidian` that points out of the workspace).
fn ctx_for(state: &WorkspaceState, app: &tauri::AppHandle) -> Result<Ctx, AppError> {
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    let root = root.canonicalize().map_err(AppError::from)?;
    state.authorize_path(&root.join(".obsidian"))?;
    Ok(Ctx {
        root,
        trust_file: trust_file(app)?,
    })
}

fn window_ctx(webview: &tauri::Webview, app: &tauri::AppHandle) -> Result<Ctx, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    ctx_for(&state, app)
}

fn io(e: String) -> AppError {
    AppError::Io(e)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn plugins_state(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<PluginsState, AppError> {
    let ctx = match window_ctx(&webview, &app) {
        Ok(c) => c,
        Err(AppError::NoWorkspace) => {
            return Ok(PluginsState {
                trusted: false,
                enabled: Vec::new(),
                installed: Vec::new(),
            })
        }
        Err(e) => return Err(e),
    };
    blocking(move || {
        Ok(PluginsState {
            trusted: ctx.trusted(),
            enabled: plugins::enabled_ids(&ctx.root),
            installed: plugins::installed(&ctx.root)
                .into_iter()
                .map(|(id, manifest)| InstalledPlugin { id, manifest })
                .collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn plugins_set_trust(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    trusted: bool,
) -> Result<(), AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || plugins::set_trusted(&ctx.trust_file, &ctx.root, trusted).map_err(io)).await
}

#[tauri::command]
pub async fn plugins_set_enabled(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || {
        // enabling runs code: refuse it in restricted mode (disabling is always fine)
        if enabled {
            ctx.require_trusted()?;
        }
        plugins::set_enabled(&ctx.root, &id, enabled)
            .map(|_| ())
            .map_err(io)
    })
    .await
}

#[tauri::command]
pub async fn plugin_read_asset(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
    kind: String,
) -> Result<String, AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || match kind.as_str() {
        "manifest" => plugins::read_manifest(&ctx.root, &id).map_err(io),
        "styles" => {
            ctx.require_trusted()?;
            Ok(plugins::read_styles(&ctx.root, &id)
                .map_err(io)?
                .unwrap_or_default())
        }
        other => Err(AppError::InvalidPath(format!(
            "unknown asset kind {other:?}"
        ))),
    })
    .await
}

#[tauri::command]
pub async fn plugin_data_read(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<String>, AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || {
        ctx.require_trusted()?;
        plugins::read_data(&ctx.root, &id).map_err(io)
    })
    .await
}

#[tauri::command]
pub async fn plugin_data_write(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
    json: String,
) -> Result<(), AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || {
        ctx.require_trusted()?;
        plugins::write_data(&ctx.root, &id, &json).map_err(io)
    })
    .await
}

/// Store list needs no vault: it only reads the public community list.
#[tauri::command]
pub async fn plugin_store_list(refresh: Option<bool>) -> Result<Vec<Value>, AppError> {
    blocking(move || {
        plugin_store::list(&plugin_store::http_get, refresh.unwrap_or(false)).map_err(io)
    })
    .await
}

#[tauri::command]
pub async fn plugin_store_detail(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, AppError> {
    let root = window_ctx(&webview, &app).ok().map(|c| c.root);
    blocking(move || {
        plugin_store::detail(&plugin_store::http_get, root.as_deref(), &id).map_err(io)
    })
    .await
}

#[tauri::command]
pub async fn plugin_store_install(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || plugin_store::install(&plugin_store::http_get, &ctx.root, &id).map_err(io))
        .await
}

#[tauri::command]
pub async fn plugin_store_uninstall(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    let ctx = window_ctx(&webview, &app)?;
    blocking(move || plugin_store::uninstall(&ctx.root, &id).map_err(io)).await
}

/* ------------------------------------------------------------ URI scheme */

fn respond(status: u16, ctype: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Serve one `writer-plugin://` request for the window `label`.
pub fn handle_scheme(
    app: &tauri::AppHandle,
    label: &str,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let refuse = |why: &str| respond(403, "text/plain; charset=utf-8", why.as_bytes().to_vec());
    if request.method() != tauri::http::Method::GET {
        return refuse("method not allowed");
    }
    let Some(state) = app.state::<AppState>().get(label) else {
        return refuse("no window");
    };
    let ctx = match ctx_for(&state, app) {
        Ok(c) => c,
        Err(_) => return refuse("no vault"),
    };
    match plugins::serve(Some(&ctx.root), request.uri().path(), ctx.trusted()) {
        Served::Js(b) => respond(200, "text/javascript; charset=utf-8", b),
        Served::Refused(why) => refuse(why),
        Served::Missing => respond(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}
