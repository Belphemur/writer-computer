//! The MCP servers menu's commands (ADR 2026-11-24, spec `SPECs/native-agent-spec.md` 7.1): thin
//! glue over the neutral core (`agent::mcp_menu`) and the backend's `BackendOps`. The window's
//! vault root comes from the window, never from the UI; the lists are read by the program (or the
//! server) itself, so Writer reads no config file and keeps names and states only.

use super::super::sessions;
use super::root_of;
use crate::agent::backend::{Backend, HelperCtx};
use crate::agent::mcp_menu::{McpMenu, Snapshot, Switches};
use crate::agent::session::{AgentSessions, Rejected};
use crate::commands::blocking;
use crate::config;
use crate::error::AppError;
use std::path::Path;
use tauri::{Runtime, Webview};

fn rejected(r: Rejected) -> AppError {
    AppError::InvalidPath(r.0)
}

/// Runs `f` where the backend's program runs for window `label`'s vault; `None` when the program
/// is not found.
fn with_ctx<R: Runtime, T>(
    app: &tauri::AppHandle<R>,
    sessions: &AgentSessions,
    backend: &Backend,
    label: &str,
    root: &Path,
    f: impl FnOnce(&HelperCtx<'_>) -> T,
) -> Option<T> {
    let override_path = config::global_string(app, label, backend.ops().binary_setting());
    let program = backend.ops().find(override_path.as_deref())?;
    let spawner = sessions.spawner();
    Some(f(&HelperCtx {
        spawner: &spawner,
        program: &program,
        cwd: root,
        label,
        root,
    }))
}

/// The menu: the backend's rows over what is known (`refresh`: read the list now, one read at a
/// time per backend and vault; otherwise only what the chats and earlier reads have seen). `None`
/// for a backend with no switches (no menu).
#[tauri::command]
#[specta::specta]
pub async fn agent_mcp_servers<R: Runtime>(
    backend: Option<String>,
    refresh: bool,
    webview: Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<McpMenu>, AppError> {
    let root = root_of(&app, &webview)?;
    let label = webview.label().to_string();
    blocking(move || {
        let sessions = sessions(&app)?;
        let backend = sessions.backend_for(backend.as_deref()).map_err(rejected)?;
        let Some(spec) = backend.ops().mcp_switches() else {
            return Ok(None);
        };
        let probe = sessions.probe();
        let snap: Snapshot = if refresh {
            sessions.mcp().refresh(backend.id, &root, || {
                with_ctx(&app, &sessions, &backend, &label, &root, |ctx| {
                    backend.ops().mcp_list(ctx, &*probe)
                })
                .unwrap_or_else(|| Err("program not found".into()))
            })
        } else {
            sessions.mcp().snapshot(backend.id, &root)
        };
        let switches = Switches::new(&spec, config::global_list(&app, &label, spec.setting));
        log::debug!(target: "agent", "agent: mcp menu, {} servers", snap.servers.len());
        Ok(Some(McpMenu::build(backend.id, &spec, &switches, &snap)))
    })
    .await
}

/// A switch changed (the web wrote the backend's setting first): the backend puts it in force
/// where it must, then the backend's chats are marked stale, so they restart under
/// `agent.auto-reload`.
#[tauri::command]
#[specta::specta]
pub async fn agent_mcp_apply<R: Runtime>(
    backend: Option<String>,
    webview: Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let root = root_of(&app, &webview)?;
    let label = webview.label().to_string();
    blocking(move || {
        let sessions = sessions(&app)?;
        let backend = sessions.backend_for(backend.as_deref()).map_err(rejected)?;
        if backend.ops().mcp_switches().is_none() {
            return Ok(());
        }
        if let Some(applied) = with_ctx(&app, &sessions, &backend, &label, &root, |ctx| {
            backend.ops().mcp_apply(ctx)
        }) {
            applied.map_err(AppError::Io)?;
        }
        sessions.mcp_switched(backend.id);
        Ok(())
    })
    .await
}
