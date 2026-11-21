//! The cadence state machine (spec "Cadence"), pure: time is an argument, so the tests drive it
//! with a fake clock and the feature glue calls it once a second.
//!
//! - A user commit is due after `quiet` with no write in the vault by anyone (the editor's
//!   autosave, a lint fix, an external app): every write resets the timer, so a lint fix that
//!   lands 5 s after typing stops is part of the same commit.
//! - Never while an agent turn runs in the vault. When the turn ends, its commit goes first, then
//!   the quiet timer resumes for the rest.
//! - Manual (`quiet == None`) never fires by itself.
//! - Paused never fires.

use super::message::AgentTurnInfo;
use std::time::{Duration, Instant};

/// What the finished agent turn needs to be committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTurn {
    pub chat_id: String,
    /// The agent's id of the turn (`Writer-Turn`), when it has one.
    pub turn_id: Option<String>,
    pub backend: String,
    pub title: String,
    pub models: Vec<String>,
    /// Vault-relative paths the turn changed (a rename names both ends).
    pub files: Vec<String>,
}

impl AgentTurn {
    pub fn info(&self) -> AgentTurnInfo<'_> {
        AgentTurnInfo {
            chat_id: &self.chat_id,
            turn_id: self.turn_id.as_deref(),
            backend: &self.backend,
            models: &self.models,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Nothing,
    /// Commit the user's pending changes.
    CommitUser,
    /// Commit the finished turn's files.
    CommitAgent(AgentTurn),
}

#[derive(Debug, Default)]
pub struct Cadence {
    last_write: Option<Instant>,
    /// A write since the last user commit.
    dirty: bool,
    /// Agent turns running in the vault (a chat each).
    turns_running: usize,
    ended: Vec<AgentTurn>,
}

impl Cadence {
    pub fn new() -> Cadence {
        Cadence::default()
    }

    /// Something was written in the vault.
    pub fn on_write(&mut self, now: Instant) {
        self.last_write = Some(now);
        self.dirty = true;
    }

    pub fn turn_started(&mut self) {
        self.turns_running += 1;
    }

    /// A turn is over. `commit` is its commit when it changed files and agent commits are on.
    pub fn turn_ended(&mut self, commit: Option<AgentTurn>) {
        self.turns_running = self.turns_running.saturating_sub(1);
        self.ended.extend(commit);
    }

    pub fn turn_running(&self) -> bool {
        self.turns_running > 0
    }

    /// Whether anything was written since the last user commit.
    pub fn dirty(&self) -> bool {
        self.dirty
    }

    /// A user commit just ran (the timer, "Commit now", close, before a turn).
    pub fn committed(&mut self) {
        self.dirty = false;
    }

    /// What is due at `now`. `quiet` is `git.commit-after`, `None` for Manual.
    pub fn tick(&mut self, now: Instant, quiet: Option<Duration>, paused: bool) -> Action {
        if paused || self.turn_running() {
            return Action::Nothing;
        }
        if !self.ended.is_empty() {
            return Action::CommitAgent(self.ended.remove(0));
        }
        let (Some(quiet), Some(last)) = (quiet, self.last_write) else {
            return Action::Nothing;
        };
        if self.dirty && now.duration_since(last) >= quiet {
            self.dirty = false;
            return Action::CommitUser;
        }
        Action::Nothing
    }
}
