// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri commands + the `writer-plugin` URI scheme for the Obsidian plugin
//! host. Policy lives in `crate::plugins` / `crate::plugin_store`; this layer
//! resolves the calling window's vault, confines it with
//! `WorkspaceState::authorize_path`, and maps errors to `AppError`.

use crate::error::AppError;
use crate::plugin_http::{
    self, HttpClient, HttpRequest, HttpResponse, StreamEvent, StreamRegistry,
};
use crate::plugin_proc::{self, Consent, ConsentRequest, ProcEvent, ProcManager, SpawnRequest};
use crate::plugin_store;
use crate::plugins::{self, Served};
use crate::state::{AppState, WorkspaceState};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
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
    let root = ctx.root.clone();
    blocking(move || plugins::set_trusted(&ctx.trust_file, &ctx.root, trusted).map_err(io)).await?;
    if !trusted {
        // Restricted mode: nothing the vault's plugins started may keep running.
        stop_vault_work(&app, &root);
    }
    Ok(())
}

/// Cancel every plugin stream and kill every plugin process of one vault.
pub fn stop_vault_work(app: &tauri::AppHandle, root: &Path) {
    app.state::<StreamRegistry>().cancel_root(root);
    app.state::<ProcManager>().kill_root(root);
}

/// A window closed or left its vault: stop what its plugins started.
pub fn stop_window_work(app: &tauri::AppHandle, label: &str) {
    if let Some(streams) = app.try_state::<StreamRegistry>() {
        streams.cancel_window(label);
    }
    if let Some(procs) = app.try_state::<ProcManager>() {
        procs.kill_window(label);
    }
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

/* --------------------------------------------------------- plugin HTTP */

/// A trusted vault's context, or the restricted-mode refusal.
fn trusted_ctx(webview: &tauri::Webview, app: &tauri::AppHandle) -> Result<Ctx, AppError> {
    let ctx = window_ctx(webview, app)?;
    ctx.require_trusted()?;
    Ok(ctx)
}

/// One buffered HTTP(S) request for the calling window's plugins.
#[tauri::command]
pub async fn plugin_http_request(
    request: HttpRequest,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<HttpResponse, AppError> {
    trusted_ctx(&webview, &app)?;
    let client = HttpClient::shared().map_err(io)?;
    plugin_http::request(&client, &request).await.map_err(io)
}

/// Start a streaming request; events arrive on `channel` (see `StreamEvent`).
/// Returns the stream id for `plugin_http_stream_cancel`.
#[tauri::command]
pub async fn plugin_http_stream_start(
    request: HttpRequest,
    channel: Channel<StreamEvent>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<u64, AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    let client = HttpClient::shared().map_err(io)?;
    let emit: plugin_http::Emit = Arc::new(move |ev| channel.send(ev).is_ok());
    app.state::<StreamRegistry>()
        .start(client, webview.label(), ctx.root, &request, emit)
        .map_err(io)
}

#[tauri::command]
pub fn plugin_http_stream_cancel(
    stream_id: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> bool {
    app.state::<StreamRegistry>()
        .cancel(webview.label(), stream_id)
}

/* ------------------------------------------------------- plugin processes */

/// Questions waiting on the one open dialog; more than this are refused.
const MAX_PENDING_CONSENTS: usize = 4;
static CONSENT_QUEUE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static CONSENT_PENDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The native consent dialog: outside the webview, so page script cannot
/// answer for the user. Deny is the cancel button; closing the dialog denies.
struct DialogConsent {
    app: tauri::AppHandle,
    window: Option<tauri::Window>,
}

impl Consent for DialogConsent {
    fn ask(&self, req: &ConsentRequest) -> bool {
        use std::sync::atomic::Ordering;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        if CONSENT_PENDING.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING_CONSENTS {
            CONSENT_PENDING.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        // one dialog at a time: a plugin spawning in a loop queues here
        let _turn = CONSENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
        let mut d = self
            .app
            .dialog()
            .message(req.message())
            .title("Writer: run program?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Run once".to_string(),
                "Deny".to_string(),
            ));
        if let Some(w) = &self.window {
            d = d.parent(w);
        }
        let answer = d.blocking_show();
        CONSENT_PENDING.fetch_sub(1, Ordering::SeqCst);
        answer
    }
}

/// Start a program for a plugin. ALWAYS shows a native consent dialog first.
/// Events arrive on `on_event` (see `ProcEvent`); returns the process id.
#[tauri::command]
pub async fn plugin_proc_spawn(
    request: SpawnRequest,
    on_event: Channel<ProcEvent>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<u64, AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    let label = webview.label().to_string();
    let state = app.state::<AppState>().get_or_create(&label);
    // cwd: default the vault root; must resolve inside it
    let cwd = match &request.cwd {
        Some(c) => PathBuf::from(c),
        None => ctx.root.clone(),
    };
    let cwd = state.authorize_path(&cwd)?;
    if !cwd.starts_with(&ctx.root) || !cwd.is_dir() {
        return Err(AppError::InvalidPath(
            "cwd must be a directory inside the vault".into(),
        ));
    }
    let prepared = plugin_proc::prepare(&request, cwd).map_err(io)?;
    let consent = DialogConsent {
        app: app.clone(),
        window: webview.window().into(),
    };
    let emit: plugin_proc::Emit = Arc::new(move |ev| on_event.send(ev).is_ok());
    let root = ctx.root.clone();
    let app2 = app.clone();
    let label2 = label.clone();
    let plugin_id = request.plugin_id.clone();
    blocking(move || {
        // trust and vault are re-read after the dialog returns
        let still_ok = || {
            let Some(st) = app2.state::<AppState>().get(&label2) else {
                return false;
            };
            match ctx_for(&st, &app2) {
                Ok(c) => c.root == root && c.trusted(),
                Err(_) => false,
            }
        };
        app2.state::<ProcManager>()
            .spawn_with_consent(
                &consent, &label2, &root, &plugin_id, &prepared, &still_ok, emit,
            )
            .map_err(io)
    })
    .await
}

#[tauri::command]
pub async fn plugin_proc_write(
    proc_id: u64,
    data_base64: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    trusted_ctx(&webview, &app)?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| AppError::Io("data_base64 is not valid base64".into()))?;
    let label = webview.label().to_string();
    // a full pipe blocks: keep it off the async pool
    blocking(move || {
        app.state::<ProcManager>()
            .write(&label, proc_id, &data)
            .map_err(io)
    })
    .await
}

#[tauri::command]
pub fn plugin_proc_close_stdin(
    proc_id: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    trusted_ctx(&webview, &app)?;
    app.state::<ProcManager>()
        .close_stdin(webview.label(), proc_id)
        .map_err(io)
}

/// Kill the process and its group; an `exit` event follows.
#[tauri::command]
pub fn plugin_proc_kill(
    proc_id: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    app.state::<ProcManager>()
        .kill(webview.label(), proc_id)
        .map_err(io)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_vault_is_refused_until_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let ctx = Ctx {
            root: root.clone(),
            trust_file: dir.path().join("trust.json"),
        };
        // every plugin HTTP / process command goes through require_trusted
        assert!(ctx.require_trusted().is_err());
        plugins::set_trusted(&ctx.trust_file, &root, true).unwrap();
        assert!(ctx.require_trusted().is_ok());
        plugins::set_trusted(&ctx.trust_file, &root, false).unwrap();
        assert!(ctx.require_trusted().is_err());
    }
}
