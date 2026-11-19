//! The broker between a socket command and a window's web half: send a request to one window,
//! wait for that window to answer, and know which windows are ready to be asked.
//!
//! Tauri-free: how a request reaches the window (an event) is the `emit` closure the glue passes
//! in; the window's answer comes back through [`WindowBridge::reply`] (the `ipc_reply` command).
//! A window announces itself with [`WindowBridge::mark_ready`] once its startup has resolved, so a
//! request for a window that is still loading (or being created by `open`) waits instead of being
//! lost in an event nobody listens to yet.

use super::protocol::{ErrorCode, IpcError};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tokio::sync::{oneshot, Notify};

type Answer = Result<Value, IpcError>;

struct Pending {
    label: String,
    tx: oneshot::Sender<Answer>,
}

#[derive(Default)]
struct State {
    ready: HashSet<String>,
    pending: HashMap<String, Pending>,
}

#[derive(Default)]
pub struct WindowBridge {
    state: Mutex<State>,
    ready_changed: Notify,
}

/// Removes the pending request when the asking future is dropped (the command timed out).
struct Cleanup<'a> {
    bridge: &'a WindowBridge,
    id: String,
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        self.bridge.state.lock().pending.remove(&self.id);
    }
}

impl WindowBridge {
    /// The window's web half can take requests now.
    pub fn mark_ready(&self, label: &str) {
        self.state.lock().ready.insert(label.to_string());
        self.ready_changed.notify_waiters();
    }

    /// The window is gone: it is no longer ready and every request it still owed fails.
    pub fn forget(&self, label: &str) {
        let mut state = self.state.lock();
        state.ready.remove(label);
        state.pending.retain(|_, p| p.label != label);
    }

    async fn wait_ready(&self, label: &str) {
        loop {
            let notified = self.ready_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().ready.contains(label) {
                return;
            }
            notified.await;
        }
    }

    /// Ask window `label` for `topic`. `emit(id, topic, payload)` delivers the request; the answer
    /// is the window's reply. Waits for the window to be ready first; the caller bounds the whole
    /// wait with the command's deadline.
    pub async fn ask(
        &self,
        label: &str,
        topic: &str,
        payload: Value,
        emit: impl FnOnce(&str, &str, Value) -> Result<(), String>,
    ) -> Answer {
        self.wait_ready(label).await;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.state.lock().pending.insert(
            id.clone(),
            Pending {
                label: label.to_string(),
                tx,
            },
        );
        let _cleanup = Cleanup {
            bridge: self,
            id: id.clone(),
        };
        emit(&id, topic, payload).map_err(|_| {
            IpcError::new(ErrorCode::Unavailable, "the window could not be reached")
        })?;
        rx.await.map_err(|_| {
            IpcError::new(
                ErrorCode::Unavailable,
                "the window closed before it answered",
            )
        })?
    }

    /// A window's answer. Only the window that was asked can answer; anything else (an unknown
    /// id, another window) is ignored and reported to the caller as `false`.
    pub fn reply(&self, from_label: &str, id: &str, answer: Answer) -> bool {
        let mut state = self.state.lock();
        match state.pending.get(id) {
            Some(p) if p.label == from_label => {}
            _ => return false,
        }
        let Some(p) = state.pending.remove(id) else {
            return false;
        };
        drop(state);
        p.tx.send(answer).is_ok()
    }
}
