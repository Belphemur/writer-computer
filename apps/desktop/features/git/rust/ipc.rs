//! `git:sync` over the CLI-to-app socket (ADR 2026-11-18 point 13): with Writer running, the CLI
//! asks the vault's window to sync (the web handler `git:sync`, which calls the same
//! `git_sync_now` command as the panel's button), so the app's scheduler owns the run and a
//! conflict reaches the app. A vault that is not open in Writer answers `{"open": false}` and the
//! CLI syncs headless with the same engine.

use crate::ipc::{boxed, BoxFuture, Call, IpcCommand, IpcError, VaultRule};
use serde_json::{json, Value};
use std::time::Duration;

/// A sync with a slow remote.
const SYNC_TIMEOUT: Duration = Duration::from_secs(150);

pub static COMMANDS: &[IpcCommand] = &[IpcCommand {
    name: "git:sync",
    vault: VaultRule::Optional,
    timeout: SYNC_TIMEOUT,
    feature: Some(super::runtime::ID),
    run: sync_handler,
}];

fn sync_handler(call: Call) -> BoxFuture<'static, Result<Value, IpcError>> {
    boxed(async move {
        call.only_args(&[])?;
        let vault = call.vault()?.clone();
        if !vault.open {
            return Ok(json!({ "open": false }));
        }
        let mut answer = call
            .host
            .ask_window(&vault.root, "git:sync", json!({}))
            .await?;
        if let Some(map) = answer.as_object_mut() {
            map.insert("open".into(), json!(true));
        }
        Ok(answer)
    })
}
