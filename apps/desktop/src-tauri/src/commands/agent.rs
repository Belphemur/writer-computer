//! Tauri commands of the agent pane's process runner (spec section 11, lane 1): thin glue that
//! resolves the calling window and its trusted vault, then calls `agent::session::AgentSessions`.
//! Project and chat-store commands live in `agent_projects.rs` / `agent_chats.rs`.
//!
//! Failure policy. Bad input (not a uuid, a context path outside the vault, a chat that belongs
//! to another window, a restricted vault) is an `Err`. Failures to START the CLI (binary not
//! found, consent denied, spawn failed, too many processes) are `error` events of the chat, so
//! the pane's error cards have one source; `agent_start` / `agent_send` return `Ok` for them.

use super::blocking;
use super::plugins::{consent_store, dialog_consent, trusted_root, vault_still_trusted};
use crate::agent::binary::{self, AgentBinaryInfo};
use crate::agent::events::*;
use crate::agent::ports::InjectAgentsMd;
use crate::agent::session::{AgentSessions, Rejected, Sink, StartParams, StartedIds};
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager};

fn rejected(r: Rejected) -> AppError {
    AppError::InvalidPath(r.0)
}

fn sink_for(app: &tauri::AppHandle, label: &str) -> Sink {
    let app = app.clone();
    let label = label.to_string();
    Arc::new(move |env| {
        // the window may be gone; the ring still holds the event for `agent_snapshot`
        let _ = app.emit_to(label.as_str(), AGENT_EVENT_CHANNEL, env);
    })
}

/// `agent.inject-agents-md`; the key is added to the schema by the settings lane, a missing key
/// (or any unknown value) is `auto`.
fn inject_setting(app: &tauri::AppHandle, label: &str) -> InjectAgentsMd {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    InjectAgentsMd::parse(
        guard
            .as_ref()
            .and_then(|s| s.get("agent.inject-agents-md"))
            .and_then(|v| v.as_str()),
    )
}

fn sessions(app: &tauri::AppHandle) -> tauri::State<'_, AgentSessions> {
    app.state::<AgentSessions>()
}

/// `{ override?: string | null }` -> where `claude` is and its version. The argument is named
/// `override`, a Rust keyword, so the JSON body is read directly.
#[tauri::command]
pub async fn agent_detect_binary(
    request: tauri::ipc::Request<'_>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<AgentBinaryInfo, AppError> {
    let from_arg = match request.body() {
        tauri::ipc::InvokeBody::Json(v) => v
            .get("override")
            .and_then(|o| o.as_str())
            .map(str::to_string),
        _ => None,
    };
    let override_path = from_arg.or_else(|| {
        let state = app.state::<AppState>().get_or_create(webview.label());
        let guard = state.settings.read();
        guard
            .as_ref()
            .and_then(|s| s.get("agent.binary-path"))
            .and_then(|v| v.as_str().map(str::to_string))
    });
    blocking(move || Ok(binary::detect(override_path.as_deref()))).await
}

#[tauri::command]
pub async fn agent_start(
    chat_id: ChatId,
    project_path: Option<String>,
    resume_session_id: Option<String>,
    settings: AgentSettings,
    append_system_prompt: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<StartedIds, AppError> {
    let root = trusted_root(&webview, &app)?;
    let label = webview.label().to_string();
    let store = consent_store(&app)?;
    let params = StartParams {
        label: label.clone(),
        root: root.clone(),
        request: StartSessionRequest {
            chat_id,
            project_path,
            resume_session_id,
            settings,
            append_system_prompt,
        },
        inject_agents_md: inject_setting(&app, &label),
        store,
        still_ok: {
            let (app, label, root) = (app.clone(), label.clone(), root.clone());
            Arc::new(move || vault_still_trusted(&app, &label, &root))
        },
        sink: sink_for(&app, &label),
    };
    let consent = dialog_consent(app.clone(), webview.window().into());
    blocking(move || {
        app.state::<AgentSessions>()
            .start(params, &consent)
            .map_err(rejected)
    })
    .await
}

#[tauri::command]
pub async fn agent_send(
    chat_id: ChatId,
    message_id: MessageId,
    text: String,
    context: Vec<ContextRef>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    trusted_root(&webview, &app)?;
    let label = webview.label().to_string();
    // `message_id` is the UI's key for the optimistic card; the CLI has no use for it
    let _ = message_id;
    blocking(move || {
        sessions(&app)
            .send(&label, &chat_id, text, &context)
            .map_err(rejected)
    })
    .await
}

#[tauri::command]
pub async fn agent_cancel(
    chat_id: ChatId,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app).cancel(&label, &chat_id).map_err(rejected)).await
}

#[tauri::command]
pub async fn agent_permission(
    chat_id: ChatId,
    request_id: PermissionRequestId,
    decision: PermissionDecision,
    persist: Option<PermissionPersist>,
    message: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)
            .permission(&label, &chat_id, &request_id, decision, persist, message)
            .map_err(rejected)
    })
    .await
}

#[tauri::command]
pub async fn agent_set_permission_mode(
    chat_id: ChatId,
    mode: AgentPermissionMode,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)
            .set_permission_mode(&label, &chat_id, mode)
            .map_err(rejected)
    })
    .await
}

#[tauri::command]
pub async fn agent_close(
    chat_id: ChatId,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app).close(&label, &chat_id).map_err(rejected)).await
}

/// Rebind an open chat to another CLI session; the next spawn `--resume`s it. (Opening a saved
/// chat normally passes `resumeSessionId` to `agent_start` instead.)
#[tauri::command]
pub async fn agent_resume(
    chat_id: ChatId,
    session_id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)
            .resume(&label, &chat_id, &session_id)
            .map_err(rejected)
    })
    .await
}

#[derive(Serialize)]
pub struct SnapshotReply {
    pub state: AgentSessionState,
    pub events: Vec<AgentEventEnvelope>,
}

/// Events with `seq > afterSeq` still in the ring (the last 2,000), plus the current state.
#[tauri::command]
pub async fn agent_snapshot(
    chat_id: ChatId,
    after_seq: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<SnapshotReply, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (state, events) = sessions(&app).snapshot(&label, &chat_id, after_seq);
        Ok(SnapshotReply { state, events })
    })
    .await
}
