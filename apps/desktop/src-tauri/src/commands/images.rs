//! IPC for images dropped or pasted into a note (spec: `SPECs/image-insertion-spec.md`).
//! The rules and the one write path are `crate::attachments`; this file only
//! authorizes, reads the setting and moves bytes.

use crate::attachments::{self, AttachmentError, Source};
use crate::dropped;
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
    /// False: the file was already in the vault and is linked in place, nothing was copied.
    pub copied: bool,
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
        copied: true,
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

/// A file dropped from Finder onto a note, any type (`dropped`): copied into the attachment folder
/// by path (bytes never cross IPC; secret names and the shared cap refused), or, already in the
/// vault, returned to be linked in place (`copied` false). The file keeps its name.
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
        let target = target_for(&app, &label, &note_path, &setting)?;
        match dropped::classify(&target.root, source).map_err(AppError::Refused)? {
            dropped::Dropped::InVault { rel, is_dir: false } => Ok(AttachmentSaved {
                absolute_path: target.root.join(&rel).to_string_lossy().to_string(),
                file_name: rel.rsplit('/').next().unwrap_or(&rel).to_string(),
                relative_path: rel,
                copied: false,
            }),
            dropped::Dropped::InVault { is_dir: true, .. }
            | dropped::Dropped::Outside { is_dir: true } => Err(AppError::Refused(
                "a folder can't be linked into a note".into(),
            )),
            dropped::Dropped::Outside { is_dir: false } => {
                dropped::copy_file(&target.root, &target.folder, source)
                    .map(saved)
                    .map_err(AppError::Refused)
            }
        }
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

/// The sidebar's drop of Finder items onto a vault folder (`dest_dir`, absolute): items from outside
/// are copied in (folders recursively, `dropped::import_into`), items already in the vault come back
/// as `InVault` for the frontend to move through `relocate_entry` (links rewritten, never copied).
/// Paths in the outcomes are vault-relative.
#[tauri::command]
pub async fn drop_import(
    dest_dir: String,
    sources: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<dropped::Outcome>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    state.authorize_path(Path::new(&dest_dir))?;
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or_else(|| AppError::InvalidPath("no vault is open".into()))?;
    super::blocking(move || {
        let root = root.canonicalize()?;
        let dest = dropped::folder_rel(&root, Path::new(&dest_dir)).map_err(AppError::Refused)?;
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        Ok(dropped::import_into(&root, &dest, &sources))
    })
    .await
}
