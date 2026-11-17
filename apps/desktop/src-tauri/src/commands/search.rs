//! File-name search commands. The data comes from the vault index (SQLite
//! `files` table) through the per-window [`crate::index::names::NameCache`];
//! there is no separate file walker. See `index/names.rs`.

use crate::commands::blocking;
use crate::commands::index::app_err;
use crate::commands::index::window_index;
use crate::error::AppError;
use crate::index::names::{NameFilter, RankContext};
use serde::Serialize;
use std::path::Path;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub filename: String,
    pub relative_path: String,
    pub score: u32,
    pub match_indices: Vec<u32>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Quick-open / link-autocomplete search over notes and `.base` files: fuzzy,
/// typo-tolerant, boosted by recently opened/modified files (`index/rank.rs`).
/// An empty query lists files by recency (opened first, then modified).
///
/// While the cold index build is still running the result is built from the
/// rows committed so far; the frontend's `isIndexing` flag (cleared by
/// `index:complete`) tells the user the list may be short. A failed index is an
/// error, not an empty list.
#[tauri::command]
pub async fn fuzzy_search(
    query: String,
    limit: Option<u32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<SearchResult>, AppError> {
    let limit = limit.unwrap_or(50) as usize;
    blocking(move || {
        let (state, index) = window_index(&app, &webview)?;
        if let Some(e) = index.last_error() {
            return Err(AppError::Io(format!("vault index failed: {e}")));
        }
        let ctx = RankContext {
            now_ms: now_ms(),
            opened: crate::commands::recents::opened_under(&app, index.root()),
            recency: true,
        };
        let found = state
            .names
            .search_with(&query, limit, &NameFilter::default(), &ctx)
            .map_err(app_err)?;
        Ok(found
            .matches
            .into_iter()
            .map(|m| SearchResult {
                path: found.root.join(&m.path).to_string_lossy().into_owned(),
                filename: m.name,
                relative_path: m.path,
                score: m.score,
                match_indices: m.match_indices,
            })
            .collect())
    })
    .await
}

/// Find a file under `root` by case-insensitive basename. Used by Obsidian
/// wiki image embeds (`![[image.png]]`), which reference attachments by bare
/// filename regardless of where they live in the vault. Answered from the vault
/// index (every non-hidden file is a row), not a disk walk.
///
/// Deterministic on duplicates: the match with the fewest path components
/// wins, ties broken lexicographically — "shortest path" like Obsidian. A miss
/// while the cold build is still running is an error rather than `None`, since
/// the file may simply not be indexed yet; callers re-probe.
#[tauri::command]
pub async fn find_file_by_name(
    root: String,
    file_name: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    // the search root must be inside this window's workspace
    let state = app
        .state::<crate::state::AppState>()
        .get_or_create(webview.label());
    let search_root = state.authorize_path(Path::new(&root))?;
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let under = search_root
            .strip_prefix(index.root())
            .ok()
            .and_then(crate::index::paths::rel_to_string);
        let found = index
            .find_files_by_name(&file_name, under.as_deref())
            .map_err(app_err)?;
        match found.into_iter().next() {
            Some(rel) => Ok(Some(index.root().join(rel).to_string_lossy().into_owned())),
            None if index.is_ready() => Ok(None),
            None => Err(AppError::Io(
                "workspace index is still building; the file may not be indexed yet".into(),
            )),
        }
    })
    .await
}

/// Resolve the target of a wikilink (`Name`, `folder/Name`, `Name.md`,
/// `image.png`; no brackets, `#heading` or `|alias`) written in `source_path`
/// to an absolute file path, with the index's file-name rules (`index/resolve.rs`),
/// the same ones that build backlinks, the CLI's `file=` and Bases `link()`.
/// A note's frontmatter `title` or first heading never takes part.
///
/// `None` when nothing matches; an error while the cold build is running (the
/// file may simply not be indexed yet), so callers do not cache a false miss.
#[tauri::command]
pub async fn resolve_wiki_link(
    target: String,
    source_path: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    let state = app
        .state::<crate::state::AppState>()
        .get_or_create(webview.label());
    let source = match &source_path {
        Some(p) => Some(state.authorize_path(Path::new(p))?),
        None => None,
    };
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let from = source
            .as_deref()
            .and_then(|p| p.strip_prefix(index.root()).ok())
            .and_then(crate::index::paths::rel_to_string)
            .unwrap_or_default();
        match index.resolve_link(&from, &target).map_err(app_err)? {
            Some(rel) => Ok(Some(index.root().join(rel).to_string_lossy().into_owned())),
            None if index.is_ready() => Ok(None),
            None => Err(AppError::Io(
                "workspace index is still building; the link may not resolve yet".into(),
            )),
        }
    })
    .await
}
