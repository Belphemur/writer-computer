//! Tauri glue for chat history and the persisted permission rules (spec
//! `SPECs/native-agent-spec.md` sections 6.3, 9, 11). The logic lives in `agent/chat_store.rs`
//! and `agent/permission_rules.rs` (Tauri-free); this file resolves the window's workspace root,
//! maps errors and runs the IO through `blocking`. Never logs titles or note text.

use super::root_of;
use crate::agent::binary;
use crate::agent::chat_store::{
    self, ChatAction, ChatStoreError, ListOptions, ListScope, ReplaySeed,
};
use crate::agent::events::ChatSummary;
use crate::agent::images::{self, ChatImage};
use crate::agent::permission_rules::{self, PermissionRules};
use crate::agent::session::AgentSessions;
use crate::agent::title;
use crate::commands::blocking;
use crate::error::AppError;
use crate::state::AppState;
use crate::vault_ops::VaultOpError;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};

fn store_err(e: ChatStoreError) -> AppError {
    match e {
        ChatStoreError::Invalid(m) => AppError::InvalidPath(m),
        ChatStoreError::NotFound(m) => AppError::NotFound(m),
        ChatStoreError::Io(m) => AppError::Io(m),
    }
}

fn vault_err(e: VaultOpError) -> AppError {
    store_err(e.into())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_list_chats<R: Runtime>(
    project_path: Option<String>,
    include_archived: Option<bool>,
    all: Option<bool>,
    query: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<ChatSummary>, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let scope = if all.unwrap_or(false) {
            ListScope::All
        } else {
            ListScope::Project(project_path)
        };
        chat_store::list(
            &root,
            &ListOptions {
                scope,
                include_archived: include_archived.unwrap_or(false),
                query,
            },
        )
        .map_err(store_err)
    })
    .await
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadedChat {
    pub summary: ChatSummary,
    pub markdown: String,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_load_chat<R: Runtime>(
    chat_id: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<LoadedChat, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        chat_store::load(&root, &chat_id)
            .map(|(summary, markdown)| LoadedChat { summary, markdown })
            .map_err(store_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_save_chat<R: Runtime>(
    chat_id: String,
    markdown: String,
    title_hint: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ChatSummary, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        chat_store::save(&root, &chat_id, &markdown, title_hint.as_deref()).map_err(store_err)
    })
    .await
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ChatActionName {
    Rename,
    AutoTitle,
    Pin,
    Unpin,
    Archive,
    Unarchive,
    Delete,
}

impl From<ChatActionName> for ChatAction {
    fn from(a: ChatActionName) -> Self {
        match a {
            ChatActionName::Rename => ChatAction::Rename,
            ChatActionName::AutoTitle => ChatAction::AutoTitle,
            ChatActionName::Pin => ChatAction::Pin,
            ChatActionName::Unpin => ChatAction::Unpin,
            ChatActionName::Archive => ChatAction::Archive,
            ChatActionName::Unarchive => ChatAction::Unarchive,
            ChatActionName::Delete => ChatAction::Delete,
        }
    }
}

/// Rename, pin, archive and delete (to the system Trash). `None` after a delete.
#[tauri::command]
#[specta::specta]
pub async fn agent_chat_action<R: Runtime>(
    chat_id: String,
    action: ChatActionName,
    title: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<ChatSummary>, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        chat_store::action(&root, &chat_id, action.into(), title.as_deref(), false)
            .map_err(store_err)
    })
    .await
}

/// Automatic chat title (spec "Automatic chat titles"): one small `claude -p` call for a title,
/// applied through the chat store only while the user has not renamed the chat. Never an error
/// for the user: no live session, a failed call or a refused title all answer `None` and the
/// placeholder title stays. The note must already be saved (the pane flushes first): the title
/// input is read from it, exactly as for "Regenerate title".
#[tauri::command]
#[specta::specta]
pub async fn agent_auto_title<R: Runtime>(
    chat_id: String,
    title_model: Option<String>,
    chat_model: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Option<ChatSummary>, AppError> {
    let root = root_of(&app, &webview)?;
    let label = webview.label().to_string();
    blocking(move || {
        let Some((program, cwd)) = app
            .state::<AgentSessions>()
            .get(&label, &chat_id)
            .ok()
            .and_then(|s| s.helper_target())
        else {
            log::debug!(target: "agent", "agent: no title call (no live session)");
            return Ok(None);
        };
        // a failed call or an apply failure (the note is gone, a lock error) is quiet
        Ok(title::title_chat(
            &root,
            &chat_id,
            &program,
            &cwd,
            title_model.as_deref(),
            chat_model.as_deref(),
            ChatAction::AutoTitle,
        )
        .inspect_err(|_| log::debug!(target: "agent", "agent: no automatic title applied"))
        .ok())
    })
    .await
}

/// Why "Regenerate title" did nothing; the history list words each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RegenerateRefusal {
    /// No `claude` program was found.
    NoBinary,
    /// The chat has no assistant reply yet.
    NoReply,
    /// The call failed or answered junk; the old title stays.
    Failed,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum RegenerateOutcome {
    Done { summary: ChatSummary },
    Refused { reason: RegenerateRefusal },
}

/// "Regenerate title" for ANY chat of the vault, open or not (spec "Automatic chat titles"): the
/// same title input and call as the automatic title, applied as `RegenerateTitle` (the user asked,
/// so it replaces even their own title and leaves an automatic one). Needs no live session of the
/// chat: it runs the `claude` program `binary::find` locates. For an open chat the pane flushes
/// its pending save first (the note is the input).
#[tauri::command]
#[specta::specta]
pub async fn agent_regenerate_title<R: Runtime>(
    chat_id: String,
    title_model: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<RegenerateOutcome, AppError> {
    let root = root_of(&app, &webview)?;
    let label = webview.label().to_string();
    let override_path = {
        let state = app.state::<AppState>().get_or_create(&label);
        let guard = state.settings.read();
        guard
            .as_ref()
            .and_then(|s| s.get("agent.binary-path"))
            .and_then(|v| v.as_str().map(str::to_string))
    };
    blocking(move || {
        let sessions = app.state::<AgentSessions>();
        let (summary, _) = chat_store::load(&root, &chat_id).map_err(store_err)?;
        let cwd = sessions
            .ports()
            .project()
            .resolve_cwd(&root, summary.project_path.as_deref())
            .map_err(AppError::InvalidPath)?;
        let Some(program) = binary::find(override_path.as_deref()) else {
            return Ok(RegenerateOutcome::Refused {
                reason: RegenerateRefusal::NoBinary,
            });
        };
        Ok(
            match title::title_chat(
                &root,
                &chat_id,
                &program,
                &cwd,
                title_model.as_deref(),
                None,
                ChatAction::RegenerateTitle,
            ) {
                Ok(summary) => RegenerateOutcome::Done { summary },
                Err(title::TitleError::NoReply) => RegenerateOutcome::Refused {
                    reason: RegenerateRefusal::NoReply,
                },
                Err(title::TitleError::Failed) => RegenerateOutcome::Refused {
                    reason: RegenerateRefusal::Failed,
                },
                Err(title::TitleError::Store(e)) => return Err(store_err(e)),
            },
        )
    })
    .await
}

/// The capped replay text for a new CLI session when the old one is gone (spec section 9).
/// Not in `AgentCommandMap` of the contract; added for the runner/store glue.
#[tauri::command]
#[specta::specta]
pub async fn agent_chat_replay<R: Runtime>(
    chat_id: String,
    max_tokens: Option<usize>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ReplaySeed, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let (_, markdown) = chat_store::load(&root, &chat_id).map_err(store_err)?;
        Ok(chat_store::replay_seed(
            &markdown,
            max_tokens.unwrap_or(chat_store::DEFAULT_REPLAY_TOKENS),
        ))
    })
    .await
}

/// Saves a pasted or browser-dropped image (bytes as base64) into the chat's hidden `assets/`
/// folder; the composer then attaches the returned path (spec "Images in the composer").
#[tauri::command]
#[specta::specta]
pub async fn agent_save_chat_image<R: Runtime>(
    project_path: Option<String>,
    name: String,
    data_base64: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ChatImage, AppError> {
    use base64::Engine as _;
    let root = root_of(&app, &webview)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| AppError::InvalidPath("the image data is not valid base64".into()))?;
    blocking(move || {
        images::save_bytes(&root, project_path.as_deref(), &name, &bytes)
            .map(ChatImage::from)
            .map_err(AppError::InvalidPath)
    })
    .await
}

/// Copies an image file dropped from Finder (absolute path) into the chat's `assets/` folder.
#[tauri::command]
#[specta::specta]
pub async fn agent_import_chat_image_file<R: Runtime>(
    project_path: Option<String>,
    source_path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ChatImage, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        images::import_file(
            &root,
            project_path.as_deref(),
            std::path::Path::new(&source_path),
        )
        .map(ChatImage::from)
        .map_err(AppError::InvalidPath)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_permission_rules<R: Runtime>(
    project_path: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<PermissionRules, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        permission_rules::read_rules(&root, project_path.as_deref()).map_err(vault_err)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_remove_permission_rule<R: Runtime>(
    project_path: Option<String>,
    rule: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        permission_rules::remove_rule(&root, project_path.as_deref(), &rule).map_err(vault_err)
    })
    .await
}
