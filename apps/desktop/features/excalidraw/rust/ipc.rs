//! `excalidraw:export` over the CLI-to-app socket (ADR 2026-11-18, point 6; the socket is the ADR
//! `2026-11-18-let-the-writer-cli-talk-to-the-running-app-over-a-local-authenticated-socket`).
//! The window renders the drawing with Excalidraw's own export and writes `<name>.svg` beside it
//! (the web handler, `web/export.ts`); this half confines the path, asks the window and reduces
//! its answer to the one vault-relative path of the SVG, so nothing else leaves the app.

use crate::ipc::{boxed, BoxFuture, Call, IpcCommand, IpcError, VaultRule};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Rendering a large drawing off-screen can take a while.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(20);

pub static COMMANDS: &[IpcCommand] = &[IpcCommand {
    name: "excalidraw:export",
    vault: VaultRule::MustBeOpen,
    timeout: EXPORT_TIMEOUT,
    feature: Some("excalidraw"),
    run: export_handler,
}];

fn export_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    boxed(export(call))
}

async fn export(call: Call) -> Result<Value, IpcError> {
    call.only_args(&["path"])?;
    let file = call.confine_existing("path", true).await?;
    if super::excalidraw_md::format_of(&file.rel).is_none() {
        return Err(IpcError::invalid_args(format!(
            "{} is not a drawing",
            file.rel
        )));
    }
    let root = call.vault()?.root.clone();
    let answer = call
        .host
        .ask_window(
            &root,
            "excalidraw:export",
            json!({ "path": file.abs.to_string_lossy() }),
        )
        .await?;
    Ok(json!({ "path": svg_path(&root, &answer)? }))
}

/// The SVG's vault-relative path from the window's answer; anything outside the vault, or not an
/// `.svg`, is an error rather than a path the CLI would print.
pub(crate) fn svg_path(root: &Path, answer: &Value) -> Result<String, IpcError> {
    answer
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| p.to_ascii_lowercase().ends_with(".svg"))
        .and_then(|p| Path::new(p).strip_prefix(root).ok())
        .and_then(crate::index::paths::rel_to_string)
        .ok_or_else(|| {
            IpcError::new(
                crate::ipc::ErrorCode::Internal,
                "the window did not answer with the SVG's path",
            )
        })
}
