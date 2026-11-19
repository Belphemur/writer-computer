//! The `plugin:spellcheck|*` handlers. All logic is in the Tauri-free `crate::spellcheck`; this
//! file resolves the calling window (its settings layer and its vault) and keeps disk and
//! network work off the main thread (`commands::blocking`).

use super::Engine;
use crate::commands::blocking;
use crate::error::AppError;
use crate::plugin_store;
use crate::spellcheck::checker::Finding;
use crate::spellcheck::dictionaries::{self, DictError, Installed};
use crate::spellcheck::lang::Lang;
use crate::spellcheck::options::Options;
use crate::spellcheck::personal::{Personal, PersonalError};
use crate::spellcheck::{BlockLanguage, Checked, Context, NoteInput};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, Runtime};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    /// Vault-relative path of the note (folder rules and the stale check read it).
    pub path: String,
    pub text: String,
    /// The editor's document version, a counter that only grows.
    pub version: u32,
    /// The language chosen for this note in the status item, a tag such as `fr`.
    pub language: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub version: u32,
    /// A newer version of the note was already answered: nothing is returned, drop this.
    pub stale: bool,
    pub findings: Vec<Finding>,
    pub blocks: Vec<BlockLanguage>,
    pub missing: Vec<Lang>,
}

/// One dictionary of the pinned catalog and whether it is installed.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryInfo {
    pub id: String,
    pub name: String,
    pub license: String,
    pub installed: bool,
    /// Size of the download in bytes.
    pub bytes: u32,
}

fn dict_err(e: DictError) -> AppError {
    match e {
        DictError::NotInCatalog(id) => AppError::NotFound(id),
        DictError::Io(m) => AppError::Io(m),
        refused => AppError::Refused(refused.to_string()),
    }
}

fn personal_err(e: PersonalError) -> AppError {
    match e {
        PersonalError::Invalid(m) => AppError::Refused(m),
        PersonalError::Io(m) => AppError::Io(m),
    }
}

/// The calling window's settings as engine options (the merged layers: a vault may set the
/// default language and the folder rules); defaults before the settings are initialised.
fn options_of<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Options {
    let state = app.state::<AppState>().get_or_create(label);
    let guard = state.settings.read();
    match guard.as_ref() {
        Some(s) => Options::from_lookup(|k| s.get(k).cloned()),
        None => Options::default(),
    }
}

/// The calling window's vault root, when it has one.
fn root_of<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Option<PathBuf> {
    app.state::<AppState>()
        .get_or_create(label)
        .workspace_snapshot()
        .map(|(root, _)| root)
}

fn personal_of(engine: &Engine, root: Option<&PathBuf>) -> Arc<Personal> {
    match root.map(|r| engine.personal.get(r)) {
        Some(Ok(p)) => p,
        Some(Err(e)) => {
            // an unreadable personal dictionary must not stop the check
            log::warn!("spellcheck: personal dictionary not read: {e}");
            Arc::new(Personal::default())
        }
        None => Arc::new(Personal::default()),
    }
}

fn require_root<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<PathBuf, AppError> {
    root_of(app, label).ok_or(AppError::NoWorkspace)
}

/// Checks a note's text. Findings are in UTF-16 offsets from the start of `text`.
#[tauri::command]
#[specta::specta]
pub async fn spellcheck_check<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    request: CheckRequest,
) -> Result<CheckResponse, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let engine = app.state::<Engine>();
        let options = options_of(&app, &label);
        let personal = personal_of(&engine, root_of(&app, &label).as_ref());
        let version = request.version;
        let input = NoteInput {
            path: &request.path,
            version: u64::from(version),
            language: request.language.as_deref().and_then(Lang::parse),
        };
        let ctx = Context {
            options: &options,
            personal: &personal,
        };
        Ok(
            match engine.checker.check_note(&request.text, &input, &ctx) {
                Ok(Checked {
                    findings,
                    blocks,
                    missing,
                }) => CheckResponse {
                    version,
                    stale: false,
                    findings,
                    blocks,
                    missing,
                },
                Err(_) => CheckResponse {
                    version,
                    stale: true,
                    findings: Vec::new(),
                    blocks: Vec::new(),
                    missing: Vec::new(),
                },
            },
        )
    })
    .await
}

/// Every dictionary of the catalog, installed or not.
#[tauri::command]
#[specta::specta]
pub async fn spellcheck_dictionaries<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<DictionaryInfo>, AppError> {
    blocking(move || {
        let engine = app.state::<Engine>();
        let installed: Vec<String> = dictionaries::installed(engine.checker.dictionaries_dir())
            .into_iter()
            .map(|d| d.id)
            .collect();
        Ok(dictionaries::catalog()
            .dictionaries
            .iter()
            .map(|e| DictionaryInfo {
                id: e.id.clone(),
                name: e.name.clone(),
                license: e.license.clone(),
                installed: installed.contains(&e.id),
                bytes: u32::try_from(e.aff.bytes + e.dic.bytes).unwrap_or(u32::MAX),
            })
            .collect())
    })
    .await
}

/// Downloads and installs a dictionary of the catalog: the feature's only network use, started by
/// the user, through the plugin store's egress-checked fetcher (https, GitHub hosts, size caps).
#[tauri::command]
#[specta::specta]
pub async fn spellcheck_install_dictionary<R: Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Installed, AppError> {
    blocking(move || {
        let engine = app.state::<Engine>();
        let done = dictionaries::install(
            engine.checker.dictionaries_dir(),
            &id,
            &plugin_store::http_get,
        )
        .map_err(dict_err)?;
        engine.checker.dictionary_changed(&done.id);
        log::info!("spellcheck: installed dictionary {}", done.id);
        Ok(done)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn spellcheck_remove_dictionary<R: Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), AppError> {
    blocking(move || {
        let engine = app.state::<Engine>();
        dictionaries::remove(engine.checker.dictionaries_dir(), &id).map_err(dict_err)?;
        engine.checker.dictionary_changed(&id);
        Ok(())
    })
    .await
}

/// The vault's personal dictionary, sorted.
#[tauri::command]
#[specta::specta]
pub async fn spellcheck_personal_words<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<String>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = require_root(&app, &label)?;
        Ok(app
            .state::<Engine>()
            .personal
            .get(&root)
            .map_err(personal_err)?
            .words())
    })
    .await
}

/// "Add to dictionary": the one write path of `.writer/dictionary.txt`. Returns the words.
#[tauri::command]
#[specta::specta]
pub async fn spellcheck_add_word<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    word: String,
) -> Result<Vec<String>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = require_root(&app, &label)?;
        Ok(crate::spellcheck::personal::add(&root, &word)
            .map_err(personal_err)?
            .words())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn spellcheck_remove_word<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    word: String,
) -> Result<Vec<String>, AppError> {
    let label = webview.label().to_string();
    blocking(move || {
        let root = require_root(&app, &label)?;
        Ok(crate::spellcheck::personal::remove(&root, &word)
            .map_err(personal_err)?
            .words())
    })
    .await
}
