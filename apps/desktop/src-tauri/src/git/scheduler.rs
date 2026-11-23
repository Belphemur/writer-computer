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
    /// Chats with a turn running in the vault, with when it started: a set, so a start or a finish
    /// seen twice (or a finish never seen) cannot leave a count stuck.
    running: std::collections::HashMap<String, Instant>,
    /// Turns dropped for running longer than [`TURN_CAP`] (their finish never came).
    expired: usize,
    ended: Vec<AgentTurn>,
    /// No commit is tried before this (after a failed signature).
    hold_until: Option<Instant>,
}

/// A turn that has not finished after this long is taken as lost (the agent was turned off or
/// died under it), so the user's commits are not blocked for ever.
pub const TURN_CAP: Duration = Duration::from_secs(30 * 60);

/// How long commits wait after a signature failed.
pub const SIGN_RETRY: Duration = Duration::from_secs(60);

impl Cadence {
    pub fn new() -> Cadence {
        Cadence::default()
    }

    /// Something was written in the vault.
    pub fn on_write(&mut self, now: Instant) {
        self.last_write = Some(now);
        self.dirty = true;
    }

    /// A turn of `chat` started (again: one entry per chat).
    pub fn turn_started(&mut self, chat: &str, now: Instant) {
        self.running.insert(chat.to_string(), now);
    }

    /// A turn of `chat` is over (a chat not known to be running changes nothing but the queue).
    /// `commit` is its commit when it changed files and agent commits are on.
    pub fn turn_ended(&mut self, chat: &str, commit: Option<AgentTurn>) {
        self.running.remove(chat);
        self.ended.extend(commit);
    }

    /// How many lost turns were dropped since the last call (for the log).
    pub fn take_expired(&mut self) -> usize {
        std::mem::take(&mut self.expired)
    }

    /// A turn's commit that could not run yet (a sync owns the repository): first in line again.
    pub fn requeue(&mut self, turn: AgentTurn) {
        self.ended.insert(0, turn);
    }

    /// A commit could not be signed (a locked key, a refused prompt): nothing is lost, the changes
    /// stay pending and the turn's commit (`turn`) goes first in line again, but nothing is tried
    /// before [`SIGN_RETRY`] has passed, so a signer that prompts is not asked every second.
    pub fn signing_failed(&mut self, now: Instant, turn: Option<AgentTurn>) {
        self.dirty = true;
        self.last_write = Some(now);
        self.hold_until = Some(now + SIGN_RETRY);
        if let Some(turn) = turn {
            self.requeue(turn);
        }
    }

    pub fn turn_running(&self) -> bool {
        !self.running.is_empty()
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
        let before = self.running.len();
        self.running
            .retain(|_, t| now.duration_since(*t) < TURN_CAP);
        self.expired += before - self.running.len();
        if paused || self.turn_running() {
            return Action::Nothing;
        }
        match self.hold_until {
            Some(until) if now < until => return Action::Nothing,
            _ => self.hold_until = None,
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

/// How long after a commit the sync runs (spec "Cadence": about 10 s).
pub const SYNC_AFTER_COMMIT: Duration = Duration::from_secs(10);

/// When a sync is due (spec "Cadence" > Sync), pure like [`Cadence`]: about 10 s after each
/// commit, every `git.sync-interval`, when the vault opens and on "Sync now". `interval == None`
/// (Manual) leaves only "Sync now". A trigger that finds the sync not allowed (no remote, paused,
/// a merge under way, a turn running) is skipped until the next trigger; a sync that fails is tried
/// again after one interval, not on the next tick.
#[derive(Debug, Default)]
pub struct SyncTimer {
    after_commit: Option<Instant>,
    opened: bool,
    requested: bool,
    last_attempt: Option<Instant>,
}

impl SyncTimer {
    pub fn new() -> SyncTimer {
        SyncTimer::default()
    }

    /// The vault was opened: sync once soon.
    pub fn on_open(&mut self) {
        self.opened = true;
    }

    /// A commit was made at `now`.
    pub fn on_commit(&mut self, now: Instant) {
        self.after_commit = Some(now + SYNC_AFTER_COMMIT);
    }

    /// "Sync now".
    pub fn request(&mut self) {
        self.requested = true;
    }

    /// Whether to sync at `now`. `allowed`: there is a remote, sync is not paused and nothing is
    /// in the way, asked only when a trigger is due. A due trigger is consumed and counts as an attempt
    /// whether or not it was allowed.
    pub fn tick(
        &mut self,
        now: Instant,
        interval: Option<Duration>,
        allowed: impl FnOnce() -> bool,
    ) -> bool {
        let automatic = interval.is_some_and(|every| {
            self.opened
                || self.after_commit.is_some_and(|t| now >= t)
                || self
                    .last_attempt
                    .is_some_and(|last| now.duration_since(last) >= every)
        });
        if !(self.requested || automatic) {
            return false;
        }
        // due: the triggers are used up whether or not it may run (a vault with no remote or a
        // paused sync is not asked again every second; the next trigger or interval asks)
        self.requested = false;
        self.opened = false;
        self.after_commit = None;
        self.last_attempt = Some(now);
        allowed()
    }
}
