---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Build a first-party agent pane over the claude CLI's stream-json protocol

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md). Research: [`SPECs/native-assistant-research.md`](../../SPECs/native-assistant-research.md). Builds on [run unmodified Obsidian plugins through a ported host](2026-11-13-run-unmodified-obsidian-plugins-through-a-ported-host.md) (which stays) and [native consent for plugin process spawn](2026-11-13-native-consent-for-plugin-process-spawn.md).

## Context and Problem Statement

Writer can host the unmodified Obsidian Copilot plugin, whose "Agent Chat" is a UI over the user's `claude` CLI. That works, but the chat lives in a plugin runtime Writer does not control: its permission cards, context handling, history and projects are Copilot's, it cannot be tied to Writer's index, sidebar or spawn consent, and it is AGPL code Writer cannot reuse. Writer wants the same experience as a first-party feature (agent timeline, permission card, projects, a visible context ledger) without giving up the plugin host. How should the agent chat be built, and over what protocol?

## Decision Drivers

- The user already has `claude` installed and signed in; Writer must not ask for API keys or run models itself.
- Clean-room: Copilot is AGPL; only behaviour may be studied.
- A permission prompt must be drawn by Writer (not a webview-hosted plugin) and tied to a real process the app controls.
- Streaming UI must never block on IO; the process must die with the window.
- A second agent backend (Codex or OpenCode over ACP) may come later and must not force a UI rewrite.
- Testable without an account: a fake `claude` replaying fixtures (see [test the agent path with a fake claude](2026-11-13-test-the-agent-path-with-a-fake-claude.md)).

## Considered Options

- Drive the `claude` CLI directly in Rust over `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, map it to a typed `AgentEvent` contract, render natively (chosen).
- Keep hosting Copilot only.
- ACP (Agent Client Protocol) adapters or another SDK as the primary protocol.
- Embed the Claude Agent SDK in a Node sidecar.

## Decision Outcome

Chosen option: drive the CLI directly. The protocol was verified against claude 2.1.325 with real captures (spec appendix, anonymised fixtures in `src-tauri/src/agent/fixtures/`): one long-lived process per chat accepts several user messages, streams partial messages, asks permissions as `control_request`/`control_response`, supports `interrupt`, `--session-id` and `--resume`, and persists "always allow" rules itself through `updatedPermissions`. The backend is split into a pure mapper (`claude_stream.rs`: stdout line to `AgentEvent`, intent to stdin line, argv), a runner (process, consent, lifecycle) and the UI, joined by one typed contract (`events.rs` / `src/lib/agent/events.ts`) pinned by golden files. The plugin host and Copilot stay; the native pane is additive and shares nothing with the plugin runtime except the spawn consent store and login-PATH discovery.

### Consequences

- Good, because permissions, context and history are Writer-owned, local and testable, and the pane integrates with the index, projects and sidebar.
- Good, because the typed event layer makes a second backend a mapper plus a spawner, not a UI change.
- Good, because the whole translation layer is pure and covered by real-capture tests.
- Bad, because Writer now tracks the CLI's undocumented-in-places wire format; the fixtures, the version recorded at `session-started` and a manual real-CLI check are the guard (`claude --help` already differs from public docs, for example `--permission-prompts`).
- Bad, because two agent UIs coexist (Copilot's inside its plugin, ours); users may run both.
- Neutral, because Claude Code's own `~/.claude` transcripts remain the CLI's session store; Writer keeps its own chat notes (see the chat-history ADR).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/agent/` (contract and mapper done; runner, registry, chat store, project library to add), `apps/desktop/src/lib/agent/`, `apps/desktop/src/components/agent/`, `apps/desktop/src/stores/agent-store.ts`, `apps/desktop/shared/settings.schema.json` (`agent.*` keys), `commands/agent.rs`.
- **Dependencies**: none new (tokio, serde_json, uuid, parking_lot already present).
- **Patterns to follow**: `plugin_proc.rs` for spawn, consent, env and process-group kill; `commands::blocking` for IO; `log::` macros, never content.
- **Patterns to avoid**: parsing CLI output in the frontend; passing the CLI `--dangerously-skip-permissions`, `--bare` or `bypassPermissions`; reading `~/.claude`; importing Copilot code, text or CSS.
- **Migration steps**: none; the plugin host is untouched.

### Verification

- [ ] `cargo test agent::` passes (mapper over six real-capture fixtures, golden files, encoders, argv).
- [ ] `vp test tests/agent-events.test.ts` passes against the same golden files.
- [ ] A fake `claude` replaying the fixtures drives the pane end to end in the e2e harness; a manual run against the real CLI is recorded in the spec's status.

## Pros and Cons of the Options

### Drive the claude CLI directly (stream-json)

- Good, because it is the exact surface Copilot itself uses, so behaviour (skills, `CLAUDE.md`, MCP, settings) matches what the user knows.
- Good, because no new dependency, no Node.
- Bad, because the wire format is the CLI's, not a standard.

### Keep hosting Copilot only

- Good, because zero work.
- Bad, because Writer cannot own permissions, context ledger, projects UX or tests; every fix is a host shim under an AGPL plugin we may not patch.

### ACP adapters or another SDK first

- Good, because one protocol could reach Codex and OpenCode.
- Bad, because claude is reached through an adapter package (a Node dependency Writer would have to ship and trust), the permission and `updatedPermissions` semantics we need are the CLI's own, and v1 is claude only. The typed event layer keeps ACP open as a later second mapper.

### Embed the Agent SDK in a Node sidecar

- Good, because the SDK wraps the same CLI protocol with types.
- Bad, because it adds a Node runtime and a package to ship and sign, a second process tree to confine and kill, and an extra hop; the protocol is small enough to speak directly.

## More Information

Revisit if a second backend is requested (add an ACP mapper behind the same events), if the CLI changes the stream-json framing (fixtures fail first), or if a supported Rust SDK appears.

## Addendum (2026-11-17): the feature switch is the approval

The agent no longer requires the Obsidian community-plugin vault trust, nor a per-vault spawn consent. Before, every agent command went through the plugin host's `trusted_root` (so a vault in restricted mode refused the Changes card with "plugins are in restricted mode for this vault") and the first spawn per vault showed the native "Writer: start Claude Code?" dialog. Both were the plugin trust model applied to a first-party feature that is not a plugin. Now the agent commands use the window's plain workspace root (the same authorization as the core fs and chat-store commands) and the runner spawns `claude` directly (`ProcManager::spawn`): enabling `features.agent.enabled` is the user's approval, and what the agent may DO stays the CLI's permission card. The agent's pseudo plugin id `writer-agent`, `agent/consent.rs` and the dialog wording are removed. The community-plugin consent for `plugin_proc_spawn` is unchanged. A related change in the same pass: the spawned `claude` gets a `writer` launcher on its PATH (spec "Writer CLI for the agent").

## Addendum (2026-11-20): Writer proposes prefix rules when the CLI sends none

The permission card's "Always allow" was a pure function of the CLI's `permission_suggestions`. For compound Bash commands (`;`, `&&`, `|`, variable assignments) the CLI often sends none, so only "Allow once" was offered. Decided with the user: when the CLI sends no `addRules` suggestion for a Bash call, Writer proposes its own, like Claude Code's terminal UI: the command is split on `;`, `&&`, `||` and `|`; each segment becomes a prefix rule `Bash(<program> <subcommand>:*)` (program plus its first non-flag word, leading `VAR=value` assignments dropped, absolute program paths kept as written); read-only filters in a pipe (`head`, `tail`, `grep`, `wc`, `sort`, `uniq`, `cut`, `jq`) need no rule; nothing is proposed for a segment that contains `$(...)`, backticks, `eval`, `sudo`, `rm`, a pipe into a shell, or a redirection to a file, and the card then offers only "This exact command". The rules are shown as chips the user can untick before saving. Destinations: "In this project" (`localSettings`, the CLI writes `<cwd>/.claude/settings.local.json` as before) and "For this chat" (`session`). No "allow all for this turn". Writer still writes no Claude settings file: the rules travel as `updatedPermissions` `addRules` and the CLI persists them. The splitter is one pure Rust function with table tests (`agent/bash_rules.rs`); the CLI's own suggestions, when present, still win.

## Addendum (2026-11-23): the second backend is OpenCode through its v2 server, not ACP

This ADR expected a second backend to come over ACP. OpenCode comes through its v2 HTTP server and event stream instead, behind a `Transport` seam under the same `Session` state machine. See ADR 2026-11-23 "Add OpenCode as an agent backend, driven through its v2 server". ACP remains an option for Codex.
