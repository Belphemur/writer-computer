// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri commands + the `writer-plugin` URI scheme for the Obsidian plugin
//! host. Policy lives in `crate::plugins` / `crate::plugin_store`; this layer
//! resolves the calling window's vault, confines it with
//! `WorkspaceState::authorize_path`, and maps errors to `AppError`.

use crate::error::AppError;
use crate::plugin_consent::{ConsentStore, Remembered};
use crate::plugin_env::{self, OsInfo, PluginEnv, ProbeResult, ProbeScope};
use crate::plugin_home_files::{self, HomeFile};
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
use tauri::{Emitter, Manager, Runtime};

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

pub(crate) fn consent_store<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<ConsentStore, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(ConsentStore::new(dir.join(CONSENT_FILE)))
}

fn trust_file<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.join(TRUST_FILE))
}

/// The window's canonical workspace root, confined through `authorize_path`
/// (this resolves a symlinked `.obsidian` that points out of the workspace).
fn ctx_for<R: Runtime>(state: &WorkspaceState, app: &tauri::AppHandle<R>) -> Result<Ctx, AppError> {
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

fn window_ctx<R: Runtime>(
    webview: &tauri::Webview<R>,
    app: &tauri::AppHandle<R>,
) -> Result<Ctx, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    ctx_for(&state, app)
}

fn io(e: String) -> AppError {
    AppError::Io(e)
}

use super::blocking;

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
    if let Some(agents) = app.try_state::<crate::agent::session::AgentSessions>() {
        agents.kill_root(root);
    }
}

/// A window closed or left its vault: stop what its plugins and the features started for it
/// (`features::Feature::on_workspace_close`).
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
    // Feature hooks (the agent's CLI processes of this window).
    crate::features::workspace_close(app, label);
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

/// Names of the stored secrets, never their values (Settings > Secrets). Needs no vault: the
/// store is shared by all vaults and the section works with none open.
#[tauri::command]
pub async fn secrets_list_ids(app: tauri::AppHandle) -> Result<Vec<String>, AppError> {
    blocking(move || app.state::<PluginSecrets>().list_ids().map_err(io)).await
}

/// Sets or replaces a secret from Settings > Secrets. The name follows Obsidian's rule
/// (lowercase letters, digits and dashes; mirrored by `isValidSecretId` in the frontend).
#[tauri::command]
pub async fn secrets_set(
    app: tauri::AppHandle,
    id: String,
    secret: String,
) -> Result<(), AppError> {
    if !is_valid_secret_name(&id) {
        return Err(io(
            "EINVAL: a secret name uses lowercase letters, digits and dashes".to_string(),
        ));
    }
    blocking(move || app.state::<PluginSecrets>().set(&id, &secret).map_err(io)).await
}

#[tauri::command]
pub async fn secrets_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    blocking(move || app.state::<PluginSecrets>().delete(&id).map_err(io)).await
}

fn is_valid_secret_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
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

/// The agent pane's gate: the window's canonical vault root, or the restricted-mode refusal.
pub(crate) fn trusted_root<R: Runtime>(
    webview: &tauri::Webview<R>,
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, AppError> {
    Ok(trusted_ctx(webview, app)?.root)
}

/// Same vault, still trusted (asked again after a consent dialog and before agent respawns).
pub(crate) fn vault_still_trusted<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    root: &Path,
) -> bool {
    let Some(st) = app.state::<AppState>().get(label) else {
        return false;
    };
    match ctx_for(&st, app) {
        Ok(c) => c.root == root && c.trusted(),
        Err(_) => false,
    }
}

/// The native consent dialog, for the agent pane's first spawn per vault.
pub(crate) fn dialog_consent<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: Option<tauri::Window<R>>,
) -> impl Consent {
    DialogConsent { app, window }
}

/// A trusted vault's context, or the restricted-mode refusal.
fn trusted_ctx<R: Runtime>(
    webview: &tauri::Webview<R>,
    app: &tauri::AppHandle<R>,
) -> Result<Ctx, AppError> {
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
struct DialogConsent<R: Runtime> {
    app: tauri::AppHandle<R>,
    window: Option<tauri::Window<R>>,
}

const BTN_ONCE: &str = "Run once";
const BTN_ALWAYS: &str = "Always allow this plugin in this vault";
const BTN_ALWAYS_AGENT: &str = "Always allow in this vault";
const BTN_DENY: &str = "Deny";

impl<R: Runtime> Consent for DialogConsent<R> {
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
        let agent = req.plugin_id == crate::agent::consent::AGENT_PLUGIN_ID;
        let (title, always) = if agent {
            ("Writer: start Claude Code?", BTN_ALWAYS_AGENT)
        } else {
            ("Writer: run program?", BTN_ALWAYS)
        };
        let mut d = self
            .app
            .dialog()
            .message(req.message())
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                BTN_ONCE.to_string(),
                always.to_string(),
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
            MessageDialogResult::Custom(s) if s == BTN_ALWAYS || s == BTN_ALWAYS_AGENT => {
                Decision::Always
            }
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
pub async fn plugins_consent_list(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<Remembered>, AppError> {
    let ctx = trusted_ctx(&webview, &app)?;
    let store = consent_store(&app)?;
    blocking(move || Ok(store.list(&ctx.root))).await
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

/// Read-only metadata for paths in the vault, agent homes (`~/.claude`,
/// `CLAUDE_CONFIG_DIR`, `~/.codex`, ...), files directly inside PATH / well-known
/// bin dirs, or a path `plugin_which` returned for this window.
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
            bin_dirs: plugin_env::bin_dirs(),
            listable: plugin_env::listable_dirs(),
            which: &which,
        };
        plugin_env::probe(&paths, &scope).map_err(AppError::InvalidPath)
    })
    .await
}

/// What the `fs` shim learns about an allowlisted home file (`plugin_home_files::HOME_FILES`).
#[derive(Debug, Serialize)]
pub struct HomeFileRead {
    pub exists: bool,
    pub text: Option<String>,
    pub version: Option<String>,
    pub size: u64,
    pub mode: u32,
    pub mtime_ms: f64,
}

/// The gates of an allowlisted home file: a trusted vault, the exact allowlisted path for this
/// plugin id, and the plugin's remembered "always allow every program" spawn consent for this
/// vault (a plugin that may spawn anything can already do what editing the file allows).
fn home_file_entry(
    plugin_id: &str,
    path: &str,
    webview: &tauri::Webview,
    app: &tauri::AppHandle,
) -> Result<(PathBuf, &'static HomeFile), AppError> {
    let invalid = |e: String| AppError::InvalidPath(e);
    let home = plugin_env::home_dir().ok_or_else(|| invalid("EACCES: no home directory".into()))?;
    let entry = plugin_home_files::entry_for(&home, path, plugin_id).map_err(invalid)?;
    let ctx = window_ctx(webview, app)?;
    let consent = consent_store(app)?.has_wildcard(&ctx.root, plugin_id);
    plugin_home_files::gate(ctx.trusted(), consent).map_err(invalid)?;
    Ok((home, entry))
}

/// Read the allowlisted `~/.claude/settings.json` for a consented agent plugin.
#[tauri::command]
pub async fn plugin_home_file_read(
    plugin_id: String,
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<HomeFileRead, AppError> {
    let (home, entry) = home_file_entry(&plugin_id, &path, &webview, &app)?;
    blocking(move || {
        let r = plugin_home_files::read(&home, entry).map_err(AppError::InvalidPath)?;
        Ok(HomeFileRead {
            exists: r.exists,
            text: r.text,
            version: r.version,
            size: r.size,
            mode: r.mode,
            mtime_ms: r.mtime_ms,
        })
    })
    .await
}

/// Replace the allowlisted file atomically; `expected_version` is the `version` of the read the
/// edit is based on (`""` = the file was absent). Returns the new version.
#[tauri::command]
pub async fn plugin_home_file_write(
    plugin_id: String,
    path: String,
    text: String,
    expected_version: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    let (home, entry) = home_file_entry(&plugin_id, &path, &webview, &app)?;
    blocking(move || {
        let out = plugin_home_files::write(&home, entry, &text, expected_version.as_deref())
            .map_err(AppError::InvalidPath)?;
        log::info!(
            target: "plugin_home_files",
            "{}",
            plugin_home_files::write_log_line(&plugin_id, entry, out.bytes)
        );
        Ok(out.version)
    })
    .await
}

/// `electron.shell.openExternal`: http, https and mailto only (`plugin_env::openable_url`).
#[tauri::command]
pub async fn plugin_open_url(
    url: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    trusted_ctx(&webview, &app)?;
    let url = plugin_env::openable_url(&url)
        .map_err(AppError::InvalidPath)?
        .to_string();
    if plugin_env::e2e_open_log(&format!("url\t{url}")) {
        return Ok(());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| io(e.to_string()))
}

/// `electron.shell.openPath` (`reveal: false`) / `showItemInFolder` (`reveal: true`): hand an
/// existing vault or agent-config entry to the system, never anything launchable
/// (`plugin_env::openable_target`). Replaces the old "open this file manually" notice.
#[tauri::command]
pub async fn plugin_open_path(
    path: String,
    reveal: bool,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let ctx = trusted_ctx(&webview, &app)?;
    let target = blocking(move || {
        plugin_env::openable_target(&path, &ctx.root, &plugin_env::claude_dirs())
            .map_err(AppError::InvalidPath)
    })
    .await?;
    if plugin_env::e2e_open_log(&format!(
        "path\t{}\t{}",
        if reveal { "reveal" } else { "open" },
        target.display()
    )) {
        return Ok(());
    }
    let opener = app.opener();
    if reveal {
        opener
            .reveal_item_in_dir(&target)
            .map_err(|e| io(e.to_string()))
    } else {
        opener
            .open_path(target.to_string_lossy(), None::<&str>)
            .map_err(|e| io(e.to_string()))
    }
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
    #[test]
    fn secret_names_follow_the_obsidian_rule() {
        assert!(super::is_valid_secret_name("openai-key-2"));
        assert!(!super::is_valid_secret_name(""));
        assert!(!super::is_valid_secret_name("Upper"));
        assert!(!super::is_valid_secret_name("has space"));
        assert!(!super::is_valid_secret_name("under_score"));
        assert!(!super::is_valid_secret_name(&"a".repeat(257)));
    }

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
