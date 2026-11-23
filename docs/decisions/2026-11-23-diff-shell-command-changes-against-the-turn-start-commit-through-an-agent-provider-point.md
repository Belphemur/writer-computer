---
status: accepted
date: 2026-11-23
decision-makers: Writer maintainers
---

# Diff shell-command changes against the turn-start commit, through an agent provider point

## Context and Problem Statement

The agent's Changes card, the changed-notes row and the Session changes tab list files a `Bash` call changed as "by command", with no diff and no Undo, because `agent/changes.rs` only has a pre-image for files an `Edit`/`MultiEdit`/`Write`/`NotebookEdit` call snapshotted before it ran (`SPECs/native-agent-spec.md` 6.5, "Files changed by a shell command"). The user (2026-11-23): "Since we have git diff, the agent should be able to use it to show session diff too when the git plugin is enabled. We should be able to see real diff from the by command changes."

With the `git` feature on, `agent.turn-started` commits the user's pending edits before the turn runs (`features/git/rust/runtime.rs` `turn_started`, no user commit until the turn ends), so the turn-start commit holds every committed file's text from just before the turn. That is a trustworthy pre-image for a file a command changed, under conditions.

## Decision Drivers

- Off must degrade, never break (`.agents/skills/writer-feature/SKILL.md`): with git off, not set up, or unable to answer, the card behaves exactly as today.
- The agent never names git (ADR 2026-11-20 "let features cooperate through owned points, optional services and rare requires"): the agent owns the point, git contributes.
- Never a guessed diff: a wrong pre-image shows a false diff and an Undo that would write wrong text.
- One store: the turn card, the row and the tab keep reading `ChangeStore`.

## Considered Options

- A. An agent-owned **provider point** `agent.turn-baseline`: the agent asks "the text of `path` as it was when turn T started"; git answers from the turn-start commit, or not at all.
- B. A `git.history` service the agent looks up (`fileAt(rev, path)`): the agent would have to know about revisions and the turn-start commit, which is git's knowledge.
- C. The agent snapshots the whole vault at turn start: memory and IO per turn for every vault, git or not.

## Decision Outcome

Chosen: **A**, with the user's answers (2026-11-23): diff **and Undo**; when git cannot vouch for the pre-image the file stays "listed without a diff".

1. **The point.** `agent/api.rs` declares `TURN_BASELINE`, the first provider of `features/points.rs` (built here, as that module said: "they land with their first user"). Args: `{ root, chat_id, turn_id (the agent's key for the turn's start), path (vault-relative) }`. Answer: `Baseline::Text(String)` (the file existed with this text), `Baseline::Absent` (the file did not exist: the command created it), or no answer. The first live contributor that answers wins (id order); a panic fails the contributor (`features::guard`) and counts as no answer. No contributor: no answer, at once.
2. **Git records the turn start.** In `turn_started`, after `commit_user_now`, git stores per chat the HEAD commit id **and** the set of paths that were still not committed (the status after the commit: skipped large files, ignored files, anything the commit could not take). When the commit could not run (no identity, paused during a merge/rebase/detached HEAD, a sync holding the repo, history stopped, vault inside a parent repo), git stores nothing for that turn. The record is in memory, dropped when the chat's next turn starts, its vault closes, or git stops.
3. **Git answers only what it can vouch for.** For `path`: a record for the chat's turn exists, the path is not in the not-committed set, not ignored, not an LFS pointer over the agent's size cap → the blob at the recorded commit (`Text`), or `Absent` when the commit has no such path and it was not untracked at turn start. Anything else: no answer. Reads go through `git/repo.rs` (the only gix code), bounded by `changes::MAX_FILE_BYTES`.
4. **The agent asks when it records a command change.** `ChangeStore::record_command_changes` (off the watcher thread already) asks the point for each newly recorded path; an answer becomes an ordinary snapshot (`Snap::Text` / absent), so the diff, counts, statuses (Created/Modified/Deleted, renames) and **Undo** follow the existing code and its end-image check (Undo refuses when the file changed after the turn). The session baseline takes the same answer when the path has no baseline yet. No answer: `Snap::Unknown(Command)`, today's row.
5. **Marks.** A command-changed file with a baseline keeps the "by command" marker (the watcher cannot say which process wrote: another chat or a terminal may have), now with counts, the diff and Undo; the marker's tooltip says "Changed while a shell command was running; compared with the version from before the turn". The footer line "Files it changed are listed without a diff" shows only when at least one command file has no baseline.

### Consequences

- Good: with git on (the default), command changes get real diffs and Undo in the card, the row and the Session changes tab; with git off nothing changes.
- Good: the first provider point lands with a real user and a contract test.
- Bad: a user's own edit to a file during the turn (no user commit while a turn runs) is part of that file's diff, as it already is for files edited by tools; Undo still refuses if the file changed after the turn ended.
- Bad: with two chats running commands at once, both cards show the same file's diff (as both list it today).

## Implementation Plan

- **Affected paths:** `src-tauri/src/features/points.rs` (provider: `ProviderPoint<A, T>`, `provide`/`ask`, liveness and guard as for hooks, retract on stop), `src-tauri/src/agent/api.rs` (`TURN_BASELINE`, `TurnBaseline`, `Baseline`), `src-tauri/src/agent/changes.rs` (`record_command_changes` takes an asker, typed as a closure so the core stays Tauri-free), the runner/config-worker call site that feeds watcher batches, `features/git/rust/{mod.rs,runtime.rs}` (record at turn start, `provide` in `start`), `src-tauri/src/git/repo.rs` (blob at a commit, bounded), `features/agent/web/lib/diff-rows.ts` and `components/{change-parts.tsx,turn-changes-card.tsx}` (tooltip and footer text), `SPECs/native-agent-spec.md` 6.5, `SPECs/git-sync-spec.md` "With the agent", `features/points.rs` module doc.
- **Tests:** points: provider with no contributor, first answer wins in id order, a non-live or panicking contributor is skipped, retract on stop. Changes core with a fake asker: command file with `Text` gets a diff and an Undo that restores it; `Absent` shows as created and Undo deletes; no answer keeps today's row; an edit-snapshotted file keeps its snapshot; the session baseline uses the answer. Git (temp repo, temp HOME): turn start records HEAD; a dirty file the commit skipped (over size, ignored) gets no answer; no identity or a merge in progress gets no answer; a file created during the turn answers `Absent`; record dropped at the next turn and on stop. An end-to-end test through the fake claude: a `Bash` call that rewrites a note, card shows the diff and Undo with git on, and the old row with git off.

## Verification

- [ ] With git on, a turn whose `Bash` call rewrites a note shows that note's diff and Undo in the card, the row and the Session changes tab.
- [ ] With git off, or no git identity, the same turn shows "listed without a diff" as before.
- [ ] Undo of a command change restores the turn-start text and refuses after a later edit.
- [ ] `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check` green.

## More Information

- Related: `2026-11-18-show-a-chats-changed-notes-in-a-compact-row-above-the-composer-with-a-full-session-diff-tab.md`, `2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md`, `2026-11-20-let-features-cooperate-through-owned-points-optional-services-and-rare-requires.md`.
