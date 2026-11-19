//! Tauri wrappers for Dataview. The language lives in the Tauri-free `crate::dql` (parser and
//! lowering onto the Bases engine); a block runs through the Bases feature's `base_query_text`
//! with the text `dql_lower` returns, so this file only lowers a query for the web side and
//! writes "Convert to Base". Nothing here runs JavaScript or reads note contents beyond the
//! query text the caller passes.

use crate::commands::blocking;
use crate::commands::index::{ensure_ready, window_index};
use crate::dql;
use crate::error::AppError;
use crate::vault_ops;
use serde::Serialize;
use tauri::Runtime;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DqlLine {
    pub message: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DqlUnmapped {
    pub clause: String,
    pub reason: String,
    pub line: u32,
    pub col: u32,
}

/// What the block renderer needs of a query. Exactly one of `error` and `live_text` is set.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DqlLowered {
    /// `table | list | task | calendar`.
    pub kind: Option<String>,
    /// `.base` text that runs the query live (the DQL dialect on): what the embedded base
    /// queries.
    pub live_text: Option<String>,
    /// Whether the query has an equivalent plain `.base` ("Convert to Base").
    pub convertible: bool,
    /// The clauses with no Bases form, when `convertible` is false.
    pub unmapped: Vec<DqlUnmapped>,
    /// A query that does not parse or cannot be lowered, with its position.
    pub error: Option<DqlLine>,
}

pub(crate) fn lower_text(text: &str) -> DqlLowered {
    match dql::lower(text) {
        Ok(l) => DqlLowered {
            kind: serde_json::to_value(l.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string)),
            live_text: Some(l.live_text()),
            convertible: l.unmapped.is_empty(),
            unmapped: l
                .unmapped
                .iter()
                .map(|u| DqlUnmapped {
                    clause: u.clause.clone(),
                    reason: u.reason.clone(),
                    line: u.line as u32,
                    col: u.col as u32,
                })
                .collect(),
            error: None,
        },
        Err(e) => DqlLowered {
            kind: None,
            live_text: None,
            convertible: false,
            unmapped: Vec::new(),
            error: Some(DqlLine {
                message: e.message,
                line: e.line as u32,
                col: e.col as u32,
            }),
        },
    }
}

/// Lower DQL text for the block renderer. Pure: no index, no path, no I/O.
#[tauri::command]
#[specta::specta]
pub async fn dql_lower(text: String) -> Result<DqlLowered, AppError> {
    Ok(lower_text(&text))
}

/// "Convert to Base": write the query as a plain `.base` next to `note_path` (`Dataview query.base`,
/// numbered when taken) and return its vault-relative path. A query with a clause that has no
/// Bases form is refused, naming the first such clause; the note is not touched (the block is
/// replaced by `![[...]]` in the editor, on the user's confirm).
#[tauri::command]
#[specta::specta]
pub async fn dql_convert<R: Runtime>(
    text: String,
    note_path: String,
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<String, AppError> {
    blocking(move || {
        let (_, index) = window_index(&app, &webview)?;
        ensure_ready(&index)?;
        let lowered = dql::lower(&text).map_err(|e| AppError::Refused(e.to_string()))?;
        let base = lowered.base_text().map_err(|u| {
            AppError::Refused(format!(
                "Cannot convert: {} has no Bases form ({})",
                u[0].clause, u[0].reason
            ))
        })?;
        let note = vault_ops::confine_markdown(index.root(), &note_path).map_err(op_err)?;
        let dir = note
            .abs
            .parent()
            .ok_or_else(|| AppError::InvalidPath(note.rel.clone()))?
            .to_path_buf();
        let mut n = 1;
        let abs = loop {
            let name = if n == 1 {
                "Dataview query.base".to_string()
            } else {
                format!("Dataview query {n}.base")
            };
            let candidate = dir.join(name);
            if !candidate.exists() {
                break candidate;
            }
            n += 1;
        };
        vault_ops::write_text(&abs, &base).map_err(op_err)?;
        // the embed `![[...]]` resolves at once; a failed refresh is the watcher's to repair
        let _ = index.index_paths_blocking(vec![abs.clone()]);
        let rel = abs
            .strip_prefix(index.root())
            .map_err(|_| AppError::InvalidPath(note.rel.clone()))?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(rel)
    })
    .await
}

fn op_err(e: vault_ops::VaultOpError) -> AppError {
    match e {
        vault_ops::VaultOpError::NotFound(m) => AppError::NotFound(m),
        vault_ops::VaultOpError::Invalid(m) => AppError::InvalidPath(m),
        other => AppError::Io(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_good_query_is_live_text_and_a_bad_one_an_error_with_a_position() {
        let ok = lower_text("TABLE status FROM \"x\"");
        assert!(ok.error.is_none());
        assert!(ok.live_text.as_deref().unwrap().contains("dialect: dql"));
        assert_eq!(ok.kind.as_deref(), Some("table"));
        assert!(ok.convertible);
        let bad = lower_text("TABLE\nFROM\n");
        let e = bad.error.unwrap();
        assert_eq!((e.line, e.col), (3, 1));
        assert!(bad.live_text.is_none());
    }

    #[test]
    fn a_grouped_query_runs_live_but_names_why_it_cannot_convert() {
        let l = lower_text("TABLE x GROUP BY y");
        assert!(l.live_text.is_some());
        assert!(!l.convertible);
        assert_eq!(l.unmapped[0].clause, "GROUP BY");
    }
}
