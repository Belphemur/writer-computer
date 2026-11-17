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
    /// The note's display-title override (frontmatter `title`), matched like the file name.
    pub title: Option<String>,
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
                title: m.title,
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

/// Most paths `find_files_by_exact_name` returns: the caller only needs to know whether the name
/// is unique, so a handful is as good as all of them.
const EXACT_NAME_MAX_RESULTS: usize = 20;
/// Most directory entries the index-less fallback walk inspects before it gives up and returns
/// what it found, so a huge vault cannot hold a worker for long.
const EXACT_NAME_WALK_BUDGET: usize = 200_000;

/// A bare file name: no separator, no NUL, not `.`/`..`. Anything else could name a path outside
/// the vault (or none at all) and is rejected before any lookup.
fn validate_file_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(AppError::InvalidPath("not a bare file name".into()));
    }
    Ok(())
}

/// Index-less fallback of [`find_files_by_exact_name`]: a breadth-first walk of `root` that shows
/// what the sidebar shows (visibility policy, `.gitignore`, symlinks resolved by `fs_entry`,
/// never leaving the vault), comparing names under the resolver's key (NFC + lowercase). Paths are
/// vault-relative with `/`, shallowest first; each real file is reported once, at its real path.
/// Stops at `max_results` or after `budget` inspected entries. Never logs a name or path.
pub(crate) fn walk_files_by_exact_name(
    root: &Path,
    ignore: Option<&crate::ignore::WorkspaceIgnore>,
    file_name: &str,
    max_results: usize,
    budget: usize,
) -> Vec<String> {
    use crate::fs_entry::{canonical_root, resolve_entry};
    use std::collections::{HashSet, VecDeque};
    let Some(root_real) = canonical_root(Some(root)) else {
        return Vec::new();
    };
    let key = crate::index::resolve::lower(file_name);
    let mut out = Vec::new();
    let mut seen_dirs: HashSet<std::path::PathBuf> = HashSet::from([root_real.clone()]);
    // (path as the workspace spells it, canonical path): `.gitignore` scopes use the former.
    let mut queue = VecDeque::from([(root.to_path_buf(), root_real.clone())]);
    let mut inspected = 0usize;
    while let Some((logical, dir)) = queue.pop_front() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            inspected += 1;
            if inspected > budget {
                return out;
            }
            let path = logical.join(entry.file_name());
            let Ok(ft) = entry.file_type() else { continue };
            let Some(resolved) = resolve_entry(&path, ft, &dir, Some(&root_real)) else {
                continue;
            };
            let Ok(rel) = resolved.real.strip_prefix(&root_real) else {
                continue;
            };
            if !crate::code_files::rel_is_visible(rel) {
                continue;
            }
            if let Some(matcher) = ignore {
                let is_dir = resolved.is_dir();
                if matcher.is_ignored(&path, is_dir)
                    || (resolved.symlink && matcher.is_ignored(&resolved.real, is_dir))
                {
                    continue;
                }
            }
            if resolved.is_dir() {
                if seen_dirs.insert(resolved.real.clone()) {
                    queue.push_back((path, resolved.real));
                }
            } else if resolved
                .real
                .file_name()
                .is_some_and(|n| crate::index::resolve::lower(&n.to_string_lossy()) == key)
            {
                if let Some(rel) = crate::index::paths::rel_to_string(rel) {
                    if !out.contains(&rel) {
                        out.push(rel);
                        if out.len() >= max_results {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}

/// Vault-relative paths of the files named exactly `file_name` (extension included; case and
/// Unicode normalization form ignored, like wikilink resolution), shallowest first, at most
/// [`EXACT_NAME_MAX_RESULTS`]. Backs "an `@` reference follows its note when it was renamed or
/// moved": the caller acts only on exactly one match.
///
/// Answered from the vault index when it is ready; otherwise (cold build, failed index) from a
/// bounded walk under the sidebar's visibility, ignore and symlink rules. A name that is not a
/// bare file name (separator, `..`) is rejected, so nothing outside the vault is ever probed.
#[tauri::command]
pub async fn find_files_by_exact_name(
    file_name: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<String>, AppError> {
    validate_file_name(&file_name)?;
    blocking(move || {
        let (state, index) = window_index(&app, &webview)?;
        if index.is_ready() && index.last_error().is_none() {
            return index
                .find_files_by_exact_name(&file_name, EXACT_NAME_MAX_RESULTS)
                .map_err(app_err);
        }
        let ignore = state.workspace_ignore.read().clone();
        Ok(walk_files_by_exact_name(
            index.root(),
            ignore.as_deref(),
            &file_name,
            EXACT_NAME_MAX_RESULTS,
            EXACT_NAME_WALK_BUDGET,
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    fn walk(root: &Path, name: &str, cap: usize) -> Vec<String> {
        walk_files_by_exact_name(root, None, name, cap, 10_000)
    }

    #[test]
    fn walk_matches_exact_name_shallowest_first() {
        let d = TempDir::new().unwrap();
        write(d.path(), "a/b/Note.md");
        write(d.path(), "note.md");
        write(d.path(), "z/NOTE.MD");
        write(d.path(), "note.md.bak");
        write(d.path(), "my note.md");
        assert_eq!(
            walk(d.path(), "note.md", 10),
            ["note.md", "z/NOTE.MD", "a/b/Note.md"]
        );
        assert!(walk(d.path(), "note", 10).is_empty());
    }

    #[test]
    fn walk_matches_across_unicode_normalization_forms() {
        let d = TempDir::new().unwrap();
        let nfd = "Fran\u{63}\u{327}ois.md";
        let nfc = "Fran\u{e7}ois.md";
        write(d.path(), &format!("x/{nfd}"));
        assert_eq!(walk(d.path(), nfc, 10), [format!("x/{nfd}")]);
        assert_eq!(walk(d.path(), nfd, 10), [format!("x/{nfd}")]);
    }

    #[test]
    fn walk_skips_hidden_and_ignored_folders() {
        let d = TempDir::new().unwrap();
        write(d.path(), "node_modules/pkg/n.md");
        write(d.path(), ".git/n.md");
        write(d.path(), ".obsidian/n.md");
        write(d.path(), "private/n.md");
        write(d.path(), "ok/n.md");
        fs::write(d.path().join(".gitignore"), "private/\n").unwrap();
        let ignore = crate::ignore::WorkspaceIgnore::load(d.path());
        let found = walk_files_by_exact_name(d.path(), Some(&ignore), "n.md", 10, 10_000);
        assert_eq!(found, ["ok/n.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn walk_follows_inside_links_once_and_never_leaves_the_vault() {
        use std::os::unix::fs::symlink;
        let d = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write(d.path(), "real/n.md");
        write(outside.path(), "n.md");
        symlink(d.path().join("real"), d.path().join("alias")).unwrap();
        symlink(outside.path(), d.path().join("escape")).unwrap();
        symlink(outside.path().join("n.md"), d.path().join("out-file.md")).unwrap();
        symlink(d.path(), d.path().join("real/loop")).unwrap();
        assert_eq!(walk(d.path(), "n.md", 10), ["real/n.md"]);
    }

    #[test]
    fn walk_caps_results_and_budget() {
        let d = TempDir::new().unwrap();
        for i in 0..5 {
            write(d.path(), &format!("d{i}/n.md"));
        }
        assert_eq!(walk(d.path(), "n.md", 3).len(), 3);
        assert!(walk_files_by_exact_name(d.path(), None, "n.md", 10, 2).len() < 5);
    }

    #[test]
    fn names_that_could_leave_the_vault_are_rejected() {
        for bad in [
            "",
            ".",
            "..",
            "../x.md",
            "a/b.md",
            "a\\b.md",
            "x\0.md",
            "/etc/passwd",
        ] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_file_name("Note.md").is_ok());
        assert!(validate_file_name("..hidden.md").is_ok());
    }
}
