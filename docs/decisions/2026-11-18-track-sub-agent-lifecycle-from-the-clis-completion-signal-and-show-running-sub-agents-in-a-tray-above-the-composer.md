---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Track sub-agent lifecycle from the CLI's completion signal and show running sub-agents in a tray above the composer

## Context and Problem Statement

The agent pane shows sub-agents (the CLI's `Agent`/`Task` tool) as live cards in the transcript, fed by `subagent-started`, `subagent-status` and `subagent-message` events from `agent/sub_tracker.rs`. On 2026-11-18 the user saw two problems:

1. A background sub-agent (`run_in_background: true`) was shown "✓ Done · 16s" while it kept working (its tool count rose from 8 to 13 afterwards), and its card body showed the CLI's internal launch text ("Async agent launched successfully … agentId … output_file …"). The immediate `tool_result` of the launch was read as completion and as the sub-agent's report.
2. Live cards in the transcript make parallel background work hard to follow: they scroll away, and the user cannot see at a glance what is still running.

## Decision Drivers

- One owner of sub-agent lifecycle (Rust), one per-chat state on the web that every view reads (DRY).
- A sub-agent is "done" only when it is done; elapsed time runs to the real end.
- CLI-internal text (launch boilerplate, agent ids, output file paths) never reaches the UI.
- The roles ADR already keeps the turn open while background tasks run and attributes edits to roles; this must stay true.
- Restoring a chat from its note never claims a result that was never reported.
- Testable with the fake `claude`.

## Considered Options

- A. Lifecycle from the CLI's completion signal; a tray of running sub-agents above the composer; the transcript holds a start line and a result card.
- B. Keep live cards in the transcript, fix only the status.
- C. A side panel with each sub-agent's live log.

## Decision Outcome

Chosen option: **A**.

1. **Lifecycle** (`sub_tracker.rs`, the only place that decides it): `running` from launch; a background launch result means "running in background", never done, and is not a report. `done`, `failed` or `stopped` come only from the CLI's completion signal for that task (its task notification with status completed, failed or killed), which also carries the real final report. A foreground sub-agent is done on its own `tool_result`. The main turn ending does not end a background sub-agent. Restored from the chat note without a completion: `interrupted`, never `done`.
2. **Filtering**: the launch boilerplate, agent ids and output paths are dropped in Rust and never emitted.
3. **Tray** above the composer, one compact line per sub-agent: role icon, task title, model, live elapsed time and tool count, the latest activity faded beneath. Three or more fold into one "N agents running" line that expands. Clicking (or Enter on) a line expands its live activity in place, capped height with its own scroll; the transcript does not move. A finished line shows ✓ Done, ✕ Failed or Stopped with its total time and stays until the user's next send. The tray is a keyboard-reachable list with polite live-region status changes.
4. **Transcript**: one quiet line at start ("Started general-purpose: <title>") and, when finished, a collapsed result card with the final report and its steps (the existing card component's finished state). No live card.
5. Foreground and background sub-agents use the same presentation.

### Consequences

- Good: the user sees exactly what is still running and when it really finishes, without scrolling.
- Good: no internal CLI text leaks into the chat.
- Bad: two surfaces (tray, result card) to keep consistent; mitigated by one state both read.
- Neutral: a chat restored mid-run shows interrupted sub-agents instead of resuming them.

### Non-goals

- A per-agent stop button (no stream-json control for it today; revisit when the CLI exposes one).
- Showing a sub-agent's full transcript anywhere but its own card or tray expansion.
- Changing roles, tiers or models ([roles ADR](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md)).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/agent/sub_tracker.rs`, `claude_stream.rs`, `events.rs` and its mirror `apps/desktop/features/agent/web/lib/events.ts`, fixtures `agent/fixtures/subagent-*.jsonl` and goldens `shared/agent-golden/` (`WRITER_UPDATE_GOLDEN=1 cargo test golden`), the chat note persistence (`agent/chat_store.rs`, `features/agent/web/lib/chat-note.ts`) for the restored state, `features/agent/web/` (the sub-agent state in its store, a new tray component next to the composer, the transcript start line and the finished card), `SPECs/native-agent-spec.md` sub-agent section, `CHANGELOG.md`.
- **Patterns to follow**: lifecycle decided in Rust and sent as typed events; one selector per chat for sub-agent state; theme tokens; link activation for any clickable reference in a report.
- **Patterns to avoid**: inferring completion from a launch result; a second web store for the tray; showing raw tool-result text of a launch; marking done on turn end.
- **Tests**: Rust: background launch stays running, tool calls after the launch counted, completion notice gives done with the real report, failed and killed map to failed and stopped, no boilerplate emitted, turn end with background still running, restore without completion gives interrupted, goldens. TS: tray with 1, 2 and 3+ agents (folded), expand and collapse, live elapsed, finished line kept until next send then cleared, transcript start line and result card and no live card, no boilerplate text.

### Verification

- [x] A background sub-agent stays running after its launch result and its tool count keeps rising.
- [x] It becomes done only on the CLI's completion signal, and its card shows the real report.
- [x] No launch boilerplate, agent id or output path appears in the UI.
- [x] The tray folds at three or more, expands in place, and the finished lines clear on the next send.
- [x] The transcript shows a start line and a result card, and no live card.
- [x] A restored chat shows interrupted for a sub-agent that never reported.

## Pros and Cons of the Options

### A. Completion signal, tray and transcript summary

- Good, because status is true and running work is always visible near where the user types.
- Bad, because it is a larger UI change than B.

### B. Live cards, status fixed

- Good, because the smallest change.
- Bad, because running work still scrolls away; the user asked for a change.

### C. Side panel

- Good, because room for full logs.
- Bad, because it covers the chat and adds a third place to look.

## More Information

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) (sub-agents). Related: [roles and adapters](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md), [first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [chats as notes](2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md). Revisit when the CLI offers a control to stop one background task.

- 2026-11-23, the user (screenshot: a sub-agent the main agent resumed with `SendMessage` kept "Done · 38s" while new tool calls ran under it): a run that ended can be **resumed** by a message from the orchestrator, and Writer shows it. This refines "a final state is never overwritten": a run that is `completed`, `failed` or `stopped` works again when a new child event arrives (a tool call or a message whose parent is its launch call) after its end. `interrupted` already revived this way. `sub_tracker.rs` stays the only place that decides it and emits `subagent-status{running}`. The web never infers it, and the reducer accepts `running` after any final state. The card's header goes back to Running, then to its next final state, with the time summed over the runs. A quiet "Resumed" divider sits in the call list at the point the run restarted. The report shown is the latest, and an earlier run's report stays readable at its divider. The tray lists the run again while it works. A resumed run keeps the turn open like any running background run. The divider and each run's report survive in the chat note, and reading an older note without them changes nothing. Only a real child event revives a run, never a guess, so a stopped run shows Running again only when it is in fact working. Spec `SPECs/native-agent-spec.md` 3.14.
