//! Tauri commands of the agent pane's process runner (spec section 11, lane 1): thin glue that
//! resolves the calling window and its trusted vault, then calls `agent::session::AgentSessions`.
//! Project and chat-store commands live in `projects.rs` / `chats.rs`.
//!
//! Failure policy. Bad input (not a uuid, a context path outside the vault, a chat that belongs
//! to another window, a restricted vault) is an `Err`. Failures to START the CLI (binary not
//! found, consent denied, spawn failed, too many processes) are `error` events of the chat, so
//! the pane's error cards have one source; `agent_start` / `agent_send` return `Ok` for them.

use crate::agent::binary::{self, AgentBinaryInfo};
use crate::agent::events::*;
use crate::agent::ports::InjectAgentsMd;
use crate::agent::session::{AgentSessions, Rejected, Sink, StartParams, StartedIds};
use crate::commands::blocking;
use crate::commands::plugins::{consent_store, dialog_consent, trusted_root, vault_still_trusted};
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, Runtime};

fn rejected(r: Rejected) -> AppError {
    AppError::InvalidPath(r.0)
}

fn sink_for<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Sink {
    let app = app.clone();
    let label = label.to_string();
    Arc::new(move |env| {
        // the window may be gone; the ring still holds the event for `agent_snapshot`
        let _ = app.emit_to(label.as_str(), AGENT_EVENT_CHANNEL, env);
    })
}

/// `agent.inject-agents-md`; the key is added to the schema by the settings lane, a missing key
/// (or any unknown value) is `auto`.
fn inject_setting<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> InjectAgentsMd {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    InjectAgentsMd::parse(
        guard
            .as_ref()
            .and_then(|s| s.get("agent.inject-agents-md"))
            .and_then(|v| v.as_str()),
    )
}

fn sessions<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::State<'_, AgentSessions> {
    app.state::<AgentSessions>()
}

/// `{ binaryOverride?: string | null }` -> where `claude` is and its version. Without an override
/// the `agent.binary-path` setting is used.
#[tauri::command]
#[specta::specta]
pub async fn agent_detect_binary<R: Runtime>(
    binary_override: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<AgentBinaryInfo, AppError> {
    let override_path = binary_override.or_else(|| {
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
#[specta::specta]
pub async fn agent_start<R: Runtime>(
    chat_id: ChatId,
    project_path: Option<String>,
    resume_session_id: Option<String>,
    settings: AgentSettings,
    append_system_prompt: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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
#[specta::specta]
pub async fn agent_send<R: Runtime>(
    chat_id: ChatId,
    message_id: MessageId,
    text: String,
    context: Vec<ContextRef>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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
#[specta::specta]
pub async fn agent_cancel<R: Runtime>(
    chat_id: ChatId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app).cancel(&label, &chat_id).map_err(rejected)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_permission<R: Runtime>(
    chat_id: ChatId,
    request_id: PermissionRequestId,
    decision: PermissionDecision,
    persist: Option<PermissionPersist>,
    message: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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
#[specta::specta]
pub async fn agent_set_permission_mode<R: Runtime>(
    chat_id: ChatId,
    mode: AgentPermissionMode,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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
#[specta::specta]
pub async fn agent_set_model<R: Runtime>(
    chat_id: ChatId,
    model: Option<String>,
    effort: Option<Effort>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)
            .set_model(&label, &chat_id, model, effort)
            .map_err(rejected)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_close<R: Runtime>(
    chat_id: ChatId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app).close(&label, &chat_id).map_err(rejected)).await
}

/// Rebind an open chat to another CLI session; the next spawn `--resume`s it. (Opening a saved
/// chat normally passes `resumeSessionId` to `agent_start` instead.)
#[tauri::command]
#[specta::specta]
pub async fn agent_resume<R: Runtime>(
    chat_id: ChatId,
    session_id: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)
            .resume(&label, &chat_id, &session_id)
            .map_err(rejected)
    })
    .await
}

#[derive(Serialize, specta::Type)]
pub struct SnapshotReply {
    pub state: AgentSessionState,
    pub events: Vec<AgentEventEnvelope>,
}

/// Events with `seq > afterSeq` still in the ring (the last 2,000), plus the current state.
#[tauri::command]
#[specta::specta]
pub async fn agent_snapshot<R: Runtime>(
    chat_id: ChatId,
    after_seq: u64,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<SnapshotReply, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let (state, events) = sessions(&app).snapshot(&label, &chat_id, after_seq);
        Ok(SnapshotReply { state, events })
    })
    .await
}

/// The diffs of one finished turn, or `null` when the in-memory snapshot is gone (the app was
/// restarted, or the turn was dropped to stay under the memory cap). Spec "Turn changes".
#[tauri::command]
#[specta::specta]
pub async fn agent_turn_changes<R: Runtime>(
    chat_id: ChatId,
    turn_id: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<TurnChanges>, AppError> {
    let root = trusted_root(&webview, &app)?;
    blocking(move || Ok(sessions(&app).changes().detail(&chat_id, &turn_id, &root))).await
}

/// Undo: restore the pre-turn content of `paths`. One outcome per path; a file that changed since
/// the turn ended is refused, never overwritten. `null` when the snapshot is gone.
#[tauri::command]
#[specta::specta]
pub async fn agent_revert_changes<R: Runtime>(
    chat_id: ChatId,
    turn_id: String,
    paths: Vec<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<Vec<RevertOutcome>>, AppError> {
    let root = trusted_root(&webview, &app)?;
    blocking(move || {
        Ok(sessions(&app)
            .changes()
            .revert(&chat_id, &turn_id, &root, &paths))
    })
    .await
}
