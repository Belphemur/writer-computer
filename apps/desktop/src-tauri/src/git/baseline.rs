//! The turn-start baseline (ADR 2026-11-23 "Diff shell-command changes against the turn-start
//! commit"): what the Git history can vouch for about a file as it was when an agent turn began.
//! Tauri-free and agent-free (the glue in `features/git/rust/runtime.rs` maps it onto the agent's
//! `agent.turn-baseline` point). Never a guess: [`record`] runs once the user's pending edits
//! are committed and notes the commit and what is still not in it; [`answer`] gives the text of a
//! file only when that commit holds exactly what the file was, and nothing otherwise (a file
//! that was uncommitted, ignored, outside what Writer versions, too large, binary, or a folder).

use super::repo::{Repo, TextAt};
use std::collections::BTreeSet;
use std::path::Path;

/// The repository at the start of one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStart {
    /// HEAD when the turn began.
    pub commit: String,
    /// The paths the working tree still differed from `commit` in (or that are not versioned).
    pub uncommitted: BTreeSet<String>,
}

/// What a file was at the start of a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vouched {
    Text(String),
    /// The file did not exist.
    Absent,
}

/// Notes the turn start of the vault at `root`, after the caller committed the user's edits.
/// `None` when the history cannot vouch for anything: not a repository of its own (a vault
/// inside a parent repository), no commit yet, a merge, rebase or detached HEAD, a sync to finish,
/// or no git identity (the commit before the turn could not have run).
pub fn record(root: &Path) -> Option<TurnStart> {
    if !super::is_set_up(root) || super::operation(root).is_some() || super::sync::interrupted(root)
    {
        return None;
    }
    let repo = Repo::open(root).ok()??;
    repo.identities().ok()?;
    Some(TurnStart {
        commit: repo.head_id_string()?,
        uncommitted: repo.uncommitted().ok()?,
    })
}

/// The text of `rel` (vault-relative) at `start`, at most `max_bytes`, or `None` when it cannot be
/// vouched for.
pub fn answer(root: &Path, start: &TurnStart, rel: &str, max_bytes: u64) -> Option<Vouched> {
    if start.uncommitted.contains(rel) {
        return None;
    }
    let repo = Repo::open(root).ok()??;
    if repo.is_foreign(rel) {
        return None;
    }
    match repo.text_at(&start.commit, rel, max_bytes).ok()? {
        TextAt::Text(text) => Some(Vouched::Text(text)),
        // not in the commit and not pending at the start: it did not exist, unless it was a file
        // git ignores (those are in neither list)
        TextAt::Absent if !repo.is_ignored(rel) => Some(Vouched::Absent),
        TextAt::Absent | TextAt::Unreadable => None,
    }
}
