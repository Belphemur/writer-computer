---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Hand Writer's MCP server to every agent backend through its adapter

## Context and Problem Statement

`writer mcp` ([ADR 2026-11-19](2026-11-19-serve-the-writer-cli-as-an-mcp-server-to-the-agent.md)) is a standard MCP stdio server, usable by any coding agent. Its wiring was written for Claude Code only:

- `agent/mcp_wiring.rs` builds Claude's `--mcp-config` JSON and Claude `--allowedTools` rules.
- `writer_prompt.rs` and the sub-agent roles hard-code Claude's tool names (`mcp__writer__search`).

Agent backends are meant to be pluggable: OpenCode is planned first ([ADR 2026-11-17 roles and adapters](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md)), and Settings already lists other backends as coming soon. Each would have to copy the server's launch, its tool naming and its read-without-prompt rules. The user (2026-11-19): "everything about agent needs to be planned to be extended to all of them", applying the engineering-philosophy skill (DRY > SOLID > KISS).

## Decision Drivers

- One source of truth: what Writer's server is (a command, its arguments, its tools and whether each writes) is defined once, with no backend's format in it.
- Open for extension: a new backend adds one adapter implementation, with no edit to the server, the prompt builder or the roles.
- Small interfaces: a backend implements only what it uses.
- No behaviour change for Claude Code: argv, prompt text and goldens stay byte-identical.

## Considered Options

- A. A neutral `WriterServer` description plus a small `ToolsAdapter` trait per backend, implemented next to the existing `RoleAdapter` by `ClaudeAdapter`. Prompt and role text get tool names from the adapter.
- B. Keep Claude-specific code and copy it per backend when each backend lands.
- C. One large `Backend` trait covering roles, MCP, models and the stream.

## Decision Outcome

Chosen option: **A**.

1. **Neutral server**: `WriterServer { command, args }` (the `writer` launcher with `vault=<root> mcp`) and the tool list, `ToolSpec { name, writes }`, are derived from the CLI registry, Tauri-free, in one module. Nothing in them is backend-specific.
2. **`ToolsAdapter` trait** (pure, Tauri-free), one implementation per backend:
   - `tool_name(&ToolSpec) -> String` — how the backend names a server tool: Claude `mcp__writer__<tool>`.
   - `launch(&WriterServer) -> Launch` — how the backend is handed the server: Claude adds `--mcp-config <json>` argv.
   - `read_rules(&[ToolSpec]) -> Vec<String>` — how read tools skip the permission prompt: Claude adds `--allowedTools` entries.

   `Launch` covers what backends need: argv, env, or a config fragment. Only Claude's argv variant is implemented now; the others are noted in the spec.

3. **Names in text**: `writer_prompt.rs` (the search line) and the role prompts (`{search-line}`) build tool names through the active adapter's `tool_name`, never a literal `mcp__writer__`. A test fails on a hard-coded prefix outside the Claude adapter.
4. **Roles**: the `writer-cli-read` capability maps to `read_rules` of the registry's read tools through the same adapter (today's `writer_read_tools()` moves behind it).
5. **Ownership**: the `ToolsAdapter` and `RoleAdapter` implementations for a backend live together (Claude: `agent/` today; a later `opencode` feature has its own). The session picks the adapter of the chat's backend; with one backend this is `ClaudeAdapter`.

### Consequences

- Good: a backend gets Writer's tools by implementing three small functions.
- Good: no tool name or config format is written twice.
- Bad: one more trait. It is kept small (Interface Segregation) instead of one large `Backend` trait.
- Neutral: the OpenCode, Codex and Gemini formats are not verified. Each is checked against its real CLI when that backend is built.

### Non-goals

- Adding any new backend now.
- Changing the server, its tools or Claude's behaviour.

## Implementation Plan

- **Affected paths**: `src-tauri/src/agent/mcp_wiring.rs` (becomes the neutral `WriterServer` and `ToolSpec`, or moves under a clearer name), the `ToolsAdapter` trait (next to `RoleAdapter`), `agent/subagents.rs` (`ClaudeAdapter` implements it; `writer_read_tools` moves behind it), `agent/claude_stream.rs` (`ClaudeSpawn` takes the adapter's `Launch` and rules instead of a Claude-shaped `McpWiring`), `agent/session.rs` (picks the adapter), `agent/writer_prompt.rs` (tool names from the adapter), `cli/mcp.rs` (exposes the registry-derived `ToolSpec` list, no naming), `SPECs/native-agent-spec.md` and `SPECs/agent-roles-spec.md` (a per-backend table: name format, launch, read rules, and what is verified), and a dated line in the MCP ADR.
- **Patterns to follow**: `RoleAdapter` and `ClaudeAdapter`; the registry as the one tool source.
- **Patterns to avoid**: `mcp__writer__` literals outside the Claude adapter; a large catch-all backend trait; behaviour changes.
- **Tests**: the Claude argv, prompt and goldens are unchanged (existing tests stay green, untouched); a test adapter (a second `ToolsAdapter` with another naming, in tests only) renders the prompt search line and role tools with its names, proving the seam; no `mcp__writer__` literal outside the Claude adapter (source scan test); `read_rules` cover exactly the registry's read tools.

### Verification

- [ ] `cargo test` is green, with no golden or argv change.
- [ ] A test-only adapter changes every tool name in the prompt and roles.
- [ ] `grep -rn "mcp__writer__" src-tauri/src` finds it only in the Claude adapter and tests.

## Amendment 2026-11-24

Amended 2026-11-24 ([ADR 2026-11-24](2026-11-24-show-one-mcp-servers-menu-for-every-agent-backend-and-load-the-global-opencode-config-with-its-servers-off.md), proposed, phase 1 landed): `ToolsAdapter` gained `deny_server(server)`, the rule that withholds every tool of a server (Claude `mcp__<key>__*` for `--disallowedTools`, OpenCode `<key>_*`), where the key is `mcp_wiring::server_key` (every character outside `[A-Za-z0-9_-]` becomes `_`, the same for both harnesses). The tool tables' `mcp.prefix` became the template `mcp.serverPrefix` (`mcp__{server}__`, `{server}_`); Writer's prefix is the template with `writer`, and `tool_name`, `server_prefix` and `deny_server` are default methods over it, so no adapter spells a prefix. The decision above is unchanged.
