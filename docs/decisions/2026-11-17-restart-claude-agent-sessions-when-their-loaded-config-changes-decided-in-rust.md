---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Restart Claude agent sessions when their loaded config changes, decided in Rust

## Context and Problem Statement

Each agent chat is one long-lived `claude` CLI process (stream-json, [agent pane ADR](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md)). The CLI reads skills, MCP servers, settings and `CLAUDE.md` / `AGENTS.md` once, at start. A skill installed, an MCP server added or reconnected, or a settings change made during a chat stays invisible until the process restarts. Restarting with `--resume <session-id>` keeps the conversation. The user wants this handled automatically, without losing a turn, and noted that OpenCode (V2 and later) reloads on its own, so only Claude needs it.

## Decision Drivers

- No lost or interrupted turn: never restart while a turn runs or a permission card is pending.
- Privacy: Writer never reads, stats or watches anything under the user's home Claude folder (`~/.claude`, `~/.claude.json`).
- No new file watcher and no background polling, except a bounded MCP health re-check while a server is failing.
- Backend-neutral: the need to restart is a backend capability, not a Claude special case in shared code (roles ADR: adapters map capabilities).
- One decision point, testable with the fake `claude`.

## Considered Options

- A. An adapter capability `restart_on_config_change` plus one Rust state machine fed by Writer's existing watcher events and an MCP health re-check; manual reload as well.
- B. Manual reload only (`/reload`, header menu, palette).
- C. A web-side check at send time (fingerprint the inputs, respawn before sending).

## Decision Outcome

Chosen option: **A**, with B's manual reload kept.

1. **Capability**: each backend adapter declares `restart_on_config_change`; the Claude adapter sets it true, an OpenCode adapter false. Nothing below runs for a backend that sets it false; no `if claude` outside the adapter.
2. **Config changes**: the runner consumes the existing watcher's change batches (no new watcher). One pure function `affects_chat(path, chat_cwd, vault_root) -> Option<Reason>` marks a running chat stale when a changed path is a file its CLI read at start: the vault's or the chat's project's `.claude/skills/**` or `.agents/skills/**`, `.mcp.json` or `.claude/settings*.json` in the cwd chain, `CLAUDE.md` or `AGENTS.md` in the cwd chain, or files written by a managed-skills sync. Home-folder paths are never considered.
3. **MCP health**: when `system/init` (or a later event) reports an MCP server failed, pending or disconnected, Rust re-checks it with backoff (1 min, 2 min, 5 min, then every 5 min) through the CLI itself (`claude mcp list` / `mcp get` in the chat's cwd, the one env builder, a timeout), parsing only names and status; it stops when the chat closes or all servers are healthy. A server that comes back marks the chat stale. Server URLs and arguments are never logged.
4. **Decision** (one state machine, run through `features::spawn`): stale and idle restarts with `--resume` under the hood; stale and busy restarts right after the turn ends; a send while stale restarts first, then sends. Changes are debounced (about 2 s). Each restart emits one event with its reason; the transcript shows a non-persisted notice ("Session reloaded: MCP server github connected").
5. **Setting** `agent.auto-reload` (default on) turns the automatic part off; the manual reload always works and is refused or queued during a turn the same way.
6. **Status**: the chat shows its MCP servers and their state from `system/init`, refreshed after each restart.

### Consequences

- Good: new skills and reconnected MCP servers reach a chat without the user restarting it, and without losing the conversation.
- Good: OpenCode needs nothing; the capability keeps the rule in its adapter.
- Bad: user-level changes under `~/.claude` are not detected (by the privacy rule); they need the manual reload, which the spec documents.
- Bad: a restart costs a CLI start (seconds) at the next idle moment or before the next send.
- Neutral: the MCP probe spawns a short CLI process only while a server is failing.

### Non-goals

- Restarting during a turn or with a pending permission card.
- Watching or reading the home Claude folder.
- Hot-reloading the CLI without a restart (the CLI has no such control today).

## Implementation Plan

- **Affected paths**: the Claude adapter and the capability table (`src-tauri/src/agent/roles.rs`, `subagents.rs`, `shared/agent-roles.json` if capabilities live there), `src-tauri/src/agent/runner.rs` and a sibling module for the state machine and `affects_chat`, the watcher hookup (`watcher.rs` events into the agent feature), `src-tauri/src/agent/env.rs` for the probe's env, `src-tauri/src/agent/events.rs` and `features/agent/web/lib/events.ts` for the restart event, `features/agent/settings.schema.json` (`agent.auto-reload`), `features/agent/web/` (notice, MCP status, Reload action, `/reload` in `writer-commands.ts`), `code_files.rs` if the watcher does not yet report the skills folders, `SPECs/native-agent-spec.md`.
- **Patterns to follow**: adapter capabilities as data; pure path rules with tests; fake-`claude` runner tests; `features::spawn` for threads; the `env.rs` builder for every child process.
- **Patterns to avoid**: a new watcher; polling for config; any path under the home folder; restarting mid-turn; per-backend branches in shared code.
- **Tests**: fake-`claude` runner tests for idle restart, restart after the turn, restart before a send, debounce, setting off, and a backend with the capability false never restarting; `affects_chat` cases including that no home path is ever examined; the MCP backoff schedule with a fake probe; TS tests for the notice, the Reload action and `/reload`.

### Verification

- [ ] A skill added to the vault's `.claude/skills/` makes an idle Claude chat restart with `--resume` and shows the notice (fake `claude`).
- [ ] A restart never happens while a turn runs or a permission card is pending.
- [ ] No code path stats, reads or watches a path under the home Claude folder (test with HOME pointed at a fixture).
- [ ] The MCP re-check runs only while a server is unhealthy and follows the backoff.
- [ ] `agent.auto-reload` off disables the automatic restarts; `/reload` still works.

## Pros and Cons of the Options

### A. Capability plus Rust state machine

- Good, because detection, timing and the backend rule live in one testable place.
- Bad, because it is the most code of the three.

### B. Manual only

- Good, because simple and predictable.
- Bad, because users must know when a reload is needed, which is hard (an MCP server reconnecting is invisible).

### C. Web-side check at send time

- Good, because no background work.
- Bad, because it detects only file changes, only at send time, and puts process decisions in the web layer.

## More Information

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) (session reload section). Related: [agent roles and adapters](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md), [agent memory](2026-11-17-keep-agent-memory-in-the-vault-through-the-backends-own-memory-tool.md). Revisit if the CLI gains a live reload control, or if user-level config detection becomes possible without reading the home folder.
