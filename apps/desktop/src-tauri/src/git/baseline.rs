//! The turn-start baseline (ADR 2026-11-23 "Diff shell-command changes against the turn-start
//! commit"): what the Git history can vouch for about a file as it was when an agent turn began.
//! Tauri-free and agent-free (the glue in `features/git/rust/runtime.rs` maps it onto the agent's
//! `agent.turn-baseline` point). Never a guess: [`record`] runs once the user's pending edits
//! are committed and notes the commit and what is still not in it; [`answer`] gives the bytes of
//! a file only when that commit holds exactly what the file was, and nothing otherwise (a file
//! that was uncommitted, ignored, outside what Writer versions, too large, converted between blob
//! and disk, a folder or a link). Whether the bytes are text is the reader's rule, not git's.

use super::lfs::Lfs;
use super::repo::{fold_name, BaselineAt, Repo};
use std::collections::BTreeSet;
use std::path::Path;

/// The repository at the start of one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStart {
    /// HEAD when the turn began (read once; `uncommitted` is against this commit).
    pub commit: String,
    /// The paths the working tree still differed from `commit` in, or that git cannot vouch for
    /// (see `Repo::uncommitted_at`).
    pub uncommitted: BTreeSet<String>,
}

impl TurnStart {
    /// Is `rel` pending under another spelling (case, Unicode normalization) than its own?
    fn pending_variant(&self, rel: &str) -> bool {
        let key = fold_name(rel);
        self.uncommitted.iter().any(|u| fold_name(u) == key)
    }
}

/// What a file was at the start of a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vouched {
    Bytes(Vec<u8>),
    /// The file did not exist.
    Absent,
}

/// Notes the turn start of the vault at `root`, after the caller committed the user's edits (and
/// while it holds the repository's write lock, so nothing moves under it). `lfs` is what that
/// commit ran under. `None` when the history cannot vouch for anything: not a repository of its
/// own (a vault inside a parent repository), no commit yet, a merge, rebase or detached HEAD, or
/// a sync to finish. Soundness does not rest on the commit having run: what it could not take is
/// in `uncommitted`.
pub fn record(root: &Path, lfs: Lfs) -> Option<TurnStart> {
    if !super::is_set_up(root) || super::operation(root).is_some() || super::sync::interrupted(root)
    {
        return None;
    }
    let repo = Repo::open_with(root, lfs).ok()??;
    let commit = repo.head_id_string()?;
    let uncommitted = repo.uncommitted_at(&commit).ok()?;
    Some(TurnStart {
        commit,
        uncommitted,
    })
}

/// What each of `paths` (vault-relative) was at `start`, positionally, at most `max_bytes` each;
/// `None` where it cannot be vouched for. One repository open per call.
pub fn answer(
    root: &Path,
    start: &TurnStart,
    paths: &[String],
    max_bytes: u64,
) -> Vec<Option<Vouched>> {
    let mut out: Vec<Option<Vouched>> = vec![None; paths.len()];
    let open: Vec<usize> = (0..paths.len())
        .filter(|i| !start.uncommitted.contains(&paths[*i]))
        .collect();
    if open.is_empty() {
        return out;
    }
    let Ok(Some(repo)) = Repo::open(root) else {
        return out;
    };
    let refs: Vec<&str> = open.iter().map(|i| paths[*i].as_str()).collect();
    for (i, found) in open
        .into_iter()
        .zip(repo.baselines_at(&start.commit, &refs, max_bytes))
    {
        out[i] = match found {
            BaselineAt::Bytes(bytes) => Some(Vouched::Bytes(bytes)),
            // a file pending under a variant of its name may be this very file
            BaselineAt::Absent if !start.pending_variant(&paths[i]) => Some(Vouched::Absent),
            BaselineAt::Absent | BaselineAt::Unknown => None,
        };
    }
    out
}
