---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Show a chat's changed notes in a compact row above the composer, with a full-session diff tab

## Context and Problem Statement

The agent pane shows what a turn changed in the end-of-turn "Changes" card (`agent/changes.rs`: in-memory pre-images captured before each mutating tool call, diffed at `turn-finished`, with Undo). Over a long chat the user loses track of which notes the chat has touched: each card covers one turn, and cards scroll away. The user asked (2026-11-18) to see every note touched in the chat session compactly above the chat input, next to the running sub-agents tray, and to open a full diff of the whole session for a note in a new tab.

## Decision Drivers

- One change tracker (DRY): the turn card and the session row read the same store.
- Privacy: no note text written to disk or logged; the existing caps and exclusions apply.
- Live: the row updates when a file is written, not only at turn end.
- Links follow the [link activation ADR](2026-11-17-open-every-link-like-a-browser-link-through-one-link-activation-module.md).
- Settings and UI stay terse.

## Considered Options

- A. A row in the composer tray plus a "Session changes" tab, session baselines kept in memory.
- B. The same, with baselines saved with the chat (`.chats/.baselines/`).
- C. Per-turn only (today).

## Decision Outcome

Chosen option: **A**.

1. **Row**: one compact line in the tray above the composer ([sub-agent tray ADR](2026-11-18-track-sub-agent-lifecycle-from-the-clis-completion-signal-and-show-running-sub-agents-in-a-tray-above-the-composer.md)), below the running sub-agents: "✎ Changed N notes · +A −D" with an expand chevron. Expanded, one row per note: icon, name, folder, +/− counts, created, renamed or deleted marks. Scope: the whole chat, every turn, sub-agent edits included, updated live on each write.
2. **Actions**: a click on a row opens the note through the link activation bindings (middle and Cmd/Ctrl+click open a new tab). "Diff" opens the **Session changes** page kind in a new tab: the diff of every note this chat changed against its first-touch version, scrolled to the chosen note, reusing the Changes card's diff renderer. A deleted note shows its removed text; a created note its added text.
3. **Close**: an × hides the row; it reappears automatically on the chat's next write to any note.
4. **Baselines**: the first pre-image captured for a path in a chat is kept as that chat's session baseline, in memory only (`changes.rs`), within the existing limits (`MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, binary and over-size files listed without a diff, memory folders never tracked, paths confined). The chat note stores only the list (path, kind, counts), never text. After Writer restarts, the list and counts are restored and the diff runs from the first touch since the restart, marked "since Writer restarted".
5. **One source**: `changes.rs` owns per-turn and session data; the runner emits a session-changes event on each captured write and at turn end; the web keeps one per-chat selector both the row and the tab read.

### Consequences

- Good: the user sees every touched note at a glance and can review the whole session's effect on a note.
- Bad: session baselines raise memory use for long chats (bounded by the existing total cap; the oldest data is dropped first, as today).
- Neutral: after a restart the session diff starts over.

### Non-goals

- Undo from the row (Undo stays on the turn's Changes card).
- Adding a note as an `@` mention from the row.
- Tracking files changed only through Bash (unchanged: not seen).
- Persisting note text to disk.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/agent/changes.rs` (session baseline per chat and path, session summary and detail, live summary on capture/write), `runner.rs` (emit the event), `events.rs` and `features/agent/web/lib/events.ts`, the agent feature commands for the session detail (`features/agent/rust/commands/`, bindings regenerated with `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), chat note persistence (`agent/chat_store.rs`, `features/agent/web/lib/chat-note.ts`, `chat-from-note.ts`) for the list, `features/agent/web/components/` (a changed-notes row in the tray component, the Session changes page kind registered through the feature's page-kind contribution, reusing the Changes card diff component), `SPECs/native-agent-spec.md` "Turn changes" and tray sections, `CHANGELOG.md`.
- **Patterns to follow**: snapshot-before-write in `changes.rs`; one selector per chat; link activation for opens; page kinds through the feature contribution point; theme tokens; terse labels.
- **Patterns to avoid**: a second tracker or diff renderer; writing note text to disk; logging paths or text.
- **Tests**: Rust: first-touch baseline kept across turns, later turns do not move it, sub-agent edit counted, create/rename/delete kinds, caps and exclusions, session detail diff against the baseline, live event on write. TS: row appears on first write, counts update, expand list, open via link activation (middle click new tab), Diff opens the tab scrolled to the note, close then a new write brings it back, restore from the note shows list and counts with "since Writer restarted".

### Verification

- [ ] The row appears on the chat's first write and counts across turns, sub-agent edits included.
- [ ] Closing it, then a new write, brings it back.
- [ ] "Diff" opens a Session changes tab showing each note against its first-touch version.
- [ ] After reopening the chat, the list and counts remain and the diff is marked "since Writer restarted".
- [ ] No note text is written to disk or logged.

## Pros and Cons of the Options

### A. Row and tab, memory baselines

- Good, because it reuses the change store and writes no note text.
- Bad, because the session diff restarts with Writer.

### B. Baselines saved with the chat

- Good, because the diff survives restarts.
- Bad, because copies of old note text stay in the vault; the user declined it.

### C. Per-turn only

- Good, because nothing to build.
- Bad, because the user cannot see the session's footprint.

## More Information

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) "Turn changes". Related: [first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [chats as notes](2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md), [sub-agent tray](2026-11-18-track-sub-agent-lifecycle-from-the-clis-completion-signal-and-show-running-sub-agents-in-a-tray-above-the-composer.md). Revisit if users need the session diff to survive restarts.
