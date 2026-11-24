---
status: proposed
date: 2026-11-24
decision-makers: Writer maintainers
---

# Show one MCP servers menu for every agent backend and load the global OpenCode config with its servers off

## Context and Problem Statement

Writer's agent pane runs two harnesses today, Claude Code and OpenCode ([ADR 2026-11-23](2026-11-23-add-opencode-as-an-agent-backend-driven-through-its-v2-server.md)), and more are planned (Codex). The user decided on 2026-11-24:

- one MCP servers menu with search, shared by every harness;
- OpenCode loads the user's whole global config with Writer's config on top, its global MCP servers off by default and Writer's own `writer` server always on and locked;
- Writer learns server names through the harness's API only;
- global OpenCode agents are disabled, plugins apply;
- Claude's names come from `claude mcp list`, a switched-off server is blocked through `--disallowedTools`, its servers are on by default;
- provider on/off switches go through OpenCode itself;
- the OpenCode version shows next to Ready.

Two things stand in the way. Decision U1 of the OpenCode spec runs the server with an empty Writer-owned config home, so the user's own OpenCode setup does not apply (it was chosen because a large global config, about 30 MCP servers, stalled the first prompt for minutes: risk 10.1). And Claude's MCP servers are neither visible nor controllable from Writer. The captures in `SPECs/opencode-backend-spec.md` 4.13 and `SPECs/native-agent-spec.md` 7.1 (phase 0, 2026-11-24, `opencode 2.4.0`, `claude 2.1.330`, synthetic configs, a local fake model) answer whether it can be done fail closed.

## Decision Drivers

- DRY > SOLID > KISS: one neutral shape, one component, one `BackendOps` seam; a new harness is one implementation.
- Fail closed: a server that is switched off must not start; when the lever cannot be proven, Writer refuses rather than runs.
- Writer reads no harness config file and writes no Claude settings; names come from each harness's own API or CLI.
- Spec 10.9 (permission model) is not loosened: global allows never widen what Writer's chat may do.
- Switching off degrades quietly; Claude's argv and goldens stay unchanged when nothing is switched off.
- Privacy: `GET /api/config` documents hold server `environment` and `headers`; Writer parses only keys.

## Considered Options

- A. One neutral menu (`mcp_menu.rs`, one web component) over a per-backend `BackendOps` (`mcp_switches`, `mcp_list`, `mcp_apply`).
- B. A menu per backend.
- C. A Writer-side MCP proxy that Writer starts for every harness.
- D. Read the harnesses' config files.
- E. Keep U1 for OpenCode (empty config home); the menu shows only `writer` and OpenCode's own servers.

Sub-options settled by the captures:

- Claude lever: `--disallowedTools mcp__<name>__*` (chosen), `--strict-mcp-config`, or Writer editing Claude's settings file.
- OpenCode lever: `policies` (`mcp.use`), per-server `disabled`, or runtime `/disconnect`.
- Setting keys: per backend (chosen) or one shared namespaced key.

## Decision Outcome

Chosen option: **A**, with the OpenCode half (loading the global config) **gated on the fail-closed conditions below**; E is the fallback when they do not hold.

1. **Neutral shape.** `agent/mcp_menu.rs` (Tauri-free): `Switches {default_on, switched}` with `on(name)` (`writer` always on), `McpServer`, `McpMenu`, `assemble`, a cache keyed by backend and vault with a single-flight probe. `McpServerStatus.status` becomes the enum `McpState`. `BackendOps` gains `mcp_switches`, `mcp_list`, `mcp_apply`; the duplicated `mcp_cli_probe` goes. `ToolsAdapter::deny_server` and the table key `mcp.serverPrefix` replace `mcp.prefix`.
2. **Settings (per backend, in the owner's fragment).** `agent.claude.disabled-mcp-servers` (default on), `agent.opencode.enabled-mcp-servers` (default off), `agent.opencode.disabled-providers`.
3. **Claude.** Names from `claude mcp list` (the parser accepts spaces: K1). At each spawn the session appends `deny_server(name)` to `--disallowedTools`. Proven (K2): the names are withheld from the model and its sub-agents and a forced call is refused, deny beating allow; **the server still starts**. Claude normalises every character outside `[A-Za-z0-9_-]` to `_`, so `my.srv`, `my srv` and `my:srv` are one switch; the normalisation lives only in `ClaudeAdapter`. Applying a switch restarts the running chats through `config_changed` under `agent.auto-reload`.
4. **OpenCode, when the global config is loaded.** The inherited `XDG_CONFIG_HOME` replaces the empty config home; Writer's file stays on top through `OPENCODE_CONFIG`; `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_AUTOUPDATE` stay and inherited `OPENCODE_*` variables are stripped. The captures (OpenCode 4.13) show:
   - Nothing starts at process start; the first location-scoped call boots the location. `GET /api/info` is the only safe first call, so Writer's lever is in the file before any other.
   - MCP lever: `policies [mcp.use * deny, allow writer, allow <on>...]` (name-free, order matters, last match wins) **plus** a per-server placeholder `{type, command, disabled: true}` for each known switched-off name. The placeholder beats the user's own policies, which are applied after Writer's and otherwise win; a partial `{disabled: true}` is ignored.
   - Names: `GET /api/config` (documents, `info.mcp.servers` keys and `info.policies`, parsed as keys only), called under the deny-all policy so nothing starts. `GET /api/mcp` cannot name denied servers.
   - Runtime switch: rewrite Writer's file and `POST /api/location/reload`, which restarts every server; never `/connect`.
   - Global agents: `agents.<id> = {disabled: true}` for every foreign agent in `GET /api/agent` (a partial works).
   - Permissions: Writer's agent list starts with `*: ask`; the resolved list is concatenated, last match wins; a global deny does not hold in Writer's chat, a global allow does not widen it.
   - Pinned scalars: Writer wins for `default_agent`, `model`, `automations`; `instructions` and `skills` arrays concatenate, so global instructions, global skills and plugins apply.
   - Providers: `policies [provider.use <id> deny]` (the provider disappears from the lists and a turn on it fails before any request); the menu lists providers from the API united with the stored switched-off names.
5. **The start gate (fail closed, per epoch, before the first prompt).** On the facts, not the file: foreign agents disabled; `GET /api/mcp` lists only `writer` and the switched-on names (any other listed name, built-in ones included, stops the server and refuses the chat); the resolved permissions of Writer's agent end as Writer wrote them. A global `mcp.use` policy seen in `GET /api/config` makes Writer refuse with one line, because that server can start once during the names step before Writer can stop it.
6. **U1 is superseded only if** the gate passes in the real app on `opencode 2.4.0` (phase 2) and the user accepts the refusal for global `mcp.use` policies. Otherwise U1 stands and the menu shows `writer` and OpenCode's own servers (option E).
7. The OpenCode version (`opencode --version`, `opencode v2.4.0`, or `GET /api/info`) shows next to Ready.

### Consequences

- Good, because a new harness (Codex) is one `BackendOps` implementation and one settings fragment, with no menu code.
- Good, because the user's OpenCode providers, instructions, skills and plugins apply in Writer, and switched-off servers are never started (spawn markers prove it).
- Good, because the gate checks what OpenCode reports, so a lever that changes in a later OpenCode fails closed instead of silently.
- Bad, because a disallowed Claude server still starts (and costs its start) and Claude's list probe starts every server.
- Bad, because a switch on OpenCode restarts every server, `writer` included, which interrupts a running MCP call.
- Bad, because plugins run in the server process with the user's rights, so the gate cannot vouch for them; and global permission denies and allows do not apply in Writer's chat.
- Bad, because Writer parses `GET /api/config`, a document that carries secrets, to read names and policies.
- Neutral, because the `mcp.prefix` to `mcp.serverPrefix` table change touches the tool tables and their readers once.

## Implementation Plan

- **Affected paths**: `src-tauri/src/agent/` (`mcp_menu.rs`, `events.rs`, `config_sync.rs`, `backend.rs`, `runner.rs`, the adapters and `tool_table.rs` with `shared/agent-tools/*.json`), `features/agent/` (settings fragment, `agent_mcp_servers` and `agent_mcp_apply` commands, `web/agent-mcp.tsx`), `features/opencode/rust/` (`servers.rs`, `config.rs`, `modes.rs`, `transport.rs`, `opencode_api.rs`, `driver.rs`), Settings > Agent, `SPECs/`.
- **Dependencies**: none.
- **Patterns to follow**: one `BackendOps` seam; the menu `enabled` computed in Rust and pinned by shared vectors; `config::global_list` as the one reader of the three list settings; the neutral gate generalising `transport.rs::ensure_agents`.
- **Patterns to avoid**: a per-backend menu; any harness config file read or written by Writer; parsing `GET /api/config` beyond names and policies; a polling or persisted names cache.
- **Configuration**: the three keys above; contract test: key in the owner's fragment, default `[]`, default-on or off matches the backend.
- **Migration steps**: phase 1 core, the menu and Claude; phase 2 OpenCode (after this ADR is accepted); phase 3 docs and the amendments listed under More Information.

### Verification

- [ ] The marker and process checks show no switched-off server spawned, for Claude (a probe shows it started; the model never sees it) and for OpenCode.
- [ ] `--disallowedTools` argv and the goldens are unchanged when the lists are empty.
- [ ] Nothing under the user's XDG config or `~/.claude` is read or written by a test; the captures' temp `HOME` pattern is used.
- [ ] The vectors and `menu.json` tests are green; `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check` pass.
- [ ] The gate refuses a start whose `GET /api/mcp` lists an unexpected name, and a chat with a global `mcp.use` policy.

## Pros and Cons of the Options

### A. One neutral menu

- Good, because one source of truth for the switch rule, the status words and the component.
- Bad, because the harnesses differ in what a switch means (Claude: the server still starts; OpenCode: a restart), so the menu shows an "applies" line.

### B. A menu per backend

- Bad, because it duplicates the component, the rule and the tests for every harness.

### C. A Writer-side MCP proxy

- Bad, because Writer would read the servers' secrets and own their lifecycle and authentication.

### D. Read the config files

- Bad, because it breaks the privacy rule and misses plugin and connector servers.

### E. Keep U1 for OpenCode

- Good, because it is simple and already fail closed.
- Bad, because the user's OpenCode setup never applies. It stays the fallback when the gate cannot be met.

## More Information

- Supersedes U1 of `SPECs/opencode-backend-spec.md` (section 2) and the 2026-11-23 amendment "Config: Writer's file only" of the OpenCode ADR, only on acceptance.
- Amends A19 (`mcp_cli_probe` becomes `mcp_list`, the re-check gated by `restart_on_config_change`), the 2026-11-19 ADR "Hand Writer's MCP server to every agent backend through its adapter" (`deny_server`, `serverPrefix`), risk 10.1, `native-agent-spec.md` 8.1 item 6, and `opencode-backend-spec.md` 9.10 and 9.11.
- Evidence: `SPECs/opencode-backend-spec.md` 4.13, `SPECs/native-agent-spec.md` 7.1, fixtures `features/opencode/fixtures/global-c*.json` and `src-tauri/src/agent/fixtures/k-k0*.json`.
- Revisit when OpenCode changes its policy order or `GET /api/config`, or Claude defers or names MCP tools differently.
