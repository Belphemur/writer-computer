//! Tauri glue of the CLI-to-app socket (`ipc/`, ADR 2026-11-18): the [`Host`] over the app's
//! windows and features, starting and stopping the server, and the two commands the web half
//! uses to answer (`ipc_ready`, `ipc_reply`). Logic lives in `ipc/`; nothing here parses a
//! request or touches the socket.

use crate::commands::blocking;
use crate::error::AppError;
use crate::features;
use crate::ipc::bridge::WindowBridge;
use crate::ipc::host::BoxFuture;
use crate::ipc::protocol::{ErrorCode, IpcError};
use crate::ipc::server::{self, ServerHandle};
use crate::ipc::{Host, Registry};
use crate::state::AppState;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// The event a window listens to for requests: `{ id, topic, payload }`.
const REQUEST_EVENT: &str = "ipc:request";

/// The running server, managed so `RunEvent::Exit` can stop it.
pub struct IpcServer(Mutex<Option<ServerHandle>>);

struct TauriHost {
    app: AppHandle,
}

impl TauriHost {
    fn label_of(&self, root: &Path) -> Result<String, IpcError> {
        self.app
            .state::<AppState>()
            .find_by_workspace(root)
            .ok_or_else(|| {
                IpcError::new(ErrorCode::VaultNotOpen, "that vault is not open in Writer")
            })
    }
}

impl Host for TauriHost {
    fn app_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn open_vaults(&self) -> Vec<PathBuf> {
        let state = self.app.state::<AppState>();
        let mut roots: Vec<PathBuf> = state
            .labels()
            .iter()
            .filter_map(|label| state.get(label))
            .filter_map(|window| window.workspace_root.read().clone())
            .collect();
        roots.sort();
        roots.dedup();
        roots
    }

    fn feature_live(&self, id: &str) -> bool {
        features::is_live_id(&self.app, id)
    }

    fn command_panicked(&self, feature: Option<&'static str>) {
        if let Some(id) = feature {
            features::fail_ipc_command(&self.app, id);
        }
    }

    fn open_vault_window<'a>(
        &'a self,
        root: &'a Path,
        focus: bool,
    ) -> BoxFuture<'a, Result<(), IpcError>> {
        Box::pin(async move {
            let app = self.app.clone();
            let root = root.to_path_buf();
            blocking(move || {
                let existing = app.state::<AppState>().find_by_workspace(&root);
                match existing {
                    Some(label) => {
                        if focus {
                            if let Some(window) = app.get_webview_window(&label) {
                                crate::reveal_window(&window);
                            }
                        }
                        Ok(())
                    }
                    // The same path a second `writer <folder>` takes: a new window that
                    // opens the vault from its startup payload.
                    None => crate::open_new_workspace_window(
                        &app,
                        root.to_string_lossy().into_owned(),
                        None,
                    ),
                }
            })
            .await
            .map_err(|e| IpcError::new(ErrorCode::Unavailable, e.to_string()))
        })
    }

    fn ask_window<'a>(
        &'a self,
        root: &'a Path,
        topic: &'a str,
        payload: Value,
    ) -> BoxFuture<'a, Result<Value, IpcError>> {
        Box::pin(async move {
            // The window may have been created a moment ago (`open_vault_window`): resolve its
            // label now, then wait for it to be ready.
            let label = self.label_of(root)?;
            let bridge = self.app.state::<WindowBridge>();
            bridge
                .ask(&label, topic, payload, |id, topic, payload| {
                    self.app
                        .emit_to(
                            label.as_str(),
                            REQUEST_EVENT,
                            json!({ "id": id, "topic": topic, "payload": payload }),
                        )
                        .map_err(|e| e.to_string())
                })
                .await
        })
    }
}

/// Start the socket for this launch. Called from `setup` after the features are installed (their
/// commands are part of the registry). The endpoint work touches the disk, so it runs on the
/// blocking pool; a launch that cannot make the endpoint safe runs without the socket and says
/// why in the log (never a path).
pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        log::warn!("the CLI socket is off for this launch: no app data directory");
        return;
    };
    let registry = Registry::new(features::running_ipc_commands(app));
    let host: Arc<dyn Host> = Arc::new(TauriHost { app: app.clone() });
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let rt = tauri::async_runtime::handle();
        match server::start(rt.inner(), &dir, registry, host) {
            Ok(handle) => {
                app.manage(IpcServer(Mutex::new(Some(handle))));
                log::info!("the CLI socket is listening");
            }
            Err(e) => log::warn!("the CLI socket is off for this launch: {e}"),
        }
    });
}

/// `RunEvent::Exit`: close the listener and remove the socket and token.
pub fn stop(app: &AppHandle) {
    if let Some(server) = app.try_state::<IpcServer>() {
        if let Some(handle) = server.0.lock().take() {
            handle.stop();
        }
    }
}

/// A window was destroyed: forget its readiness and fail what it still owed.
pub fn window_gone(app: &AppHandle, label: &str) {
    if let Some(bridge) = app.try_state::<WindowBridge>() {
        bridge.forget(label);
    }
}

/// The window's web half is listening for `ipc:request` (its startup has resolved).
#[tauri::command]
pub async fn ipc_ready(
    window: WebviewWindow,
    bridge: tauri::State<'_, WindowBridge>,
) -> Result<(), AppError> {
    bridge.mark_ready(window.label());
    Ok(())
}

/// The window's answer to an `ipc:request`: `result` when it worked, `error` (a short message)
/// when it did not. Only the window that was asked is heard.
#[tauri::command]
pub async fn ipc_reply(
    window: WebviewWindow,
    bridge: tauri::State<'_, WindowBridge>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), AppError> {
    let answer = match error {
        Some(message) => Err(IpcError::new(ErrorCode::Internal, message)),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    bridge.reply(window.label(), &id, answer);
    Ok(())
}
