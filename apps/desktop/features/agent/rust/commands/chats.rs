//! Tauri glue for chat history and the persisted permission rules (spec
//! `SPECs/native-agent-spec.md` sections 6.3, 9, 11). The logic lives in `agent/chat_store.rs`
//! and `agent/permission_rules.rs` (Tauri-free); this file resolves the window's workspace root,
//! maps errors and runs the IO through `blocking`. Never logs titles or note text.

use super::root_of;
use crate::agent::backend::{ForgetCtx, HelperCtx};
use crate::agent::chat_store::{
    self, ChatAction, ChatStoreError, ListOptions, ListScope, ReplaySeed,
};
use crate::agent::events::ChatSummary;
use crate::agent::files::{self, ChatFile};
use crate::agent::pending_delete;
use crate::agent::permission_rules::{self, PermissionRules};
use crate::agent::title;
use crate::commands::blocking;
use crate::error::AppError;
use crate::features;
use crate::state::AppState;
use crate::vault_ops::VaultOpError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

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
    let label = webview.label().to_string();
    blocking(move || {
        let sessions = super::super::sessions(&app).ok();
        let app_data = app.path().app_data_dir().ok();
        // the backends a feature brings: a feature that extends `agent.backends` is the backend
        // of its own id (the id a chat note names it by)
        let known: Vec<String> = features::registry::<R>()
            .into_iter()
            .filter_map(|f| f.manifest().ok())
            .filter(|m| m.extends.iter().any(|p| p == "agent.backends"))
            .map(|m| m.id)
            .collect();
        chat_action_in(
            sessions.as_deref(),
            (app_data.as_deref(), &known),
            &label,
            &root,
            &chat_id,
            action,
            title.as_deref(),
        )
    })
    .await
}

/// [`agent_chat_action`] without the window: a deleted chat takes its backend's own copy of the
/// session with it (`BackendOps::forget`); archiving, renaming and pinning keep it.
pub(crate) fn chat_action_in(
    sessions: Option<&crate::agent::session::AgentSessions>,
    // where a session that cannot be deleted now is kept, and the backends that may keep one
    pending: (Option<&std::path::Path>, &[String]),
    label: &str,
    root: &std::path::Path,
    chat_id: &str,
    action: ChatActionName,
    title: Option<&str>,
) -> Result<Option<ChatSummary>, AppError> {
    // read before the note goes
    let doomed = matches!(action, ChatActionName::Delete)
        .then(|| session_of(root, chat_id))
        .flatten();
    let done = chat_store::action(root, chat_id, action.into(), title, false).map_err(store_err)?;
    if let Some((backend_id, session_id)) = doomed {
        match sessions.map(|s| s.backend_for(Some(&backend_id))) {
            Some(Ok(backend)) => backend.ops().forget(&ForgetCtx {
                label,
                root,
                session_id: &session_id,
            }),
            // the backend's feature is off: nobody can delete its session now, so the id is kept
            // (core's own file, no feature needed) for the next start of its server for the vault
            _ => {
                if let (Some(dir), known) = pending {
                    pending_delete::record(dir, known, &backend_id, root, &session_id);
                }
            }
        }
    }
    Ok(done)
}

/// The backend and the backend's own session id a chat note holds, `None` for a chat that never
/// ran (nothing to forget) or a note that cannot be read.
fn session_of(root: &std::path::Path, chat_id: &str) -> Option<(String, String)> {
    let (_, markdown) = chat_store::load(root, chat_id).ok()?;
    let meta = chat_store::meta_from_text(&markdown).ok().flatten()?;
    Some((meta.backend?, meta.session_id?))
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
        let sessions = super::super::sessions(&app)?;
        let Some(session) = sessions.get(&label, &chat_id).ok() else {
            log::debug!(target: "agent", "agent: no title call (no live session)");
            return Ok(None);
        };
        let Some((program, cwd)) = session.helper_target() else {
            log::debug!(target: "agent", "agent: no title call (no live session)");
            return Ok(None);
        };
        let spawner = sessions.spawner();
        let Some(asker) = session.backend().ops().titler(&HelperCtx {
            spawner: &spawner,
            program: &program,
            cwd: &cwd,
            label: &label,
            root: &root,
        }) else {
            return Ok(None);
        };
        // a failed call or an apply failure (the note is gone, a lock error) is quiet
        Ok(title::title_chat(
            &*asker,
            &root,
            &chat_id,
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
    /// The chat's program was not found.
    NoBinary,
    /// The chat's agent is switched off (Settings > Features): there is nothing to ask.
    Unavailable,
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
    blocking(move || {
        let sessions = super::super::sessions(&app)?;
        let (summary, markdown) = chat_store::load(&root, &chat_id).map_err(store_err)?;
        let cwd = sessions
            .ports()
            .project()
            .resolve_cwd(&root, summary.project_path.as_deref())
            .map_err(AppError::InvalidPath)?;
        // the chat's own backend writes its title (a backend that is off has no program to run)
        let note_backend = chat_store::meta_from_text(&markdown)
            .ok()
            .flatten()
            .and_then(|m| m.backend);
        let refused = |reason| Ok(RegenerateOutcome::Refused { reason });
        let Ok(backend) = sessions.backend_for(note_backend.as_deref()) else {
            return refused(RegenerateRefusal::Unavailable);
        };
        let override_path = {
            let state = app.state::<AppState>().get_or_create(&label);
            let guard = state.settings.read();
            guard
                .as_ref()
                .and_then(|s| s.get(backend.ops().binary_setting()))
                .and_then(|v| v.as_str().map(str::to_string))
        };
        let Some(program) = backend.ops().find(override_path.as_deref()) else {
            return refused(RegenerateRefusal::NoBinary);
        };
        let spawner = sessions.spawner();
        let Some(asker) = backend.ops().titler(&HelperCtx {
            spawner: &spawner,
            program: &program,
            cwd: &cwd,
            label: &label,
            root: &root,
        }) else {
            return refused(RegenerateRefusal::NoBinary);
        };
        Ok(
            match title::title_chat(
                &*asker,
                &root,
                &chat_id,
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

/// A saved chat image, with the folder it sits in granted to the asset protocol first, so the
/// thumbnail and the image tab can load it (the folder is hidden).
fn served<R: Runtime>(app: &AppHandle<R>, saved: crate::attachments::Saved) -> ChatFile {
    if let Some(dir) = saved.abs_path.parent() {
        crate::commands::workspace::allow_chat_assets_dir(app, dir);
    }
    ChatFile::from(saved)
}

/// Saves a pasted or browser-dropped image (bytes as base64) into the chat's hidden `assets/`
/// folder; the composer then attaches the returned path (spec "Images in the composer").
#[tauri::command]
#[specta::specta]
pub async fn agent_save_chat_file<R: Runtime>(
    project_path: Option<String>,
    name: String,
    data_base64: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ChatFile, AppError> {
    use base64::Engine as _;
    let root = root_of(&app, &webview)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| AppError::InvalidPath("the image data is not valid base64".into()))?;
    blocking(move || {
        files::save_bytes(&root, project_path.as_deref(), &name, &bytes)
            .map(|saved| served(&app, saved))
            .map_err(AppError::InvalidPath)
    })
    .await
}

/// A file or folder dropped from Finder (absolute path), any type: copied into the chat's `assets/`
/// folder, or, already in the vault, returned to be referenced in place (`files::import_path`).
#[tauri::command]
#[specta::specta]
pub async fn agent_import_chat_file<R: Runtime>(
    project_path: Option<String>,
    source_path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<ChatFile, AppError> {
    let root = root_of(&app, &webview)?;
    blocking(move || {
        let file = files::import_path(
            &root,
            project_path.as_deref(),
            std::path::Path::new(&source_path),
        )
        .map_err(AppError::InvalidPath)?;
        if file.copied {
            if let Some(dir) = root.join(&file.path).parent() {
                crate::commands::workspace::allow_chat_assets_dir(&app, dir);
            }
        }
        Ok(file)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::backend::{Backend, BackendOps};
    use crate::agent::binary::AgentBinaryInfo;
    use crate::agent::claude_adapter::ClaudeAdapter;
    use crate::agent::session::{AgentSessions, Timing};
    use crate::agent::title::TitleAsker;
    use crate::agent::transport::{Transport, TransportInit};
    use crate::features::scope::Spawner;
    use parking_lot::Mutex;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    const ID: &str = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";

    /// A backend that only records which sessions it was told to forget.
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl BackendOps for Recorder {
        fn binary_setting(&self) -> &'static str {
            "agent.fake.binary-path"
        }
        fn find(&self, _: Option<&str>) -> Option<PathBuf> {
            None
        }
        fn detect(&self, _: &Spawner, _: Option<&str>) -> AgentBinaryInfo {
            unreachable!("not used by a chat action")
        }
        fn skills_installed(&self, _: &Path) -> bool {
            false
        }
        fn session_id_ok(&self, _: &str) -> bool {
            true
        }
        fn connect(&self, _: TransportInit) -> Result<Arc<dyn Transport>, String> {
            Err("not used".into())
        }
        fn titler<'a>(&self, _: &HelperCtx<'a>) -> Option<Box<dyn TitleAsker + 'a>> {
            None
        }
        fn forget(&self, ctx: &ForgetCtx<'_>) {
            self.0.lock().push(ctx.session_id.to_string());
        }
    }

    fn timing() -> Timing {
        Timing {
            cancel_grace: Duration::from_millis(500),
            close_grace: Duration::from_secs(60),
            term_to_kill: Duration::from_secs(60),
            idle_after: Duration::from_secs(1800),
            reaper_every: Duration::from_secs(60),
            config_debounce: Duration::from_millis(150),
            mcp_backoff: [Duration::from_millis(200); 3],
            mcp_probe_timeout: Duration::from_secs(5),
            steer_ack: Duration::from_millis(400),
            unqueue_ack: Duration::from_millis(1500),
        }
    }

    fn sessions(forgotten: &Arc<Mutex<Vec<String>>>) -> AgentSessions {
        let sessions = AgentSessions::with_timing(timing());
        let log = Arc::clone(forgotten);
        sessions
            .points()
            .provide_raw(&crate::agent::api::BACKENDS, "fake-feature", move |id| {
                (id == "fake").then(|| {
                    Arc::new(Backend::new(
                        "fake",
                        &ClaudeAdapter,
                        Arc::new(Recorder(Arc::clone(&log))),
                    ))
                })
            });
        sessions
    }

    /// The golden chat note, saved in a vault as a chat of the fake backend.
    fn vault_with_chat() -> (tempfile::TempDir, PathBuf) {
        vault_with_chat_of("fake")
    }

    fn vault_with_chat_of(backend: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("Projects/Demo")).unwrap();
        let note = include_str!("../../../../tests/fixtures/agent-chat-notes/basic.md")
            .replace(
                "writer-chat-backend: claude",
                &format!("writer-chat-backend: {backend}"),
            )
            .replace(
                &format!("writer-chat-session-id: {ID}"),
                "writer-chat-session-id: ses_abc123",
            );
        chat_store::save(&root, ID, &note, None).unwrap();
        (dir, root)
    }

    #[test]
    fn deleting_a_chat_has_its_backend_forget_the_session_and_archiving_does_not() {
        let forgotten = Arc::new(Mutex::new(Vec::new()));
        let sessions = sessions(&forgotten);
        let (_dir, root) = vault_with_chat();
        // archive, rename and pin keep the backend's session
        for action in [
            ChatActionName::Archive,
            ChatActionName::Unarchive,
            ChatActionName::Pin,
        ] {
            chat_action_in(
                Some(&sessions),
                (None, &[]),
                "main",
                &root,
                ID,
                action,
                None,
            )
            .unwrap();
        }
        chat_action_in(
            Some(&sessions),
            (None, &[]),
            "main",
            &root,
            ID,
            ChatActionName::Rename,
            Some("Renamed"),
        )
        .unwrap();
        assert!(forgotten.lock().is_empty(), "nothing is forgotten yet");
        // delete: the session the note named is forgotten, once, after the note went
        let done = chat_action_in(
            Some(&sessions),
            (None, &[]),
            "main",
            &root,
            ID,
            ChatActionName::Delete,
            None,
        )
        .unwrap();
        assert!(done.is_none());
        assert_eq!(*forgotten.lock(), ["ses_abc123"]);
        assert!(chat_store::load(&root, ID).is_err());
    }

    #[test]
    fn deleting_a_chat_of_a_backend_that_is_off_deletes_the_note_and_keeps_its_session_to_delete() {
        let (_dir, root) = vault_with_chat();
        let data = tempfile::tempdir().unwrap();
        // no feature answers for "fake": it is off
        let sessions = AgentSessions::with_timing(timing());
        chat_action_in(
            Some(&sessions),
            (Some(data.path()), &["fake".to_string()]),
            "main",
            &root,
            ID,
            ChatActionName::Delete,
            None,
        )
        .unwrap();
        assert!(chat_store::load(&root, ID).is_err());
        // the session id waits for the backend's next server for this vault, outside the vault
        let owed = pending_delete::PendingDeletes::new(data.path().join("fake"))
            .take(&pending_delete::vault_id(&root));
        assert_eq!(owed, ["ses_abc123"]);
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().contains("pending")));
    }

    #[test]
    fn a_chat_note_naming_a_traversal_or_unknown_backend_keeps_nothing() {
        for backend in ["../../escape", "unlisted", "a/b"] {
            let (_dir, root) = vault_with_chat_of(backend);
            let outer = tempfile::tempdir().unwrap();
            let data = outer.path().join("data");
            std::fs::create_dir_all(&data).unwrap();
            let sessions = AgentSessions::with_timing(timing());
            chat_action_in(
                Some(&sessions),
                (Some(&data), &["fake".to_string()]),
                "main",
                &root,
                ID,
                ChatActionName::Delete,
                None,
            )
            .unwrap();
            assert!(
                chat_store::load(&root, ID).is_err(),
                "{backend}: the note went"
            );
            assert!(
                std::fs::read_dir(&data).unwrap().next().is_none(),
                "{backend}: nothing was kept"
            );
            assert!(
                std::fs::read_dir(outer.path()).unwrap().count() == 1,
                "{backend}: nothing outside the data folder"
            );
        }
    }
}
