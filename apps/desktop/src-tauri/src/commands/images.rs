//! IPC for images dropped or pasted into a note (spec: `SPECs/image-insertion-spec.md`).
//! The rules and the one write path are `crate::attachments`; this file only
//! authorizes, reads the setting and moves bytes.

use crate::attachments::{self, AttachmentError, Source};
use crate::error::AppError;
use crate::state::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentSaved {
    pub absolute_path: String,
    /// Relative to the vault (or, in a standalone window, to the note's folder).
    pub relative_path: String,
    pub file_name: String,
}

impl From<AttachmentError> for AppError {
    fn from(e: AttachmentError) -> Self {
        match e {
            // Shown to the user as is.
            AttachmentError::Unsupported(m) | AttachmentError::TooLarge(m) => AppError::Refused(m),
            AttachmentError::Invalid(m) => AppError::InvalidPath(m),
            AttachmentError::Io(m) => AppError::Io(m),
        }
    }
}

/// What the request header carries next to the raw image bytes.
#[derive(Deserialize)]
struct BytesMeta {
    note_path: String,
    name: String,
}

/// Where a save lands: the confinement root, the folder under it and the note.
struct Target {
    root: PathBuf,
    folder: String,
}

/// Resolve the folder for `note_path` in this window: the attachment setting in a
/// workspace; `<stem>-assets` next to the note in a standalone window (no vault).
fn target_for(
    app: &tauri::AppHandle,
    label: &str,
    note_path: &str,
    setting: &str,
) -> Result<Target, AppError> {
    let state = app.state::<AppState>().get_or_create(label);
    let note = state.authorize_probe(Path::new(note_path))?;
    let workspace = state.workspace_root.read().clone();
    match workspace {
        Some(root) => {
            let root = root.canonicalize()?;
            let note_dir = attachments::note_dir_rel(&root, &note)?;
            let effective = attachments::effective_setting(
                setting,
                attachments::read_obsidian_setting(&root).as_deref(),
            );
            Ok(Target {
                folder: attachments::resolve_folder(&effective, &note_dir),
                root,
            })
        }
        None => {
            let dir = note
                .parent()
                .ok_or_else(|| AppError::InvalidPath("the note has no folder".into()))?;
            let stem = note
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .ok_or_else(|| AppError::InvalidPath("the note has no name".into()))?;
            Ok(Target {
                root: dir.to_path_buf(),
                folder: format!("{stem}-assets"),
            })
        }
    }
}

fn saved(s: attachments::Saved) -> AttachmentSaved {
    AttachmentSaved {
        absolute_path: s.abs_path.to_string_lossy().to_string(),
        relative_path: s.rel_path,
        file_name: s.file_name,
    }
}

/// Save pasted or browser-dropped image bytes. The body is the raw bytes (no JSON
/// number array: images are large); `x-writer-meta` is base64 JSON `{note_path, name}`.
#[tauri::command]
pub async fn save_attachment(
    request: tauri::ipc::Request<'_>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<AttachmentSaved, AppError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Io(
            "expected the image bytes as the request body".into(),
        ));
    };
    let header = request
        .headers()
        .get("x-writer-meta")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Io("missing x-writer-meta header".into()))?;
    let meta: BytesMeta = base64::engine::general_purpose::STANDARD
        .decode(header)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .ok_or_else(|| AppError::Io("invalid x-writer-meta header".into()))?;
    let bytes = bytes.clone();
    let label = webview.label().to_string();
    let setting =
        super::settings::get_merged_string_setting(&app, &label, attachments::SETTING_KEY)?;
    super::blocking(move || {
        let target = target_for(&app, &label, &meta.note_path, &setting)?;
        Ok(saved(attachments::save(
            &target.root,
            &target.folder,
            &meta.name,
            Source::Bytes(&bytes),
        )?))
    })
    .await
}

/// Copy a dropped file (Finder) into the attachment folder by path, so its bytes
/// never cross IPC. The file keeps its name.
#[tauri::command]
pub async fn import_attachment_file(
    note_path: String,
    source_path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<AttachmentSaved, AppError> {
    let label = webview.label().to_string();
    let setting =
        super::settings::get_merged_string_setting(&app, &label, attachments::SETTING_KEY)?;
    super::blocking(move || {
        let source = Path::new(&source_path);
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| AppError::InvalidPath("the dropped item has no name".into()))?;
        let target = target_for(&app, &label, &note_path, &setting)?;
        Ok(saved(attachments::save(
            &target.root,
            &target.folder,
            &name,
            Source::File(source),
        )?))
    })
    .await
}

/// Download an image a browser drag or paste carried only as a link (`http(s)` only, size cap
/// enforced while streaming) and save it like any other image. A refusal or failure comes back
/// as a short sentence the editor shows next to the plain `![](url)` it inserts instead.
#[tauri::command]
pub async fn import_attachment_url(
    note_path: String,
    url: String,
    fallback_stem: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<AttachmentSaved, AppError> {
    let label = webview.label().to_string();
    let setting =
        super::settings::get_merged_string_setting(&app, &label, attachments::SETTING_KEY)?;
    let downloaded = attachments::download_image(&url, &fallback_stem).await?;
    super::blocking(move || {
        let target = target_for(&app, &label, &note_path, &setting)?;
        Ok(saved(attachments::save(
            &target.root,
            &target.folder,
            &downloaded.name,
            Source::Bytes(&downloaded.bytes),
        )?))
    })
    .await
}
