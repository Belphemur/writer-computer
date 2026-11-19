//! The core commands of the socket (ADR 2026-11-18, point 4): `status`, `open`, `reveal`,
//! `active`. Each is a thin handler over the [`Host`](super::host::Host) port; paths are
//! confined by `Call::confine_existing` (`vault_ops`), and no command returns note text.

use super::protocol::IpcError;
use super::registry::{boxed, Call, IpcCommand, VaultRule};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// `open` may have to create the vault's window and wait for it to load.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

pub static CORE: &[IpcCommand] = &[
    IpcCommand::core("status", VaultRule::Optional, |c| boxed(status(c))),
    IpcCommand {
        timeout: OPEN_TIMEOUT,
        ..IpcCommand::core("open", VaultRule::OpensIt, |c| boxed(open(c)))
    },
    IpcCommand::core("reveal", VaultRule::MustBeOpen, |c| boxed(reveal(c))),
    IpcCommand::core("active", VaultRule::MustBeOpen, |c| boxed(active(c))),
];

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// App version, the open vaults and, when a vault was named, whether it is open.
async fn status(call: Call) -> Result<Value, IpcError> {
    call.only_args(&[])?;
    let vaults: Vec<String> = call.host.open_vaults().iter().map(|p| text(p)).collect();
    Ok(json!({
        "version": call.host.app_version(),
        "vaults": vaults,
        "vaultOpen": call.vault.as_ref().map(|v| v.open),
    }))
}

/// Open a vault file in the vault's window, through the window's own open path (the one links
/// and the quick switcher use). `newTab`, `line` and `anchor` are the options of that path.
async fn open(call: Call) -> Result<Value, IpcError> {
    call.only_args(&["path", "newTab", "line", "anchor"])?;
    let new_tab = call.bool_arg("newTab")?;
    let line = call.line_arg("line")?;
    let anchor = call.str_arg("anchor")?.filter(|a| !a.is_empty());
    if line.is_some() && anchor.is_some() {
        return Err(IpcError::invalid_args("give line or anchor, not both"));
    }
    let file = call.confine_existing("path", true).await?;
    let root = call.vault()?.root.clone();
    call.host.open_vault_window(&root, true).await?;
    let payload = json!({
        "path": text(&file.abs),
        "newTab": new_tab,
        "line": line,
        "anchor": anchor,
    });
    call.host.ask_window(&root, "open", payload).await?;
    Ok(json!({ "path": file.rel }))
}

/// Reveal a file or folder in the sidebar tree.
async fn reveal(call: Call) -> Result<Value, IpcError> {
    call.only_args(&["path"])?;
    let entry = call.confine_existing("path", false).await?;
    let root = call.vault()?.root.clone();
    call.host
        .ask_window(&root, "reveal", json!({ "path": text(&entry.abs) }))
        .await?;
    Ok(json!({ "path": entry.rel }))
}

/// The active tab of the vault's window: vault-relative path, kind and cursor line. The window's
/// answer is reduced to exactly those three fields here, so an answer that carried text (a bug in
/// the web handler) still cannot leave the app.
async fn active(call: Call) -> Result<Value, IpcError> {
    call.only_args(&[])?;
    let root = call.vault()?.root.clone();
    let answer = call.host.ask_window(&root, "active", json!({})).await?;
    Ok(sanitize_active(&root, &answer))
}

pub(crate) fn sanitize_active(root: &Path, answer: &Value) -> Value {
    let path = answer
        .get("path")
        .and_then(Value::as_str)
        .and_then(|p| Path::new(p).strip_prefix(root).ok())
        .and_then(crate::index::paths::rel_to_string);
    let kind = answer
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| k.len() <= 32 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    let line = answer
        .get("line")
        .and_then(Value::as_u64)
        .filter(|l| *l >= 1);
    json!({ "path": path, "kind": kind, "line": line })
}
