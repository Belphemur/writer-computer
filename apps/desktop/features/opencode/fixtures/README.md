# OpenCode fixtures

Real captures from `opencode v2.4.0` (Homebrew) `opencode serve`, recorded on 2026-11-23 for `rust/opencode_events.rs` (the mapper goldens), the fake OpenCode server and the contract test (phase 2). Spec: `SPECs/opencode-backend-spec.md`. Pinned contract: `../contract/openapi-2.4.0.json`: the document `GET /openapi.json` of an `opencode serve` v2.4.0 (`info.title` "opencode HttpApi", `info.version` "0.0.1": the API reports no real version, so the OpenCode version is in the file name, from `GET /api/info`), fetched 2026-11-23 and re-checked identical by `tools/s12_rest.py` the same day.

Every fixture entered through `tools/scrub.py`, never by hand. Refresh and re-record with the tools: see `tools/README.md`.

Each scenario has two files:

- `<scenario>.sse`: the `GET /api/event` stream filtered to that scenario's session(s) (a sub-agent's child session included), one `data: {...}` frame per event with a blank line between, in arrival order, starting with the `server.connected` frame of its run. Server-wide noise is dropped (`plugin.updated`, `config.updated`, `integration.updated`, `provider.updated`, `model.updated`, `agent.updated`, `command.updated`, `skill.updated`, `artifact.updated`, `websearch.updated`, `reference.updated`, `project.updated`, and `mcp.status.changed`, which names no session); `shell.created` and `experimental.job.updated` are kept (they name the session). Heartbeat comments are dropped.
- `<scenario>.json`: the REST side, keys named by what they are: `messages` is `GET /api/session/{id}/message` after the turn (the resync source of truth); `rest` holds other replies (`permission_list_mid`, `diff_mid`, `diff_after`, `saved`, `pending`); `parent` / `child` are the two message lists of the sub-agent run; `log-resync` is the raw reply of `GET /api/experimental/session/{id}/log?after=<mid-seq>&follow=false`.
- `rest.json` (no scenario): the replies the fake server needs, each `{method, path, status, body}`: `info`, `mcp` (the `writer` server connected), `session-create`, `prompt-admitted` (`resume:false`, no model call), `interrupt-idle`, `interrupt-running`, `permission-reply-404`, `form-reply-404`, `session-get-404`, `mcp-put-400` (bare config, `Missing key ["config"]`), `mcp-put-204`, `mcp-delete-204`, `provider` (only `id`, `name`, `activation` of the `opencode` provider), `models` (the `opencode` provider's models, `headers` dropped), `skills` (fake names, no path or content), `commands`, `openapi-route` (`/openapi.json`), `generate` (`POST .../generate`: the title generator, 1.3 s, no events), `unauthorized-none` and `unauthorized-wrong` (401 `UnauthorizedError`, observed live).

## Scenarios

| Scenario | What was recorded | Model |
| --- | --- | --- |
| `text` | A plain turn with reasoning (`reasoning_content`), no tools. | `opencode/beam-free` |
| `edit` | `read` then `edit` of a small note under an `ask` rule; reply `once`. `permission.asked` carries the unified patch before the tool runs. | `opencode/beam-free` |
| `shell-reject` | `shell` under `ask`; reply `reject`. The turn ends `session.execution.interrupted` with `reason: "shutdown"` (not `user`: the server's label for a stop caused by a rejected permission). | `opencode/beam-free` |
| `shell-always` | Two `shell` calls under `ask` in one step; reply `always` to the first, the second is resolved by it (the server emits its `permission.replied`; Writer's own reply to it answered 404). `rest.saved` is the saved rule (`echo *`). | `opencode/beam-free` |
| `question` | The `question` tool: `form.created` (`metadata.kind: "question"`), `form.replied` with `{"q0": "pear"}`. | `opencode/beam-free` |
| `subagent` | A `writer-explorer` agent (`mode: subagent`, in the config file) launched by the main agent through the `subagent` tool. Background by default: the parent turn ends, the child runs, the report returns as a synthetic `<background-result>` inbox item that wakes the parent. | `opencode/beam-free` |
| `steer-queue` | `delivery: steer` and `delivery: queue` prompts sent while a `shell` (`sleep 6`) runs, plus a queued item cancelled with `DELETE .../inbox/{id}`. `log-resync` is the experimental log reply. | `opencode/beam-free` |
| `interrupt` | `POST .../interrupt` during `shell` (`sleep 30`). | `opencode/beam-free` |
| `mcp-codemode` | A stdio MCP server (one read-only tool `note_count`, `tools/mcp_server.cjs`) from `mcp.servers.writer` with the default `codemode`: the model calls a single `execute` tool with JavaScript; the inner calls are in `metadata.toolCalls`. This is Writer's configuration. | `opencode/beam-free` |
| `mcp-direct` | The same server with `"codemode": false`: the tool is a plain call named `writer_note_count`. | `opencode/beam-free` |
| `error-unknown-model`, `error-unknown-provider` | `session.execution.failed`, `error.type: "provider.no-route"`. No model was called. | none |
| `error-provider-auth` | A configured provider without credentials: `session.step.failed` then `session.execution.failed`, `error.type: "provider.auth"`. No model was called. The provider and model ids are fakes (`fake-provider`, `fake-model`), the message is generic. | none |
| `files-mention` | `files[]` on the prompt: an inline PNG and a file with a `mention` of notes.md. The server inlines both as base64 in the user message; the model read both. | `opencode/hy4-flash-free`, variant `none` |

Timing seen on the recording machine (macOS, Homebrew build, empty config home): the `server listening on` line about 1 to 2 s after the process started (cold start of the ADR's "about 6 s" was not reproduced); the first `POST .../prompt` of a location 1.7 s; SIGTERM to the process group stopped it in under a second, a SIGTERM to the process alone with an open event stream took about 10 s.

## How they were recorded

One Python script per scenario (`tools/`, standard library only) started its own `opencode serve --hostname 127.0.0.1 --port <free port>` with a random `OPENCODE_SERVER_PASSWORD`, cwd = a fresh empty temp directory, `OPENCODE_CONFIG=<a file in the work folder>` (permissions `ask` for `edit` and `shell`; the `writer-explorer` agent and the `writer` MCP server where a scenario needs them), `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` (every inherited `OPENCODE_*` variable stripped first), the real `HOME` (so the free models resolve) and an empty Writer-owned `XDG_CONFIG_HOME` (a large user config made the first prompt block for minutes; see the spec). The script opened the event stream before the first call, drove the scenario over HTTP, saved the events and the message list, deleted its sessions and saved permission rules, and stopped the server. Nothing was read from OpenCode's auth, credential or config files; `/api/credential`, `/api/integration/*/connect/*` and `/api/config` were never called.

## Scrub rules

See the header of `tools/scrub.py`; it is the single description. In short: home, temp and work paths, user and host names, ports, every id and instruction hash, base64 cursors and the user's own provider and model ids are faked; credential-like keys are dropped; the at-sign is JSON-escaped. Its final check, also planned as a cargo test over this folder, fails on anything left.
