//! What the agent offers to other features (ADR 2026-11-20 "let features cooperate through owned
//! points, optional services and rare requires"): two hook points and their contract types, plain
//! data. The agent calls [`crate::features::points::emit`] and never learns who listens; with no
//! contributor (the usual case) both calls return at once and the Changes card, its diffs and its
//! Undo behave as they always did.
//!
//! - [`TURN_STARTED`]: a turn is about to begin in a vault. Contributors may block briefly (the
//!   caller is a blocking thread): it is the moment to save what the user has pending, so the
//!   turn's own changes stay separate.
//! - [`TURN_FINISHED`]: a turn is over (also with no change, and when the process died under it),
//!   with the files it changed. Fires once per turn.

use crate::features::points::Point;
use std::path::PathBuf;

/// The one backend today; the contract names it so a second backend adds a value, not a field.
pub const BACKEND_CLAUDE: &str = "claude";

#[derive(Debug, Clone)]
pub struct TurnStarted {
    /// The vault root (canonical).
    pub root: PathBuf,
    pub chat_id: String,
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

pub static TURN_STARTED: Point<TurnStarted> = Point::new("agent.turn-started", "agent");
pub static TURN_FINISHED: Point<TurnFinished> = Point::new("agent.turn-finished", "agent");
