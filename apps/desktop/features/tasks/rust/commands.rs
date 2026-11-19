//! Tauri wrappers for the tasks feature. The logic is Tauri-free (`crate::tasks`); this file owns
//! the per-window plumbing: the window's settings and vault root, `commands::blocking`, and for
//! every write the shared `commands::vault_edit` path (confine, mark our own write, reindex,
//! tell the sidebar).
//!
//! The web passes `today` as `YYYY-MM-DD` (its local day): Rust never guesses the user's time
//! zone from the webview.

use crate::commands::blocking;
use crate::commands::index::window_index;
use crate::commands::vault_edit::{edit_vault_file, op_err};
use crate::error::AppError;
use crate::state::WorkspaceState;
use crate::tasks::block::{self, Unmapped};
use crate::tasks::date::Day;
use crate::tasks::edit::{self, parse_field, FieldValue, StatusChange};
use crate::tasks::grammar::{parse_task, Field};
use crate::tasks::ops::{self, Change};
use crate::tasks::page::{Section, SECTIONS};
use crate::tasks::settings::{Overrides, TaskSettings};
use crate::vault_ops::{self, VaultOpError};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Runtime;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidPath(m.into())
}

fn parse_today(today: &str) -> Result<Day, AppError> {
    Day::parse(today).ok_or_else(|| invalid("today is not a date (YYYY-MM-DD)"))
}

fn field_of(name: &str) -> Result<Field, AppError> {
    parse_field(name).ok_or_else(|| invalid(format!("unknown task field \"{name}\"")))
}

/// The window's `tasks.*` settings; the vault's own files are layered on in `load`.
fn overrides(state: &WorkspaceState) -> Overrides {
    let guard = state.settings.read();
    let Some(s) = guard.as_ref() else {
        return Overrides::default();
    };
    Overrides::from_lookup(
        |k| s.get(k).and_then(|v| v.as_str()).map(str::to_string),
        |k| s.get(k).and_then(|v| v.as_bool()),
    )
}

fn load(root: &Path, o: &Overrides) -> TaskSettings {
    TaskSettings::load(root, o)
}

/// A task on a field edit: `value` null clears the field.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldInput {
    pub field: String,
    pub value: Option<String>,
}

/// Toggle (to the next status of the cycle) or complete the task on `line` (1-based) of `path`.
/// `expect` is the description the caller listed: a changed line is refused, not guessed.
/// A recurring task writes its next occurrence (`Change.lines` has both lines).
#[tauri::command]
#[specta::specta]
pub async fn task_toggle<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    line: u32,
    expect: Option<String>,
    today: String,
) -> Result<Change, AppError> {
    let today = parse_today(&today)?;
    let (state, _) = window_index(&app, &webview)?;
    let o = overrides(&state);
    edit_vault_file(path, true, webview, app, move |root, c| {
        let s = load(root, &o);
        let change = ops::change_status(
            root,
            &c.rel,
            line as usize,
            expect.as_deref(),
            StatusChange::Toggle,
            &s,
            today,
        )?;
        Ok((true, change))
    })
    .await
}

/// Set or clear one field of the task on `line` of `path`.
#[tauri::command]
#[specta::specta]
pub async fn task_set_field<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    line: u32,
    expect: Option<String>,
    edit: FieldInput,
) -> Result<Change, AppError> {
    let field = field_of(&edit.field)?;
    let value = edit.value.map_or(FieldValue::Clear, FieldValue::Set);
    let (state, _) = window_index(&app, &webview)?;
    let o = overrides(&state);
    edit_vault_file(path, true, webview, app, move |root, c| {
        let s = load(root, &o);
        let change = ops::set_field(
            root,
            &c.rel,
            line as usize,
            expect.as_deref(),
            field,
            &value,
            &s,
        )?;
        Ok((true, change))
    })
    .await
}

/// Append a task to `path` (the `tasks.inbox` note when absent), creating the note on first use.
#[tauri::command]
#[specta::specta]
pub async fn task_add<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    text: String,
    fields: Vec<FieldInput>,
    path: Option<String>,
) -> Result<Change, AppError> {
    let mut parsed: Vec<(Field, String)> = Vec::new();
    for f in fields {
        if let Some(v) = f.value {
            parsed.push((field_of(&f.field)?, v));
        }
    }
    let (state, _) = window_index(&app, &webview)?;
    let o = overrides(&state);
    let target = path.unwrap_or_else(|| o.inbox.clone());
    edit_vault_file(target, true, webview, app, move |root, c| {
        let s = load(root, &o);
        let change = ops::add(root, &c.rel, &text, &parsed, &s)?;
        Ok((true, change))
    })
    .await
}

/// What the editor needs to know about a task line.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LineInfo {
    pub symbol: String,
    /// `todo`, `in_progress`, `done`, `cancelled` or `non_task`.
    pub kind: String,
    pub description: String,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub start: Option<String>,
    pub priority: Option<String>,
    pub recurrence: Option<String>,
}

/// The parsed state of a task line, or null when the line is not a task. Pure: nothing is read
/// from a file, so an unsaved editor line answers the same as a saved one.
#[tauri::command]
#[specta::specta]
pub async fn task_line_info<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    line: String,
) -> Result<Option<LineInfo>, AppError> {
    let (state, index) = window_index(&app, &webview)?;
    let o = overrides(&state);
    let root = index.root().to_path_buf();
    blocking(move || {
        let Some(p) = parse_task(&line) else {
            return Ok(None);
        };
        let s = load(&root, &o);
        let day = |d: Option<Day>| d.map(|d| d.to_string());
        Ok(Some(LineInfo {
            symbol: p.status.to_string(),
            kind: s.statuses.kind_of(p.status).as_str().to_string(),
            description: p.fields.description.clone(),
            due: day(p.fields.due),
            scheduled: day(p.fields.scheduled),
            start: day(p.fields.start),
            priority: p.fields.priority.map(|p| p.name().to_string()),
            recurrence: p.fields.recurrence.clone(),
        }))
    })
    .await
}

/// The lines a toggle of one editor line leaves: one, two for a recurring task (the next
/// occurrence is above or below, per setting), none for `on completion: delete`.
#[tauri::command]
#[specta::specta]
pub async fn task_line_toggle<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    line: String,
    today: String,
) -> Result<Vec<String>, AppError> {
    let today = parse_today(&today)?;
    let (state, index) = window_index(&app, &webview)?;
    let o = overrides(&state);
    let root = index.root().to_path_buf();
    blocking(move || {
        edit::toggle_line(&line, 1, &load(&root, &o), today).map_err(|e| invalid(e.to_string()))
    })
    .await
}

/// One editor line with a field set or cleared (value null).
#[tauri::command]
#[specta::specta]
pub async fn task_line_set<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    line: String,
    edit: FieldInput,
) -> Result<String, AppError> {
    let field = field_of(&edit.field)?;
    let value = edit.value.map_or(FieldValue::Clear, FieldValue::Set);
    let (state, index) = window_index(&app, &webview)?;
    let o = overrides(&state);
    let root = index.root().to_path_buf();
    blocking(move || {
        edit::set_field_line(&line, 1, field, &value, &load(&root, &o))
            .map_err(|e| invalid(e.to_string()))
    })
    .await
}

/// The built-in sections of the Tasks page (each a `rows: tasks` base).
#[tauri::command]
#[specta::specta]
pub async fn tasks_sections() -> Result<Vec<Section>, AppError> {
    Ok(SECTIONS.to_vec())
}

/// What lowering a ```` ```tasks ```` block gave.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    /// The base text when every instruction mapped.
    pub base: Option<String>,
    /// Instructions that could not be expressed, by line.
    pub unmapped: Vec<Unmapped>,
    /// Vault-relative path of the base written (only with `write`).
    pub written: Option<String>,
    /// The `![[Name.base]]` to put where the block was (only with `write`).
    pub embed: Option<String>,
}

/// A free `<note> tasks.base` next to `note` (a ` 2`, ` 3`... suffix when taken).
fn free_base_name(root: &Path, note_rel: &str) -> Result<String, VaultOpError> {
    let c = vault_ops::confine_markdown(root, note_rel)?;
    let rel = Path::new(&c.rel);
    let stem = rel
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| VaultOpError::Invalid("the note has no name".into()))?;
    let dir = rel.parent().filter(|p| !p.as_os_str().is_empty());
    for n in 1..1000 {
        let name = if n == 1 {
            format!("{stem} tasks.base")
        } else {
            format!("{stem} tasks {n}.base")
        };
        let cand = dir.map_or_else(|| name.clone(), |d| format!("{}/{name}", d.display()));
        if !root.join(&cand).exists() {
            return Ok(cand);
        }
    }
    Err(VaultOpError::Invalid("no free name for the base".into()))
}

/// Lower a ```` ```tasks ```` block to a base. Without `write` this is a dry run (the base text
/// or the unmapped instructions); with it, and only when everything mapped, the base is written
/// next to `path` and the embed to put in the note is returned. The note itself is the
/// editor's to change.
#[tauri::command]
#[specta::specta]
pub async fn tasks_convert_block<R: Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    path: String,
    source: String,
    write: bool,
) -> Result<Converted, AppError> {
    let conv = block::convert(&source);
    let Some(base) = conv.base.clone().filter(|_| write) else {
        return Ok(Converted {
            base: conv.base,
            unmapped: conv.unmapped,
            written: None,
            embed: None,
        });
    };
    let (_, index) = window_index(&app, &webview)?;
    let root = index.root().to_path_buf();
    let rel = blocking(move || free_base_name(&root, &path).map_err(op_err)).await?;
    let file = Path::new(&rel)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    edit_vault_file(rel.clone(), false, webview, app, move |_, c| {
        vault_ops::write_text(&c.abs, &base)?;
        Ok((true, ()))
    })
    .await?;
    Ok(Converted {
        base: conv.base,
        unmapped: conv.unmapped,
        written: Some(rel),
        embed: Some(format!("![[{file}]]")),
    })
}
