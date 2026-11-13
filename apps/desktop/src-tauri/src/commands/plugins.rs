// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri commands + the `writer-plugin` URI scheme for the Obsidian plugin
//! host. Policy lives in `crate::plugins` / `crate::plugin_store`; this layer
//! resolves the calling window's vault, confines it with
//! `WorkspaceState::authorize_path`, and maps errors to `AppError`.

use crate::error::AppError;
use crate::plugin_consent::{ConsentStore, Remembered};
use crate::plugin_env::{self, OsInfo, PluginEnv, ProbeResult, ProbeScope};
use crate::plugin_http::{
    self, HttpClient, HttpRequest, HttpResponse, StreamEvent, StreamRegistry,
};
use crate::plugin_proc::{
    self, Consent, ConsentRequest, Decision, ProcEvent, ProcManager, Sig, SpawnRequest,
};
use crate::plugin_secrets::PluginSecrets;
use crate::plugin_store;
use crate::plugins::{self, Served};
use crate::state::{AppState, WorkspaceState};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};

const TRUST_FILE: &str = "plugins_trust.json";
const CONSENT_FILE: &str = "plugins_proc_consent.json";

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

fn consent_store(app: &tauri::AppHandle) -> Result<ConsentStore, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(ConsentStore::new(dir.join(CONSENT_FILE)))
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
        // Restricted mode: nothing the vault's plugins started may keep running,
        // and no "always allow" survives the revoke.
        stop_vault_work(&app, &root);
        let store = consent_store(&app)?;
        let root2 = root.clone();
        blocking(move || store.clear_vault(&root2).map_err(io)).await?;
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
    if let Some(env) = app.try_state::<PluginEnv>() {
        env.forget_window(label);
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

/// Every plugin secret (`app.secretStorage`) from the OS credential store. The store is
/// shared by all plugins and vaults of the user; only trusted vaults may read it.
#[tauri::command]
pub async fn plugin_secrets_load(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<BTreeMap<String, String>, AppError> {
    trusted_ctx(&webview, &app)?;
    blocking(move || app.state::<PluginSecrets>().load_all().map_err(io)).await
}

#[tauri::command]
pub async fn plugin_secret_set(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
    secret: String,
) -> Result<(), AppError> {
    trusted_ctx(&webview, &app)?;
    blocking(move || app.state::<PluginSecrets>().set(&id, &secret).map_err(io)).await
}

#[tauri::command]
pub async fn plugin_secret_delete(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    trusted_ctx(&webview, &app)?;
    blocking(move || app.state::<PluginSecrets>().delete(&id).map_err(io)).await
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

const BTN_ONCE: &str = "Run once";
const BTN_ALWAYS: &str = "Always allow this plugin in this vault";
const BTN_DENY: &str = "Deny";

impl Consent for DialogConsent {
    fn ask(&self, req: &ConsentRequest) -> Decision {
        use std::sync::atomic::Ordering;
        use tauri_plugin_dialog::{
            DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
        };
        if CONSENT_PENDING.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING_CONSENTS {
            CONSENT_PENDING.fetch_sub(1, Ordering::SeqCst);
            return Decision::Deny;
        }
        // one dialog at a time: a plugin spawning in a loop queues here
        let _turn = CONSENT_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
        let mut d = self
            .app
            .dialog()
            .message(req.message())
            .title("Writer: run program?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                BTN_ONCE.to_string(),
                BTN_ALWAYS.to_string(),
                BTN_DENY.to_string(),
            ));
        if let Some(w) = &self.window {
            d = d.parent(w);
        }
        let answer = d.blocking_show_with_result();
        CONSENT_PENDING.fetch_sub(1, Ordering::SeqCst);
        match answer {
            MessageDialogResult::Yes => Decision::Once,
            MessageDialogResult::No => Decision::Always,
            MessageDialogResult::Custom(s) if s == BTN_ONCE => Decision::Once,
            MessageDialogResult::Custom(s) if s == BTN_ALWAYS => Decision::Always,
            _ => Decision::Deny,
        }
    }
}

/// Payload of the `plugin-proc:spawned` window event, sent for EVERY spawn
/// (also remembered programs that skipped the dialog).
#[derive(Clone, Serialize)]
struct SpawnedEvent {
    plugin_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    pid: u32,
}

/// Start a program for a plugin. Shows a native consent dialog first unless
/// the user chose "Always allow" for this program, plugin and vault. Events
/// arrive on `on_event` (see `ProcEvent`); returns the process id. A program
/// that cannot be found or exec'd is a terminal `error` event, not a rejection.
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
    let sink: plugin_proc::Emit = Arc::new(move |ev| on_event.send(ev).is_ok());
    let prepared = match plugin_proc::prepare(&request, cwd) {
        Ok(p) => p,
        // nothing to run and nothing to ask about: report it like a failed exec
        Err(e) if e.starts_with("ENOENT") => {
            return Ok(app.state::<ProcManager>().fail(&sink, "ENOENT", e));
        }
        Err(e) => return Err(io(e)),
    };
    let consent = DialogConsent {
        app: app.clone(),
        window: webview.window().into(),
    };
    let store = consent_store(&app)?;
    let emit: plugin_proc::Emit = {
        let app = app.clone();
        let label = label.clone();
        let info = SpawnedEvent {
            plugin_id: request.plugin_id.clone(),
            program: prepared.program.to_string_lossy().into_owned(),
            args: prepared.args.clone(),
            cwd: prepared.cwd.to_string_lossy().into_owned(),
            pid: 0,
        };
        Arc::new(move |ev| {
            if let ProcEvent::Spawn { pid } = &ev {
                let _ = app.emit_to(
                    label.as_str(),
                    "plugin-proc:spawned",
                    SpawnedEvent {
                        pid: *pid,
                        ..info.clone()
                    },
                );
            }
            sink(ev)
        })
    };
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
                &consent, &store, &label2, &root, &plugin_id, &prepared, &still_ok, emit,
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

/// Signal a process; the terminal event follows once it is gone.
/// `signal` defaults to SIGTERM (graceful; the TS side escalates to SIGKILL),
/// `group` to true (`kill(-pgid)`, so grandchildren get it too). No caller
/// relied on the old SIGKILL default.
#[tauri::command]
pub fn plugin_proc_kill(
    proc_id: u64,
    signal: Option<String>,
    group: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    trusted_ctx(&webview, &app)?;
    let sig = Sig::parse(signal.as_deref().unwrap_or("SIGTERM")).map_err(io)?;
    app.state::<ProcManager>()
        .kill(webview.label(), proc_id, sig, group.unwrap_or(true))
        .map_err(io)
}

#[tauri::command]
pub fn plugins_consent_list(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<Remembered>, AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    Ok(consent_store(&app)?.list(&ctx.root))
}

#[tauri::command]
pub async fn plugins_consent_revoke(
    plugin_id: String,
    program: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    let store = consent_store(&app)?;
    blocking(move || store.revoke(&ctx.root, &plugin_id, &program).map_err(io)).await
}

/* ------------------------------------------------------- plugin environment */

/// Resolve an executable natively (no process, no consent).
#[tauri::command]
pub async fn plugin_which(
    name: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    trusted_ctx(&webview, &app)?;
    let found = blocking(move || plugin_env::which(&name).map_err(AppError::InvalidPath)).await?;
    Ok(found.map(|p| {
        app.state::<PluginEnv>().remember(webview.label(), &p);
        p.to_string_lossy().into_owned()
    }))
}

/// PATH of the user's login shell (cached for the app run).
#[tauri::command]
pub async fn plugin_resolve_login_path(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    trusted_ctx(&webview, &app)?;
    blocking(|| Ok(plugin_env::login_path())).await
}

#[tauri::command]
pub async fn plugin_os_info(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<OsInfo, AppError> {
    trusted_ctx(&webview, &app)?;
    blocking(|| Ok(plugin_env::os_info())).await
}

/// Read-only metadata for paths in the vault, `~/.claude` (and
/// `CLAUDE_CONFIG_DIR`) or a path `plugin_which` returned for this window.
#[tauri::command]
pub async fn plugin_fs_probe(
    paths: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<ProbeResult>, AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    let which = app.state::<PluginEnv>().seen(webview.label());
    blocking(move || {
        let scope = ProbeScope {
            vault: &ctx.root,
            claude_dirs: plugin_env::claude_dirs(),
            which: &which,
        };
        plugin_env::probe(&paths, &scope).map_err(AppError::InvalidPath)
    })
    .await
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
