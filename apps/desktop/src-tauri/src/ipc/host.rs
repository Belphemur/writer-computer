//! What the socket's commands need from the running app, as one narrow port. The Tauri glue
//! (`commands/ipc.rs`) implements it over the `AppHandle` and the windows; the tests implement it
//! with a fake. Nothing in `ipc/` names a Tauri type.

use super::protocol::IpcError;
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Host: Send + Sync + 'static {
    fn app_version(&self) -> String;
    /// The canonical roots of the vaults that have a window.
    fn open_vaults(&self) -> Vec<PathBuf>;
    /// Is the built-in feature `id` usable right now (on, not failed, not in safe mode)?
    fn feature_live(&self, id: &str) -> bool;
    /// A command's task panicked: mark the feature that contributed it (if any) as failed, like
    /// any other feature boundary (`features::guard`).
    fn command_panicked(&self, feature: Option<&'static str>);
    /// Open the vault's window when it has none, and bring it to the front when `focus`.
    fn open_vault_window<'a>(
        &'a self,
        root: &'a Path,
        focus: bool,
    ) -> BoxFuture<'a, Result<(), IpcError>>;
    /// Ask the vault's window to do `topic` with `payload` and wait for its answer. The window
    /// answers through the registered web handler for the topic
    /// (`src/lib/ipc-requests.ts`); a window that is not ready yet is waited for.
    fn ask_window<'a>(
        &'a self,
        root: &'a Path,
        topic: &'a str,
        payload: Value,
    ) -> BoxFuture<'a, Result<Value, IpcError>>;
}
