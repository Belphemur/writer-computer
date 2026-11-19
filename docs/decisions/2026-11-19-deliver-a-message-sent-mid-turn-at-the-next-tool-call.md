---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Deliver a message sent mid-turn at the next tool call, like Claude Code

## Context and Problem Statement

In the agent pane, Enter while a turn runs queues the message in Writer (`queued` in the web store, the "Queued" chip) and sends it only when the whole turn ends; Cmd+Enter is the forced steer (`priority:"now"`, cuts the current step; `SPECs/native-agent-spec.md` 3.13). A long turn with many tool calls therefore never sees a correction until it is done. Claude Code delivers a message typed while it works at the next tool boundary. The `claude` CLI already does this for a plain user line written mid-turn (captured in `agent/fixtures/steer-injected.jsonl`: injected after the running tool's result, one `result`; `steer-deferred.jsonl`: with no tool boundary left it runs as the next turn). The user (2026-11-19) asked for the Claude Code behaviour and chose that a message still waiting can be taken back.

## Decision Drivers

- A correction reaches the model as early as it safely can, without cutting a step.
- One delivery path: Writer writes the line, the CLI decides when it lands; the echo (`--replay-user-messages`, `isReplay:true`, same `uuid`) is the one receipt.
- Never lose, duplicate or reorder a message (spec "Messages and a restart").

## Considered Options

- A. Enter writes a plain user line to the CLI at once (no `priority`); the card appears where the echo arrives. A still-waiting message can be removed with the CLI's cancel-queued control.
- B. Same, with no removal once written.
- C. Keep holding in Writer until the turn ends.

## Decision Outcome

Chosen option: **A**.

1. **Send.** Enter while a turn runs on a live process (`ready && turn_active`) calls one Rust path that writes the line at once with its `uuid` and no `priority`; Cmd+Enter keeps `priority:"now"` (3.13, unchanged). Idle, `starting` or `cancelling`: unchanged (normal send, or held as today).
2. **Chip until the receipt.** The message shows as the "Queued" chip until its echo arrives. On the echo the user card is placed at that point: inside the running turn's timeline when the CLI injected it after a tool result (a user block in `Turn.blocks`, the same placement mechanism as the steer card, without "Steer" and without interrupting anything), or as the user card of the next turn when the CLI deferred it.
3. **Take back.** Esc on the chip (or its ×) removes a message not yet echoed. The runner first probes the CLI's cancel-queued control (the init advertises `interrupt_cancel_queued_v1`; its request shape is captured into `agent/fixtures/` before implementing, never guessed). If the probe shows a working cancel, removal sends it and drops the chip on its answer; if the CLI does not support it, the chip has no remove once the line is written and the spec says so.
4. **Several queued: one message.** The user (2026-11-19): "merge the messages together if multiple are queued". Messages sent with Enter before the CLI took the first are delivered as one user message (joined by a blank line, as the web store's `queued` already merges them today) and show as one chip. How, in order of preference, decided by a capture of the real CLI before implementing: (a) if the CLI itself delivers lines queued at the same boundary as one message, Writer just writes each line; (b) else, with a working cancel-queued control, Writer cancels the waiting line and writes the merged text with a new `uuid`; (c) else, Writer writes the first at once and holds the later ones merged in the chip, written as one line when the first is echoed (they then land at the following tool call). One user card per delivered message.
5. **Runner state.** Unechoed plain lines are tracked like steers (`Inner.steers` or a sibling list): a `turn-finished` while one is unacknowledged keeps the session running until its turn ends; the watchdog and the restart re-send rules of steers apply (re-sent once to a new process if never echoed, never if echoed).
6. **Saved note.** An injected message is an ordinary user message in the chat note, written where it landed (between the assistant's parts of that turn), with no `steer` mark; a reopened chat shows it at that point. Golden note added.

### Consequences

- Good: Claude Code parity; corrections land after the current tool, not after the whole turn.
- Bad: a turn now holds more than one user message; the reducer, the note encoder and decoder handle a user block mid-turn.

### Non-goals

- Changing Cmd+Enter (send now) or the permission card precedence of Cmd+Enter.
- Editing a message after it was written to the CLI.

## Implementation Plan

- **Affected paths**: `src-tauri/src/agent/runner.rs` (`Session` send path for a running turn, unechoed list, hold, watchdog, restart re-send), `agent/claude_stream.rs` (plain line encoder with `uuid`, the cancel-queued control once captured), `agent/chat_store.rs` (user message mid-turn), `features/agent/web/stores/agent-store.ts` (Enter mid-turn delivers instead of holding; chip until echo; remove), the reducer (placement on echo), the composer and chip components, `SPECs/native-agent-spec.md` 3.13 and section 5, `docs/keyboard-shortcuts.md`, `CHANGELOG.md`.
- **Patterns to follow**: the steer path (`deliver`, `Session::steer`, `appendSteer`, `recordSteer`, `MapOutput::user_echo`); the fake `claude` for tests; real-CLI captures only in a temp dir.
- **Patterns to avoid**: a second queue in Rust next to the CLI's; guessing the cancel-queued request shape.
- **Tests**: Rust: a plain line written mid-turn and not queued; held until its turn ends; injected and deferred goldens; restart re-send; cancel-queued (if supported). Merging: two lines before the boundary give one message (by whichever of 4a-c the capture chose). Web: Enter mid-turn delivers; the chip stays until the echo; the card placed mid-turn or as the next turn; remove before the echo; note round trip.

### Verification

- [ ] In a real chat, a message sent with Enter during a multi-tool turn appears after the next tool call and the model answers it in the same turn.
- [ ] With no tool call left, it runs right after the turn.
- [ ] Esc on the chip removes a still-waiting message (or the spec documents why it cannot).
- [ ] Cmd+Enter still cuts the current step.
- [ ] Two messages sent with Enter before the next tool call arrive as one user message.

## More Information

Refines `SPECs/native-agent-spec.md` 3.13 ("Writer no longer sends a plain line while a turn runs" is reversed). Related: [Build a first-party agent pane over the claude CLI's stream-json protocol](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md).
