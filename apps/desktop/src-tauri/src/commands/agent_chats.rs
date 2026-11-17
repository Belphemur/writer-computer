//! Tauri glue for chat history and the persisted permission rules (spec
//! `SPECs/native-agent-spec.md` sections 6.3, 9, 11). The logic lives in `agent/chat_store.rs`
//! and `agent/permission_rules.rs` (Tauri-free); this file resolves the window's workspace root,
//! maps errors and runs the IO through `blocking`. Never logs titles or note text.

use super::blocking;
use crate::agent::chat_store::{
    self, ChatAction, ChatStoreError, ListOptions, ListScope, ReplaySeed,
};
use crate::agent::events::ChatSummary;
use crate::agent::permission_rules::{self, PermissionRules};
use crate::error::AppError;
use crate::state::AppState;
use crate::vault_ops::VaultOpError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

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

/// The window's workspace root, canonical (the store requires it).
fn root_of(app: &tauri::AppHandle, webview: &tauri::Webview) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    root.canonicalize().map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn agent_list_chats(
    project_path: Option<String>,
    include_archived: Option<bool>,
    all: Option<bool>,
    query: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedChat {
    pub summary: ChatSummary,
    pub markdown: String,
}

#[tauri::command]
pub async fn agent_load_chat(
    chat_id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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
pub async fn agent_save_chat(
    chat_id: String,
    markdown: String,
    title_hint: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ChatSummary, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        chat_store::save(&root, &chat_id, &markdown, title_hint.as_deref()).map_err(store_err)
    })
    .await
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatActionName {
    Rename,
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
pub async fn agent_chat_action(
    chat_id: String,
    action: ChatActionName,
    title: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<ChatSummary>, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        chat_store::action(&root, &chat_id, action.into(), title.as_deref(), false)
            .map_err(store_err)
    })
    .await
}

/// The capped replay text for a new CLI session when the old one is gone (spec section 9).
/// Not in `AgentCommandMap` of the contract; added for the runner/store glue.
#[tauri::command]
pub async fn agent_chat_replay(
    chat_id: String,
    max_tokens: Option<usize>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
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

#[tauri::command]
pub async fn agent_permission_rules(
    project_path: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<PermissionRules, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        permission_rules::read_rules(&root, project_path.as_deref()).map_err(vault_err)
    })
    .await
}

#[tauri::command]
pub async fn agent_remove_permission_rule(
    project_path: Option<String>,
    rule: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        permission_rules::remove_rule(&root, project_path.as_deref(), &rule).map_err(vault_err)
    })
    .await
}
