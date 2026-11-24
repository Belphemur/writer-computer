//! The seam between a chat's state machine and the backend it talks to (spec
//! `SPECs/opencode-backend-spec.md` section 5). Tauri-free.
//!
//! [`Session`](super::runner::Session) owns what a chat is: the queue, steer and cancel, busy,
//! restarts, sub-agents, changes and the title. A [`Transport`] owns how one backend carries it:
//! `StdioTransport` (`stdio_transport.rs`) starts and feeds the `claude` process;
//! the OpenCode transport (phase 2) drives a server. One trait, because `Session` makes all of
//! these calls and each transport implements all of them.
//!
//! Outbound, the `Session` calls the methods below. Inbound, each transport maps what its backend
//! says with its own pure mapper and pushes [`Inbound`] into one channel per chat, which the
//! `Session` reads in its single event loop. Every message carries the generation (`gen`) of the
//! start it belongs to: a message of a connection the `Session` has since replaced is dropped.
//!
//! The words a user reads when a transport fails are the transport's ([`Phrases`]): the `Session`
//! names no backend.

use super::events::*;
use super::files::FilePart;
use super::mcp_wiring::McpWiring;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

/// Why a connection could not be started. All of them become an `error` event for the chat (the
/// pane's error cards), none of them an IPC rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    NotFound,
    /// The window already has the most live connections it may have.
    Busy,
    Invalid(String),
    /// The program could not be run (Claude: the exec failed, seen before `start` returned).
    Failed {
        kind: AgentErrorKind,
        message: String,
        retryable: bool,
    },
    Ended,
    /// What the connection ran on is gone for good (its server was stopped with the feature or
    /// the window): the chat's session ends, and the next start of the chat asks for its backend
    /// again instead of reusing this one.
    Gone,
}

/// What a backend says to the user when it fails, in its own words (the program is named here and
/// nowhere in the state machine).
#[derive(Debug)]
pub struct Phrases {
    /// The program to start was not found.
    pub not_found: &'static str,
    /// The connection ended while the chat was idle (retryable: the next message restarts it).
    pub exited_idle: &'static str,
    /// The connection ended during a turn; the chat resumes.
    pub connection_lost: &'static str,
    /// The turn the connection ended under, for the transcript.
    pub ended_in_turn: &'static str,
    /// The connection keeps ending: the chat stops retrying.
    pub keeps_exiting: &'static str,
    /// A cancel of a waiting message got no answer.
    pub no_answer: &'static str,
}

/// How a message reaches the backend, and what it is to the running turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery<'a> {
    /// Starts a turn (the chat was idle); `receipt` is its id, kept by the `Session` through a
    /// replay (a backend that tracks items by id uses it; Claude ignores it).
    Start { receipt: &'a str },
    /// Cuts the running step and starts this message's turn; `receipt` is its tracking id.
    Steer { receipt: &'a str },
    /// Joins the running turn at the next boundary, or runs after it; `receipt` is its tracking id.
    Queued { receipt: &'a str },
}

/// One message to the backend.
#[derive(Debug, Clone, Copy)]
pub struct Outbound<'a> {
    pub text: &'a str,
    pub files: &'a [FilePart],
    pub delivery: Delivery<'a>,
}

/// The backend has admitted a message (Claude: it was written; OpenCode: the prompt call's 200).
/// "Taken" is a later fact ([`Mapped::taken`]).
///
/// Claude's two ids are the same, so the `Session` does not read this yet: it keeps the field for
/// a backend whose own id differs from the one Writer tracks (OpenCode's message id), where the
/// `Session` must map the backend's "taken" back to `message_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    /// The id the `Session` tracks the message by (the one in [`Delivery`]; empty for a start).
    pub message_id: String,
    /// The id the backend knows it by (Claude: the same).
    pub backend_id: String,
}

/// The answer to a permission request.
#[derive(Debug, Clone, Copy)]
pub enum PermissionReply<'a> {
    /// Run it: the call's own input, and what the user chose to keep. `suggestions` are the
    /// backend's own proposals for this request; each transport turns the neutral choice
    /// (`persist`, the ticked `rules`) into its backend's persistence (Claude: the rebuilt
    /// `updatedPermissions` of `permission_update::updated_permissions`; OpenCode: `always`, or
    /// rules of the session).
    Allow {
        input: &'a Value,
        persist: Option<PermissionPersist>,
        rules: Option<&'a [String]>,
        suggestions: &'a [Value],
    },
    Deny {
        message: &'a str,
    },
}

/// How a live change of the connection ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveChange {
    /// Applied (or on its way: a refusal arrives as [`Message::Refused`]).
    Applied,
    /// Only a restart applies it: the `Session` restarts at the next idle moment.
    Restart,
}

/// What `set_model` is asked: the model and effort now wanted, and what changed.
#[derive(Debug, Clone)]
pub struct ModelChange {
    pub model: Option<String>,
    pub effort: Option<Effort>,
    pub model_changed: bool,
    pub effort_changed: bool,
}

/// How the `Session` stops a connection (it owns the timers that escalate).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Close {
    /// Let it finish: no more input.
    Graceful,
    /// Ask it to stop.
    Terminate,
    /// Stop it now.
    Kill,
}

/// A cancel of a waiting message got no answer in time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unanswered;

/// What a start needs: the generation, the session to open and the launch settings (refreshed by
/// every `agent_start`, kept by the `Session`).
pub struct StartRequest<'a> {
    pub gen: u64,
    pub session_id: &'a str,
    /// Open `session_id` again instead of creating it.
    pub resume: bool,
    pub launch: &'a LaunchConfig,
}

/// Settings of the next start, refreshed by every `agent_start`.
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub program: Option<PathBuf>,
    pub cli_version: Option<String>,
    pub system_prompt: Option<String>,
    pub add_dirs: Vec<String>,
    /// The roles rendered for the backend (Claude: the `--agents` JSON), `None` when
    /// orchestration is off.
    pub agents: Option<String>,
    /// Directory holding the `writer` launcher, put first on the child's PATH (`cli_launcher`);
    /// `None` when there is none.
    pub cli_dir: Option<PathBuf>,
    /// The memory folder of this chat (`agent.memory` = `vault`), created already.
    pub memory_dir: Option<PathBuf>,
    /// Writer's own MCP server for the chat (`mcp_wiring`), `None` without a launcher.
    pub mcp: Option<McpWiring>,
    pub settings: AgentSettings,
    /// The backend's `RoleAdapter::restart_on_config_change`.
    pub restart_on_config_change: bool,
}

/// One inbound message of a chat's transport.
#[derive(Debug)]
pub struct Inbound {
    pub gen: u64,
    pub message: Message,
}

/// What the transport reports. The mapped output of one backend message is one [`Mapped`].
#[derive(Debug)]
pub enum Message {
    /// The connection is up (Claude: the child's process id).
    Started {
        pid: Option<u32>,
    },
    Mapped(Mapped),
    /// A live change (a model or a permission mode) was refused: a restart applies it.
    Refused,
    /// [`Transport::unqueue`] was confirmed for this receipt. Sent in order with the other
    /// messages, so a turn that ends right after the confirmation is settled after it.
    Unqueued {
        receipt: String,
    },
    /// The start failed after `start` returned (Claude: the exec failed).
    StartFailed {
        kind: AgentErrorKind,
        message: String,
        retryable: bool,
    },
    /// The connection ended; the last message of a generation.
    Ended(Ended),
}

/// The neutral output of mapping one backend message. `events` go to the pane as they are (after
/// the sub-agent tracker has seen them); `tasks` are facts for the tracker (`TaskSignal`), never
/// `Subagent*` events.
#[derive(Debug, Default, PartialEq)]
pub struct Mapped {
    pub events: Vec<AgentEvent>,
    pub tasks: Vec<TaskSignal>,
    /// The backend took a message written mid-turn (Claude: the user echo; OpenCode:
    /// `inbox.delivered`): its receipt id.
    pub taken: Option<String>,
    /// The backend accepted a message and will run it, which can be long before it is taken.
    pub accepted: Option<String>,
}

/// How a connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: Option<i32>,
    pub signal: Option<String>,
    /// The backend said it does not know the session that was resumed.
    pub session_unknown: bool,
}

/// What a connection is to the `Session`.
///
/// The `Session` may call every method except [`Transport::start`] and [`Transport::unqueue`]
/// while holding its state lock, so those methods must not wait on I/O, on a thread that needs
/// the lock, or on the backend: they hand work to the transport's own writer or return at once.
/// Only `start` (called without the lock; it may run a login shell or spawn) and `unqueue`
/// (called without the lock; it waits for the answer) may block. Everything the backend says
/// comes back through the inbound channel.
pub trait Transport: Send + Sync {
    /// The words a user reads when this transport fails.
    fn phrases(&self) -> &'static Phrases;

    /// Opens the connection (Claude: spawns the child; OpenCode: creates the session at the first
    /// send). Everything that follows comes back as [`Inbound`] with `req.gen`.
    fn start(&self, req: &StartRequest<'_>) -> Result<(), SpawnError>;

    /// Hands one message over. The returned receipt says it was admitted.
    fn send(&self, msg: &Outbound<'_>) -> Receipt;

    /// Takes a queued message back before the backend took it, waiting up to `wait` for the
    /// answer: `true` when it was still waiting and is gone, `false` when the backend took it.
    /// Never answers `true` without the backend's confirmation, and then it has already sent
    /// [`Message::Unqueued`] (the `Session` forgets the message there, in order with the rest).
    fn unqueue(&self, receipt: &str, wait: Duration) -> Result<bool, Unanswered>;

    /// [`Transport::unqueue`] without waiting, for a message that is forgotten anyway (a stopped
    /// turn): best effort, no answer.
    fn discard(&self, receipt: &str);

    /// Asks the running turn to stop.
    fn interrupt(&self);

    fn answer_permission(&self, request_id: &str, reply: PermissionReply<'_>);

    /// Answers an open question (`None`: declined). `false`: the transport does not know it.
    fn answer_question(&self, request_id: &str, answers: Option<&[QuestionAnswer]>) -> bool;

    /// Switches the model live where the backend can.
    fn set_model(&self, change: &ModelChange) -> LiveChange;

    fn set_permission_mode(&self, mode: AgentPermissionMode);

    /// Replaces the connection by a fresh one that re-reads its configuration: Claude stops the
    /// process and the `Session`'s exit path starts the next.
    fn reload(&self) {
        self.close(Close::Terminate);
    }

    fn close(&self, how: Close);
}

/// What a transport is built from.
pub struct TransportInit {
    pub procs: std::sync::Arc<crate::plugin_proc::ProcManager>,
    pub label: String,
    pub root: PathBuf,
    pub cwd: PathBuf,
    /// The chat's project (vault-relative), for the start's log line.
    pub project_path: Option<String>,
    pub spawner: crate::features::scope::Spawner,
    /// Where the transport pushes everything its backend says.
    pub inbound: std::sync::mpsc::Sender<Inbound>,
}
