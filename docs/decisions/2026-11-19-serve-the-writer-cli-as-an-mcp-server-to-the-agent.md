---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Serve the `writer` CLI to the agent as an MCP server generated from the command registry

## Context and Problem Statement

The agent pane runs the `claude` CLI (`agent/claude_stream.rs`). Writer's system prompt (`agent/writer_prompt.rs`) told it to "Find files with Glob and Grep, not Bash find or grep", but the installed CLI no longer has `Grep` and `Glob`: every search failed with "No such tool available: Grep … via the Bash tool instead" before falling back to shell `grep`/`find`, which ignore Writer's index (ranking, file kinds, PDF and code text, the graph, Bases, tasks). The `writer` CLI has all of that, reachable only through `Bash` with shell quoting and a Bash permission rule per call. The user (2026-11-19) asked to "provide properly the search tool into it to use our writer cli" and chose an MCP server generated from the CLI.

## Decision Drivers

- The agent searches the vault through Writer's index, never by guessing tools.
- One source of truth: the CLI command registry defines commands, parameters and help; tools are derived from it, never hand-listed.
- No new dependency; local only; the permission prompt still guards writes.

## Considered Options

- A. `writer mcp`: a stdio MCP server inside the `writer` binary exposing the registry's commands as tools; Writer passes it to every chat with `--mcp-config`; the prompt names its tools.
- B. Prompt and skills only: tell the agent to run `writer search` through `Bash`.
- C. A separate MCP server binary or an SDK crate (`rmcp`).

## Decision Outcome

Chosen option: **A**.

1. **Server**: `writer mcp` (a CLI command of its own, not listed as a tool) speaks MCP over stdio, JSON-RPC 2.0 with newline-delimited messages, hand-written in `src-tauri/src/cli/mcp.rs` (the protocol subset is `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`; no SDK, no new dependency). It serves one vault, given by `vault=` or the working directory, as the CLI does.
2. **Tools from the registry**: each `CommandSpec` becomes a tool named `<command>` with `:` mapped to `_` (`graph_backlinks`, `base_query`). The description is `summary`, the input schema has one string property per `ParamSpec` (required ones listed), a boolean per flag, `format` as an enum of `formats`. Excluded: `help`, `version`, `mcp`, `skills:sync`, and a feature's commands while its switch is off. A tool call runs the same handler as the CLI (no second implementation) and returns its stdout as text content; a non-zero exit is an `isError` result with the error line.
3. **Read or write**: `CommandSpec` gains `writes: bool` (a test requires every command to set it deliberately); write tools carry the MCP `readOnlyHint: false`/`destructiveHint` annotations, read tools `readOnlyHint: true`. Writes still go through Writer's permission prompt (`--permission-prompt-tool`) like any tool call; read tools are allowed by default in Writer's permission rules (`permission_rules.rs`).
4. **Wiring**: the agent runner adds `--mcp-config` with one server `writer` → the `writer` launcher (`cli_launcher`, already first on the child's PATH) with args `vault=<root> mcp` (the CLI grammar puts `vault=` first), merged with any MCP servers the user already configured (never replacing them). The tool names reach the model as `mcp__writer__<tool>`.
5. **Prompt**: `writer_prompt.rs` drops the Glob/Grep line and names the tools: search with `mcp__writer__search` (and `files`, `graph_*`, `tasks`, `base_query`, `dql`), read structure with `outline`; Bash `grep`/`find` only for what the index does not hold. The command names in the prompt come from the registry so a renamed command cannot leave a stale prompt (a test checks each one exists). The managed `writer-cli`/`writer-search` skills say the same.

### Consequences

- Good: vault search, graph, tasks and Bases are native, typed tools for the agent; no shell quoting; no tool drift.
- Good: adding a CLI command adds a tool with no other edit.
- Bad: a second entry point to the CLI handlers (stdio JSON-RPC) to keep tested.

### Non-goals

- Exposing the server to other MCP clients (it may work, it is not a supported surface yet).
- MCP resources, prompts or streaming.

## Implementation Plan

- **Affected paths**: `src-tauri/src/cli/mcp.rs` (new), `cli/registry.rs` (`writes`), the CLI command table (register `mcp`), `agent/claude_stream.rs` (`--mcp-config` argv, merged with user servers), `agent/runner.rs` (the launcher path and vault root), `agent/permission_rules.rs` (read tools allowed), `agent/writer_prompt.rs` (tool names from the registry), the managed skills (`BUNDLE_VERSION`), `SPECs/writer-cli-spec.md` and `SPECs/native-agent-spec.md`, `CHANGELOG.md`.
- **Patterns to follow**: registry over per-case code; the CLI handlers as the one implementation; argv safety checks in `claude_stream.rs` (`is_safe_value`); the fake `claude` for tests.
- **Patterns to avoid**: a hand-written tool list; a second handler per tool; touching the user's own MCP config files; logging tool arguments or results.
- **Tests**: JSON-RPC round trips (`initialize`, `tools/list` schema from a fixture registry, `tools/call` success and error, unknown tool, malformed input, `ping`); every non-excluded registry command is a tool and vice versa; `writes` set on every command; feature off hides its tools; the runner's argv carries `--mcp-config` with the launcher and vault and keeps user servers; the prompt names only existing tools; a fake-claude e2e calling `mcp__writer__search` through the real server.

### Verification

- [x] `writer mcp` answers `tools/list` with the registry's commands. (`cli::mcp::tests::tools_list_is_the_registry_minus_the_excluded_commands`, `every_tool_schema_follows_its_command_spec`)
- [ ] A chat searches with `mcp__writer__search` and gets ranked hits, with no Grep/Glob errors. (Proved with the fake `claude` against the real server in `tests/agent_fake_claude.rs`; the real `claude` chat is still to check by hand.)
- [ ] A write tool (e.g. `property_set`) asks for permission; read tools do not. (Proved at the argv: only read tools are in `--allowedTools`, `claude_stream::tests::the_mcp_server_is_added_next_to_the_users_and_its_read_tools_are_allowed`; the prompt itself is the real CLI's, to check by hand.)
- [x] Adding a CLI command shows up as a tool with no other change. (The tool list, the schemas, the read-tool allow rules and the prompt checks are all derived from or tested against `registry::commands()`.)

## More Information

Related: [Prune the `writer` CLI to one command per job](2026-11-19-prune-the-writer-cli-to-one-command-per-job.md), [Let the writer CLI talk to the running app over a local socket](2026-11-18-let-the-writer-cli-talk-to-the-running-app-over-a-local-authenticated-socket.md), [Build a first-party agent pane over the claude CLI's stream-json protocol](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md).
