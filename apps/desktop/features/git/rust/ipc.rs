//! `git:sync` over the CLI-to-app socket (ADR 2026-11-18 point 13): with Writer running, the CLI
//! asks the vault's window to sync (the web handler `git:sync`, which calls the same
//! `git_sync_now` command as the panel's button), so the app's scheduler owns the run and a
//! conflict reaches the app. A vault that is not open in Writer answers `{"open": false}` and the
//! CLI syncs headless with the same engine. `git:resolve` goes the same way: the window settles the
//! conflict with the merge view's own command (its editors are told, its lock held), headless when
//! the vault is not open.

use crate::ipc::{boxed, BoxFuture, Call, IpcCommand, IpcError, VaultRule};
use serde_json::{json, Value};
use std::time::Duration;

/// A sync with a slow remote.
const SYNC_TIMEOUT: Duration = Duration::from_secs(150);

/// Settling a conflict: local work only.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);

pub static COMMANDS: &[IpcCommand] = &[
    IpcCommand {
        name: "git:sync",
        vault: VaultRule::Optional,
        timeout: SYNC_TIMEOUT,
        feature: Some(super::runtime::ID),
        run: sync_handler,
    },
    IpcCommand {
        name: "git:resolve",
        vault: VaultRule::Optional,
        timeout: RESOLVE_TIMEOUT,
        feature: Some(super::runtime::ID),
        run: resolve_handler,
    },
];

/// Asks the vault's window to run `topic` with `args`; `{"open": false}` when it is not open.
async fn in_window(call: Call, topic: &str, args: Value) -> Result<Value, IpcError> {
    let vault = call.vault()?.clone();
    if !vault.open {
        return Ok(json!({ "open": false }));
    }
    let mut answer = call.host.ask_window(&vault.root, topic, args).await?;
    if let Some(map) = answer.as_object_mut() {
        map.insert("open".into(), json!(true));
    }
    Ok(answer)
}

fn resolve_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    boxed(async move {
        call.only_args(&["path", "take"])?;
        let path = call.require_str("path")?.to_string();
        let take = call.require_str("take")?.to_string();
        in_window(call, "git:resolve", json!({ "path": path, "take": take })).await
    })
}

fn sync_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    boxed(async move {
        call.only_args(&[])?;
        in_window(call, "git:sync", json!({})).await
    })
}
