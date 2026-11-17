//! Tauri wrappers for Bases and for the note-property edits its cells make. All logic lives in
//! Tauri-free code (`bases/`, `index/bases_source.rs`, `index/patch.rs`, `vault_ops.rs`); this file
//! owns the per-window plumbing: the workspace index, path confinement against the window's root,
//! self-write marking and the sidebar echo. Errors serialize as strings (`AppError`).
//!
//! Property editing sits here, not in core: the only caller of `note_properties`,
//! `note_property_set` and `note_property_remove` is the Bases cell editor (the properties panel
//! edits the open document, and the CLI calls `vault_ops` directly). The one write path,
//! `vault_ops::set_property_file`, stays in core.

use crate::bases::context::SystemClock;
use crate::bases::document::Document;
use crate::bases::functions::{function_infos, FunctionInfo};
use crate::bases::query::BaseQueryResult;
use crate::commands::blocking;
use crate::commands::index::{app_err, ensure_ready, window_index};
use crate::error::AppError;
use crate::index::bases_source::{eval_expression, run_base_view};
use crate::index::patch::{self, ValueType};
use crate::index::{FileFilter, Index};
use crate::vault_ops::{self, Confined, VaultOpError};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Runtime};

pub(crate) fn op_err(e: VaultOpError) -> AppError {
    match e {
        VaultOpError::NotFound(m) => AppError::NotFound(m),
        VaultOpError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
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

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct BaseListEntry {
    pub path: String,
    pub name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn base_list<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BaseRead {
    pub text: String,
    /// The parsed `Document` (views, filters, formulas, `warnings`), `null`
    /// when the text does not parse (then `error` says why). Free-form here: the web side
    /// narrows it to its one hand-kept mirror of `Document` (`lib/types.ts`).
    #[specta(type = specta_typescript::Unknown)]
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
#[specta::specta]
pub async fn base_read<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BaseParsed {
    /// The parsed `Document`, `null` when the text does not parse.
    #[specta(type = specta_typescript::Unknown)]
    pub document: Json,
    pub error: Option<String>,
}

/// Parse `.base` text that is not a file (an embedded ```base block) into the same document
/// shape `base_read` returns. Pure: no index, no path, no I/O.
#[tauri::command]
#[specta::specta]
pub async fn base_parse_text(text: String) -> Result<BaseParsed, AppError> {
    Ok(parse_text(&text))
}

/// The engine's function registry (name, receiver types, signature, doc, return
/// type) for the formula editor's completion. Pure; the frontend caches it.
#[tauri::command]
#[specta::specta]
pub async fn base_functions() -> Result<Vec<FunctionInfo>, AppError> {
    Ok(function_infos())
}

fn parse_text(text: &str) -> BaseParsed {
    let (document, error) = parse_document(text);
    BaseParsed { document, error }
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
#[specta::specta]
pub async fn base_query<R: Runtime>(
    path: String,
    view: Option<String>,
    this_path: Option<String>,
    now_offset_minutes: Option<i32>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<BaseQueryResult, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let c = vault_ops::confine(index.root(), &path).map_err(op_err)?;
        require_base(&c)?;
        let text = vault_ops::read_text(&c.abs).map_err(op_err)?;
        // `this` defaults to the base file itself (U15).
        let this = this_path.unwrap_or_else(|| c.rel.clone());
        run_query(
            &index,
            &text,
            view.as_deref(),
            Some(&this),
            now_offset_minutes,
        )
    })
    .await
}

/// Unsaved or embedded ```base blocks: the text is the document.
#[tauri::command]
#[specta::specta]
pub async fn base_query_text<R: Runtime>(
    text: String,
    view: Option<String>,
    this_path: Option<String>,
    now_offset_minutes: Option<i32>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<BaseQueryResult, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        run_query(
            &index,
            &text,
            view.as_deref(),
            this_path.as_deref(),
            now_offset_minutes,
        )
    })
    .await
}

/// Evaluate one expression with `thisPath` as the current row and `this`
/// (plugin `getEvaluatedFormula`). `text` is the `.base` source whose
/// `formulas` the expression may reference. Returns the tagged value (`Cell`
/// shape); an evaluation failure is a value of type `error`.
#[tauri::command]
#[specta::specta]
pub async fn base_eval<R: Runtime>(
    expression: String,
    this_path: String,
    now_offset_minutes: Option<i32>,
    text: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<crate::bases::query::Cell, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        let this = vault_ops::confine(index.root(), &this_path)
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
            offset_minutes: now_offset_minutes.unwrap_or(0),
        };
        eval_expression(&index, &expression, &formulas, &this, &clock).map_err(app_err)
    })
    .await
}

/// Any JSON value: free-form on the wire, `unknown` in the generated TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct AnyJson(#[specta(type = specta_typescript::Unknown)] pub Json);

#[tauri::command]
#[specta::specta]
pub async fn note_property_set<R: Runtime>(
    path: String,
    name: String,
    value: AnyJson,
    value_type: Option<String>,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let hint = match value_type.as_deref() {
        None => None,
        Some(s) => Some(ValueType::parse(s).ok_or_else(|| {
            AppError::Io(format!(
                "unknown valueType \"{s}\" (text, list, number, checkbox, date, datetime)"
            ))
        })?),
    };
    edit_property(path, webview, app, move |abs| {
        vault_ops::set_property_file(abs, &name, &value.0, hint)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn note_property_remove<R: Runtime>(
    path: String,
    name: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    edit_property(path, webview, app, move |abs| {
        vault_ops::remove_property_file(abs, &name)
    })
    .await
}

/// Confine, mark the write as ours (the watcher must not treat it as an
/// external change), edit, refresh the index row and the sidebar metadata.
async fn edit_property<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
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
            let modified_at = crate::commands::fs::modified_time(&c.abs);
            state.update_index_modified_at(&c.abs, modified_at);
            let _ = app.emit_to(
                label,
                "sidebar:metadata-changed",
                &crate::commands::fs::WriteResult {
                    path: c.abs.to_string_lossy().into_owned(),
                    modified_at,
                },
            );
        }
    })
}

/// Frontmatter of a note, read fresh from disk (not from the index). `order` is file order (a
/// JSON object cannot carry it); `types` uses the index vocabulary (`text`, `number`, `bool`,
/// `date`, `datetime`, `list`, `link`, `object`, `null`). Unparsable frontmatter gives empty maps
/// and a message in `error`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct NoteProperties {
    pub properties: BTreeMap<String, AnyJson>,
    pub order: Vec<String>,
    pub types: BTreeMap<String, String>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn note_properties<R: Runtime>(
    path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<NoteProperties, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        let c = vault_ops::confine_markdown(index.root(), &path).map_err(op_err)?;
        let text = vault_ops::read_text(&c.abs).map_err(op_err)?;
        Ok(properties_of(&text))
    })
    .await
}

fn properties_of(text: &str) -> NoteProperties {
    match patch::read_properties(text) {
        Ok(props) => {
            let mut out = NoteProperties {
                properties: BTreeMap::new(),
                order: Vec::new(),
                types: BTreeMap::new(),
                error: None,
            };
            for p in props {
                out.order.push(p.name.clone());
                out.types.insert(p.name.clone(), p.vtype.to_string());
                out.properties.insert(p.name, AnyJson(p.value));
            }
            out
        }
        Err(e) => NoteProperties {
            properties: BTreeMap::new(),
            order: Vec::new(),
            types: BTreeMap::new(),
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_functions_wire_shape() {
        let v = serde_json::to_value(function_infos()).unwrap();
        let slice = v
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "slice" && f["receivers"] == json!(["string"]))
            .expect("string.slice");
        assert_eq!(slice["kind"], "method");
        assert_eq!(slice["signature"], "string.slice(start, end?): string");
        assert_eq!(slice["returns"], "string");
        assert_eq!(slice["minArgs"], 1);
        assert_eq!(slice["maxArgs"], 2);
        let max = v
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "max" && f["kind"] == "global")
            .unwrap();
        assert_eq!(max["maxArgs"], Json::Null);
    }

    #[test]
    fn properties_json_shape() {
        let v =
            serde_json::to_value(properties_of("---\nb: 1\na: [x]\nd: 2024-01-01\n---\n")).unwrap();
        assert_eq!(v["order"], json!(["b", "a", "d"]));
        assert_eq!(v["properties"]["a"], json!(["x"]));
        assert_eq!(v["types"]["d"], "date");
        assert_eq!(v["error"], Json::Null);
        let bad = serde_json::to_value(properties_of("---\nk: [oops\n---\n")).unwrap();
        assert!(bad["error"].is_string());
        assert_eq!(
            serde_json::to_value(properties_of("plain")).unwrap()["order"],
            json!([])
        );
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
    fn embedded_block_text_parses_like_a_file() {
        let parsed = parse_text("views:\n  - type: cards\n    name: C\n");
        assert!(parsed.error.is_none());
        assert_eq!(parsed.document["views"][0]["type"], "cards");
        let bad = parse_text("views: [oops\n");
        assert!(bad.document.is_null() && bad.error.is_some());
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
