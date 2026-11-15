//! Tauri wrappers for Bases and note properties. All logic lives in Tauri-free
//! code (`bases/`, `index/bases_source.rs`, `index/patch.rs`, `vault_ops.rs`);
//! this file owns the per-window plumbing: the workspace index, path
//! confinement against the window's root, self-write marking and the sidebar
//! echo. Errors serialize as strings (`AppError`).

use super::index::{app_err, blocking, window_index};
use crate::bases::context::SystemClock;
use crate::bases::document::Document;
use crate::bases::query::BaseQueryResult;
use crate::error::AppError;
use crate::index::bases_source::{eval_expression, run_base_view};
use crate::index::patch::{self, ValueType};
use crate::index::{FileFilter, Index, IndexState};
use crate::vault_ops::{self, Confined, VaultOpError};
use serde::Serialize;
use serde_json::{json, Value as Json};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;

pub(crate) fn op_err(e: VaultOpError) -> AppError {
    match e {
        VaultOpError::NotFound(m) => AppError::NotFound(m),
        VaultOpError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

/// Queries over a cold index would silently miss rows: fail instead.
fn ensure_ready(index: &Index) -> Result<(), AppError> {
    if index.status().map_err(app_err)?.state == IndexState::Building {
        return Err(AppError::Io(
            "the vault index is still being built; try again when it is ready".into(),
        ));
    }
    Ok(())
}

fn require_base(c: &Confined) -> Result<(), AppError> {
    if c.rel.to_ascii_lowercase().ends_with(".base") {
        Ok(())
    } else {
        Err(AppError::InvalidPath(format!(
            "{} is not a .base file",
            c.rel
        )))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BaseListEntry {
    pub path: String,
    pub name: String,
}

#[tauri::command]
pub async fn base_list(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<BaseListEntry>, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        let page = index
            .query_files(&FileFilter {
                ext: Some("base".into()),
                ..FileFilter::default()
            })
            .map_err(app_err)?;
        Ok(page
            .rows
            .into_iter()
            .map(|r| BaseListEntry {
                path: r.path,
                name: r.basename,
            })
            .collect())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct BaseRead {
    pub text: String,
    /// The parsed `Document` (views, filters, formulas, `warnings`), `null`
    /// when the text does not parse (then `error` says why).
    pub document: Json,
    pub error: Option<String>,
}

fn parse_document(text: &str) -> (Json, Option<String>) {
    match Document::parse(text) {
        Ok(doc) => match serde_json::to_value(&doc) {
            Ok(v) => (v, None),
            Err(e) => (Json::Null, Some(e.to_string())),
        },
        Err(e) => (Json::Null, Some(e.to_string())),
    }
}

#[tauri::command]
pub async fn base_read(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<BaseRead, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let c = vault_ops::confine(index.root(), &path).map_err(op_err)?;
        require_base(&c)?;
        let text = vault_ops::read_text(&c.abs).map_err(op_err)?;
        let (document, error) = parse_document(&text);
        Ok(BaseRead {
            text,
            document,
            error,
        })
    })
    .await
}

/// Shared by `base_query` and `base_query_text`.
fn run_query(
    index: &Arc<Index>,
    text: &str,
    view: Option<&str>,
    this: Option<&str>,
    offset: Option<i32>,
) -> Result<BaseQueryResult, AppError> {
    ensure_ready(index)?;
    let doc = match Document::parse(text) {
        Ok(d) => d,
        Err(e) => return Ok(BaseQueryResult::document_error(e.to_string())),
    };
    let this_rel = match this {
        Some(t) => Some(vault_ops::confine(index.root(), t).map_err(op_err)?.rel),
        None => None,
    };
    let clock = SystemClock {
        offset_minutes: offset.unwrap_or(0),
    };
    run_base_view(index, &doc, view, this_rel.as_deref(), &clock).map_err(app_err)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn base_query(
    path: String,
    view: Option<String>,
    thisPath: Option<String>,
    nowOffsetMinutes: Option<i32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<BaseQueryResult, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let c = vault_ops::confine(index.root(), &path).map_err(op_err)?;
        require_base(&c)?;
        let text = vault_ops::read_text(&c.abs).map_err(op_err)?;
        // `this` defaults to the base file itself (U15).
        let this = thisPath.unwrap_or_else(|| c.rel.clone());
        run_query(
            &index,
            &text,
            view.as_deref(),
            Some(&this),
            nowOffsetMinutes,
        )
    })
    .await
}

/// Unsaved or embedded ```base blocks: the text is the document.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn base_query_text(
    text: String,
    view: Option<String>,
    thisPath: Option<String>,
    nowOffsetMinutes: Option<i32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<BaseQueryResult, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        run_query(
            &index,
            &text,
            view.as_deref(),
            thisPath.as_deref(),
            nowOffsetMinutes,
        )
    })
    .await
}

/// Evaluate one expression with `thisPath` as the current row and `this`
/// (plugin `getEvaluatedFormula`). `text` is the `.base` source whose
/// `formulas` the expression may reference. Returns the tagged value (`Cell`
/// shape); an evaluation failure is a value of type `error`.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn base_eval(
    expression: String,
    thisPath: String,
    nowOffsetMinutes: Option<i32>,
    text: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<crate::bases::query::Cell, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        let this = vault_ops::confine(index.root(), &thisPath)
            .map_err(op_err)?
            .rel;
        let formulas = match text {
            Some(t) => {
                Document::parse(&t)
                    .map_err(|e| AppError::Io(e.to_string()))?
                    .formulas
            }
            None => Vec::new(),
        };
        let clock = SystemClock {
            offset_minutes: nowOffsetMinutes.unwrap_or(0),
        };
        eval_expression(&index, &expression, &formulas, &this, &clock).map_err(app_err)
    })
    .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn note_property_set(
    path: String,
    name: String,
    value: Json,
    valueType: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let hint = match valueType.as_deref() {
        None => None,
        Some(s) => Some(ValueType::parse(s).ok_or_else(|| {
            AppError::Io(format!(
                "unknown valueType \"{s}\" (text, list, number, checkbox, date, datetime)"
            ))
        })?),
    };
    edit_property(path, webview, app, move |abs| {
        vault_ops::set_property_file(abs, &name, &value, hint)
    })
    .await
}

#[tauri::command]
pub async fn note_property_remove(
    path: String,
    name: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    edit_property(path, webview, app, move |abs| {
        vault_ops::remove_property_file(abs, &name)
    })
    .await
}

/// Confine, mark the write as ours (the watcher must not treat it as an
/// external change), edit, refresh the index row and the sidebar metadata.
async fn edit_property(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    edit: impl FnOnce(&std::path::Path) -> Result<bool, VaultOpError> + Send + 'static,
) -> Result<(), AppError> {
    let label = webview.label().to_string();
    let (state, index) = window_index(&app, &webview)?;
    let c = vault_ops::confine_markdown(index.root(), &path).map_err(op_err)?;
    // Record every spelling of the path the watcher may report.
    crate::watcher::record_write(&state, &c.abs);
    let lexical: PathBuf = index.root().join(&c.rel);
    if lexical != c.abs {
        crate::watcher::record_write(&state, &lexical);
    }
    let abs = c.abs.clone();
    let idx = Arc::clone(&index);
    blocking(move || {
        let changed = edit(&abs).map_err(op_err)?;
        if changed {
            idx.index_paths_blocking(vec![abs]).map_err(app_err)?;
        }
        Ok(changed)
    })
    .await
    .map(|changed| {
        if changed {
            let modified_at = super::fs::modified_time(&c.abs);
            state.update_index_modified_at(&c.abs, modified_at);
            let _ = app.emit_to(
                label,
                "sidebar:metadata-changed",
                &super::fs::WriteResult {
                    path: c.abs.to_string_lossy().into_owned(),
                    modified_at,
                },
            );
        }
    })
}

/// Frontmatter of a note, read fresh from disk (not from the index):
/// `{ properties: {name: value}, order: [name], types: {name: type}, error }`.
/// `order` is file order (a JSON object cannot carry it); `types` uses the
/// index vocabulary (`text`, `number`, `bool`, `date`, `datetime`, `list`,
/// `link`, `object`, `null`). Unparsable frontmatter gives empty maps and a
/// message in `error`.
#[tauri::command]
pub async fn note_properties(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Json, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let c = vault_ops::confine_markdown(index.root(), &path).map_err(op_err)?;
        let text = vault_ops::read_text(&c.abs).map_err(op_err)?;
        Ok(properties_json(&text))
    })
    .await
}

pub(crate) fn properties_json(text: &str) -> Json {
    match patch::read_properties(text) {
        Ok(props) => {
            let mut map = serde_json::Map::new();
            let mut types = serde_json::Map::new();
            let mut order = Vec::new();
            for p in props {
                order.push(Json::String(p.name.clone()));
                types.insert(p.name.clone(), Json::String(p.vtype.to_string()));
                map.insert(p.name, p.value);
            }
            json!({ "properties": map, "order": order, "types": types, "error": Json::Null })
        }
        Err(e) => json!({
            "properties": {}, "order": [], "types": {}, "error": e.to_string()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_json_shape() {
        let v = properties_json("---\nb: 1\na: [x]\nd: 2024-01-01\n---\n");
        assert_eq!(v["order"], json!(["b", "a", "d"]));
        assert_eq!(v["properties"]["a"], json!(["x"]));
        assert_eq!(v["types"]["d"], "date");
        assert_eq!(v["error"], Json::Null);
        let bad = properties_json("---\nk: [oops\n---\n");
        assert!(bad["error"].is_string());
        assert_eq!(properties_json("plain")["order"], json!([]));
    }

    #[test]
    fn base_documents_parse_to_json_or_an_error() {
        let (doc, err) = parse_document("views:\n  - type: table\n    name: T\n");
        assert!(err.is_none());
        assert_eq!(doc["views"][0]["name"], "T");
        assert!(doc["warnings"].is_array());
        let (doc, err) = parse_document("views: [oops\n");
        assert!(doc.is_null() && err.is_some());
    }

    #[test]
    fn confinement_helpers_reject_escapes_for_command_paths() {
        let d = tempfile::TempDir::new().unwrap();
        let root = d.path().canonicalize().unwrap();
        for bad in ["../x.base", ".obsidian/x.base", "/etc/hosts"] {
            assert!(vault_ops::confine(&root, bad).is_err());
        }
        let c = vault_ops::confine(&root, "a/b.txt").unwrap();
        assert!(require_base(&c).is_err());
        assert!(vault_ops::confine_markdown(&root, "a/b.txt").is_err());
        assert!(vault_ops::confine_markdown(&root, "a/b.md").is_ok());
    }
}
