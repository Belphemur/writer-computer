//! Tauri commands of the agent pane's process runner (spec section 11, lane 1): thin glue that
//! resolves the calling window and its vault, then calls `agent::session::AgentSessions`.
//! Project and chat-store commands live in `projects.rs` / `chats.rs`.
//!
//! Failure policy. Bad input (not a uuid, a context path outside the vault, a chat that belongs
//! to another window) is an `Err`. Failures to START the CLI (binary not found, spawn failed,
//! too many processes) are `error` events of the chat, so
//! the pane's error cards have one source; `agent_start` / `agent_send` return `Ok` for them.

use super::super::sessions;
use super::root_of;
use crate::agent::binary::{self, AgentBinaryInfo};
use crate::agent::cli_launcher;
use crate::agent::events::*;
use crate::agent::ports::InjectAgentsMd;
use crate::agent::session::{Rejected, Sink, StartParams, StartedIds};
use crate::commands::blocking;
use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
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
    InjectAgentsMd::parse(
        crate::config::global_string(app, label, "agent.inject-agents-md").as_deref(),
    )
}

/// The directory holding the `writer` launcher (`agent::cli_launcher::shared_dir`). Blocking:
/// file IO.
fn launcher_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| cli_launcher::shared_dir(&d))
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
    let override_path = binary_override
        .or_else(|| crate::config::global_string(&app, webview.label(), "agent.binary-path"));
    let spawner = super::super::sessions(&app)?.spawner();
    blocking(move || Ok(binary::detect(&spawner, override_path.as_deref()))).await
}

// the chat, its project, resume id, settings, system prompt and backend, then the two handles
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub async fn agent_start<R: Runtime>(
    chat_id: ChatId,
    project_path: Option<String>,
    resume_session_id: Option<String>,
    settings: AgentSettings,
    append_system_prompt: Option<String>,
    backend: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<StartedIds, AppError> {
    let root = root_of(&app, &webview)?;
    let label = webview.label().to_string();
    let params = StartParams {
        label: label.clone(),
        root: root.clone(),
        request: StartSessionRequest {
            chat_id,
            project_path,
            resume_session_id,
            settings,
            append_system_prompt,
            backend,
        },
        inject_agents_md: inject_setting(&app, &label),
        cli_dir: None,
        sink: sink_for(&app, &label),
    };
    blocking(move || {
        let params = StartParams {
            cli_dir: launcher_dir(&app),
            ..params
        };
        sessions(&app)?.start(params).map_err(rejected)
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
    root_of(&app, &webview)?;
    let label = webview.label().to_string();
    // `message_id` is the UI's key for the optimistic card; the CLI has no use for it
    let _ = message_id;
    blocking(move || {
        sessions(&app)?
            .send(&label, &chat_id, text, &context)
            .map_err(rejected)
    })
    .await
}

/// A steer: like `agent_send`, but forced into the running turn at once (`priority:"now"`: the
/// running tool or text is aborted) instead of queued after it (spec 3.13). `message_id` is the
/// receipt id the CLI echoes. With no running turn it is an ordinary send.
#[tauri::command]
#[specta::specta]
pub async fn agent_steer<R: Runtime>(
    chat_id: ChatId,
    message_id: MessageId,
    text: String,
    context: Vec<ContextRef>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    root_of(&app, &webview)?;
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)?
            .steer(&label, &chat_id, &message_id, text, &context)
            .map_err(rejected)
    })
    .await
}

/// A message sent with Enter while a turn runs: written to the CLI at once as a plain line, which
/// it injects after the next tool result or runs after the turn (spec 3.13). `message_id` is the
/// receipt id the CLI echoes (`message-received`). Where no turn can take it, an ordinary send.
#[tauri::command]
#[specta::specta]
pub async fn agent_queue<R: Runtime>(
    chat_id: ChatId,
    message_id: MessageId,
    text: String,
    context: Vec<ContextRef>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    root_of(&app, &webview)?;
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)?
            .queue_line(&label, &chat_id, &message_id, text, &context)
            .map_err(rejected)
    })
    .await
}

/// Takes a message written by `agent_queue` back before the CLI took it: `true` when it was still
/// waiting and will never run, `false` when the CLI already took it.
#[tauri::command]
#[specta::specta]
pub async fn agent_unqueue<R: Runtime>(
    chat_id: ChatId,
    message_id: MessageId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<bool, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)?
            .unqueue(&label, &chat_id, &message_id)
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
    blocking(move || sessions(&app)?.cancel(&label, &chat_id).map_err(rejected)).await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // the IPC command's flat arguments
pub async fn agent_permission<R: Runtime>(
    chat_id: ChatId,
    request_id: PermissionRequestId,
    decision: PermissionDecision,
    persist: Option<PermissionPersist>,
    rules: Option<Vec<String>>,
    message: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)?
            .permission(
                &label,
                &chat_id,
                &request_id,
                decision,
                persist,
                rules,
                message,
            )
            .map_err(rejected)
    })
    .await
}

/// Answers an open question card; `answers` `None` declines it.
#[tauri::command]
#[specta::specta]
pub async fn agent_answer_question<R: Runtime>(
    chat_id: ChatId,
    request_id: PermissionRequestId,
    answers: Option<Vec<QuestionAnswer>>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        sessions(&app)?
            .answer_question(&label, &chat_id, &request_id, answers)
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
        sessions(&app)?
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
        sessions(&app)?
            .set_model(&label, &chat_id, model, effort)
            .map_err(rejected)
    })
    .await
}

/// "Reload session": restart an idle chat's process with `--resume` so it re-reads skills, MCP
/// servers and settings. `busy` (nothing done) while a turn or a permission card is open.
#[tauri::command]
#[specta::specta]
pub async fn agent_reload<R: Runtime>(
    chat_id: ChatId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ReloadOutcome, AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app)?.reload(&label, &chat_id).map_err(rejected)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_close<R: Runtime>(
    chat_id: ChatId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    blocking(move || sessions(&app)?.close(&label, &chat_id).map_err(rejected)).await
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
        sessions(&app)?
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
        let (state, events) = sessions(&app)?.snapshot(&label, &chat_id, after_seq);
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
    let root = root_of(&app, &webview)?;
    blocking(move || Ok(sessions(&app)?.changes().detail(&chat_id, &turn_id, &root))).await
}

/// The chat's session diff: every note it changed against its first-touch version since Writer
/// started (`null`: the chat has touched no file since). Spec "Turn changes".
#[tauri::command]
#[specta::specta]
pub async fn agent_session_changes<R: Runtime>(
    chat_id: ChatId,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<SessionChanges>, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || Ok(sessions(&app)?.changes().session_detail(&chat_id, &root))).await
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
    let root = root_of(&app, &webview)?;
    blocking(move || {
        Ok(sessions(&app)?
            .changes()
            .revert(&chat_id, &turn_id, &root, &paths))
    })
    .await
}
