//! Tauri wrappers for the icons the web half draws. All logic is Tauri-free (`crate::icons`: the
//! store, the Iconize layer, the one resolver); this file owns the per-window plumbing, the
//! vault root of the window and `commands::blocking`. Paths in are vault-relative or absolute
//! inside the vault (`vault_ops::confine`); paths out are vault-relative.

use crate::commands::blocking;
use crate::error::AppError;
use crate::icons::{self, IconError};
use crate::state::AppState;
use crate::vault_ops;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, Runtime};

/// One path's icon, as every surface draws it.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IconRow {
    /// Vault-relative, forward slashes (a file or a folder).
    pub path: String,
    /// `emoji:<emoji>` or `icon:<Hugeicons name>`.
    pub icon: String,
    /// `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `writer` or `iconize`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IconsResolved {
    pub icons: Vec<IconRow>,
    /// Iconize icons from packs Writer does not show.
    pub iconize_unsupported: u32,
}

fn icon_err(e: IconError) -> AppError {
    match e {
        IconError::Invalid(m) => AppError::InvalidPath(m),
        IconError::Io(m) => AppError::Io(m),
    }
}

/// The window's vault root, canonical (what `confine` needs).
fn window_root<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview: &tauri::Webview<R>,
) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let root = state.workspace_root.read().clone();
    root.ok_or(AppError::NoWorkspace)?
        .canonicalize()
        .map_err(AppError::from)
}

fn confine_all(root: &std::path::Path, paths: &[String]) -> Result<Vec<String>, AppError> {
    paths
        .iter()
        .map(|p| {
            let c =
                vault_ops::confine(root, p).map_err(|e| AppError::InvalidPath(e.to_string()))?;
            if c.abs.exists() {
                Ok(c.rel)
            } else {
                Err(AppError::NotFound(c.rel))
            }
        })
        .collect()
}

/// Every icon of the vault after resolution (Writer's file over Iconize's), and how many
/// Iconize icons are not shown.
#[tauri::command]
#[specta::specta]
pub async fn icons_resolved<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<IconsResolved, AppError> {
    let root = window_root(&app, &webview)?;
    blocking(move || {
        let r = icons::resolve(&root).map_err(icon_err)?;
        Ok(IconsResolved {
            iconize_unsupported: u32::try_from(r.iconize_unsupported).unwrap_or(u32::MAX),
            icons: r
                .icons
                .into_iter()
                .map(|(path, (entry, source))| IconRow {
                    path,
                    icon: entry.icon,
                    color: entry.color,
                    source: source.as_str().to_string(),
                })
                .collect(),
        })
    })
    .await
}

/// Give every path the same icon (and colour); one write.
#[tauri::command]
#[specta::specta]
pub async fn icons_set<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    paths: Vec<String>,
    icon: String,
    color: Option<String>,
) -> Result<(), AppError> {
    let root = window_root(&app, &webview)?;
    blocking(move || {
        let rels = confine_all(&root, &paths)?;
        icons::set(&root, &rels, &icon, color.as_deref()).map_err(icon_err)
    })
    .await
}

/// Remove the icon of every path (an Iconize icon is hidden, not revealed again).
#[tauri::command]
#[specta::specta]
pub async fn icons_remove<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let root = window_root(&app, &webview)?;
    blocking(move || {
        let rels = confine_all(&root, &paths)?;
        icons::remove(&root, &rels).map_err(icon_err)
    })
    .await
}
