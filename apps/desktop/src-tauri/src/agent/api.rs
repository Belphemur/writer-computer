//! What the agent offers to other features (ADR 2026-11-20 "let features cooperate through owned
//! points, optional services and rare requires"): two hook points, one provider point and their
//! contract types, plain data. The agent calls [`crate::features::points::Points::emit`] and
//! [`crate::features::points::Points::ask`] and never learns who listens; with no contributor (the
//! usual case) all calls return at once and the Changes card, its diffs and its Undo behave as they
//! always did.
//!
//! - [`TURN_STARTED`]: a turn is about to begin in a vault. Contributors may block briefly (the
//!   caller is a blocking thread): it is the moment to save what the user has pending, so the
//!   turn's own changes stay separate.
//! - [`TURN_FINISHED`]: a turn is over (also with no change, and when the process died under it),
//!   with the files it changed. Fires once per turn.
//! - [`TURN_BASELINE`] (provider): "these files as they were when the turn started", asked when a
//!   shell command changed files (ADR 2026-11-23 "diff shell-command changes against the
//!   turn-start commit"). An answer is trusted as the file's pre-image (diff and Undo), so a
//!   contributor answers only what it can vouch for; no answer keeps the file "listed without a
//!   diff". Asked from a thread that may block (never the watcher's or the main thread).

use super::backend::Backend;
use crate::features::points::{Point, Provider};
use std::path::PathBuf;
use std::sync::Arc;

/// The core's own backend; every other one comes through [`BACKENDS`].
pub const BACKEND_CLAUDE: &str = "claude";

#[derive(Debug, Clone)]
pub struct TurnStarted {
    /// The vault root (canonical).
    pub root: PathBuf,
    pub chat_id: String,
    /// The chat's turn sequence: the number the turn about to begin carries. The runner advances it
    /// every time the CLI starts a turn, also one that no `turn-started` announces (a message
    /// queued during a turn that runs after it), so a contributor that records the start of this
    /// turn can tell a later question about another turn ([`TurnBaseline::turn`]).
    pub turn: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileChangeKind {
    Add,
    Edit,
    Delete,
    Move,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub kind: FileChangeKind,
    /// Vault-relative, forward slashes; a move's new path.
    pub path: String,
    /// A move's old path.
    pub from: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnFinished {
    pub root: PathBuf,
    pub chat_id: String,
    /// The agent's id of the turn (`TurnChangesSummary.turn_id`): unique per app run, `None` for a
    /// turn that changed no file. A contributor that records its own work for the turn (the Git
    /// history's `Writer-Turn`) uses it, so a Changes card finds it again.
    pub turn_id: Option<String>,
    /// The chat's title when known.
    pub title: Option<String>,
    pub backend: String,
    /// The models the turn ran on, the main agent's first; empty when the backend reported none.
    pub models: Vec<String>,
    pub files: Vec<FileChange>,
}

/// Whether a vault-relative path (forward slashes) is one of the agent's chat notes
/// (`.writer/chats/**/*.md`, `<project>/.chats/*.md`). The one place that knows where chats live;
/// the Git history files them apart from the user's own changes.
pub fn is_chat_note(rel: &str) -> bool {
    super::chat_store::is_chat_note_path(rel)
}

/// Who a chat note is: its id and the title it shows, read from its front matter (never from the
/// file name). `None` for a text that is not a chat note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatNote {
    pub id: String,
    pub title: String,
}

pub fn chat_note(text: &str) -> Option<ChatNote> {
    let meta = super::chat_store::meta_from_text(text).ok()??;
    Some(ChatNote {
        id: meta.chat_id,
        title: meta.title,
    })
}

pub static TURN_STARTED: Point<TurnStarted> = Point::new("agent.turn-started", "agent");
pub static TURN_FINISHED: Point<TurnFinished> = Point::new("agent.turn-finished", "agent");

/// The question of [`TURN_BASELINE`]: the files `paths` (vault-relative, forward slashes) of the
/// vault `root`, as they were when turn number `turn` of chat `chat_id` started. One question per
/// batch of files, so a contributor opens what it reads once. The answer is positional, one entry
/// per path.
#[derive(Debug, Clone)]
pub struct TurnBaseline {
    /// The vault root (canonical).
    pub root: PathBuf,
    pub chat_id: String,
    /// The chat's current turn sequence (see [`TurnStarted::turn`]): a contributor answers only
    /// when it recorded the start of this very turn.
    pub turn: u64,
    pub paths: Vec<String>,
}

/// What a contributor vouches for about a file at the start of the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Baseline {
    /// The file existed with these bytes (at most [`BASELINE_MAX_BYTES`]). The agent decides
    /// whether they are text, by the one rule of what its Changes card shows.
    Bytes(Vec<u8>),
    /// The file did not exist: the command created it.
    Absent,
}

/// The largest text a [`Baseline`] may hold (the Changes card's file cap): a contributor reads no
/// more than this.
pub const BASELINE_MAX_BYTES: u64 = super::changes::MAX_FILE_BYTES;

pub static TURN_BASELINE: Provider<TurnBaseline, Vec<Option<Baseline>>> =
    Provider::new("agent.turn-baseline", "agent");

/// "Give me backend `id`" (the argument is the id a chat note keeps in `writer-chat-backend`): a
/// feature that brings an agent backend answers for its own id with a [`Backend`]. The agent asks
/// when a chat starts and never names who answers; the core's own backend (Claude) is not asked
/// for, and with no answer a chat of that backend says it is not available (the feature is off).
/// Asked from a blocking thread; an answer is cheap.
pub static BACKENDS: Provider<String, Arc<Backend>> = Provider::new("agent.backends", "agent");
