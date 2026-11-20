//! The `plugin:lint|*` handlers. All logic is in the Tauri-free `crate::lint`; this file reads the
//! calling window's settings (the merged layers) and keeps the work off the main thread
//! (`commands::blocking`). The text arrives from the editor and goes back as findings or edits:
//! nothing is read from disk, written or logged here.

use crate::commands::blocking;
use crate::error::AppError;
use crate::lint::{self, Finding, FixScope, Fixed, Options};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, Runtime};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    pub text: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    /// UTF-16 offsets into the request's text.
    pub findings: Vec<Finding>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FixRequest {
    pub text: String,
    /// `safe` is what saving runs, `all` is "Fix all".
    pub scope: FixScope,
    /// UTF-16 ranges of `text` the fix leaves alone (the lines being typed in when it runs for an
    /// autosave); a fix touching one is dropped whole.
    #[serde(default)]
    pub keep: Vec<KeepRange>,
}

#[derive(Debug, Deserialize, Type)]
pub struct KeepRange {
    pub from: u32,
    pub to: u32,
}

fn refused(e: lint::Error) -> AppError {
    AppError::Refused(e.to_string())
}

/// The calling window's settings as engine options: the merged layers, the defaults before the
/// settings are initialised.
fn options_of<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Options {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    match guard.as_ref() {
        Some(s) => Options::from_lookup(|k| s.get(k).cloned()),
        None => Options::default(),
    }
}

/// Lints a note's text with the enabled rules.
#[tauri::command]
#[specta::specta]
pub async fn lint_check<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    request: CheckRequest,
) -> Result<CheckResponse, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let options = options_of(&app, &label);
        let findings = lint::check(&request.text, &options).map_err(refused)?;
        Ok(CheckResponse { findings })
    })
    .await
}

/// Fixes a note's text with the enabled rules of the scope; the answer is the new text, the
/// rules that changed something and the edits (UTF-16 offsets of the request's text).
#[tauri::command]
#[specta::specta]
pub async fn lint_fix<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    request: FixRequest,
) -> Result<Fixed, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let options = options_of(&app, &label);
        let keep: Vec<_> = request.keep.iter().map(|k| k.from..k.to).collect();
        lint::fix_keeping(&request.text, &options, request.scope, &keep).map_err(refused)
    })
    .await
}
