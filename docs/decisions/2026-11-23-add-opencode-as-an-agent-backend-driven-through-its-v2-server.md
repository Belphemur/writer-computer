---
status: accepted
date: 2026-11-23
decision-makers: Writer maintainers
---

# Add OpenCode as an agent backend, driven through its v2 server

## Context and Problem Statement

The agent pane drives only Claude Code: one `claude -p --input-format stream-json` child per chat, mapped to typed `AgentEvent`s by `agent/claude_stream.rs` (ADR 2026-11-17 "Build a first-party agent pane over the claude CLI's stream-json protocol"). OpenCode was named the first other backend in ADR 2026-11-17 "Define agent roles once and map them to each agent backend through adapters" and ADR 2026-11-19 "Hand Writer's MCP server to every agent backend through its adapter". `SPECs/native-agent-spec.md` §9 "Other backends" recorded the user's choice (2026-11-20) of OpenCode's server mode over its CLI. The user installed OpenCode v2 (`opencode v2.4.0`, Homebrew) and asked (2026-11-23) to plan the integration: "The idea would need to run it in server mode to use it."

The v2 server was checked on 2026-11-23 against the installed binary. The OpenAPI document was fetched from a private server started in a temporary home; no model was called. The online docs (opencode.ai/docs/server, /config, /permissions, /mcp-servers, /agents) match that document. OpenCode is MIT-licensed, so its source may be read to match formats.

## Decision Drivers

- The pane, the chat note format, the chat store, history and the Changes card stay one implementation for every backend (DRY).
- Claude's behaviour does not change: its goldens and fixtures stay byte-identical.
- Writer writes only its own OpenCode config file, in Writer's app data folder, never `opencode.json`, the vault's `.opencode/` or `~/.config/opencode`. It never reads or sends OpenCode's stored credentials (`GET /api/credential` is never called).
- The server listens on loopback only, with a per-launch password, and stops with its window.
- Off degrades. With OpenCode not installed, or the feature off, Claude chats are unchanged and the backend shows as unavailable.
- No new dependency: `reqwest` (already in) is the HTTP and SSE client. The crates checked on 2026-11-23 do not fit 2.4.0:
  - `opencode-client-sdk` 1.2.20 and `opencode-codes` 1.19.6 target the v1 API.
  - `opencode_rs` 0.13.5 has 16 of its 28 v2 routes in 2.4.0, and lacks `/interrupt`, `/api/event` and the form reply.
  - `unofficial-opencode-sdk` 0.1.1 has 35 of its 46 v2 routes in 2.4.0, and has no typed v2 events and no form reply.

## Considered Options

- A. **Server mode:** one `opencode serve` per window and vault, HTTP calls plus the one `/api/event` SSE stream, behind a `Transport` seam under the existing `Session` state machine.
- B. `opencode run --format json` per turn, a CLI child like Claude. Rejected by the user (2026-11-20): there is no live permission answer, steering or queue, and history is re-read every turn.
- C. ACP (`opencode acp`, JSON-RPC over stdio). One protocol for several backends, but it loses OpenCode's permission `save` patterns, forms and sub-agent child sessions. It is kept for Codex (spec §9).

## Decision Outcome

Chosen: **A**, with the user's answers (2026-11-23):

- **Backend per chat:** a default backend in Settings, and the new-chat menu can pick the other. A chat keeps its backend for life, recorded in `writer-chat-backend`.
- **Config:** the user's own OpenCode config and logins apply as in the terminal. Writer adds its own parts in its own config file, `<app data>/opencode/<vault id>.json`, passed as `OPENCODE_CONFIG=<file>` (the user, 2026-11-23: "start the server with our own config file instead of config content"). Claude Code's files are not imported (`OPENCODE_DISABLE_CLAUDE_CODE=1`), because Writer gives the agent its instructions and skills itself.
- **Models:** the live list of every model and provider the server offers, free and paid, from `GET /api/model`. Settings > Agent > OpenCode has a models table like OpenCode's own: All / Enabled / Free tabs, search, name and id, provider, capability icons, cost per 1M tokens (input, output, cache read, cache write) and an Enabled switch. The switches are a Writer setting, `agent.opencode.disabled-models`. Writer never writes OpenCode's config.
- **Roles:** Writer's roles are rendered by the OpenCode role adapter as `agents` in Writer's config file. No files go in the vault.
- **Experimental routes are allowed** (the user, 2026-11-23). Writer uses them where they fit: per-session instructions (`PUT /api/experimental/session/{id}/instructions/entries/{key}`), runtime MCP (`PUT /api/experimental/mcp/{server}`), and the replayable log (`/api/experimental/session/{id}/log?after=`) for resync. The version pin and the contract test (Implementation Plan) cover the risk.

### Decisions

1. **Process.**
   - **Start.** One server per window and vault, started on the first OpenCode chat: `opencode serve --hostname 127.0.0.1 --port <free port>`. It runs with cwd = vault root, `OPENCODE_SERVER_PASSWORD=<random per launch>`, `OPENCODE_CONFIG=<Writer's config file>` (written atomically before the spawn, 0600), `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`.
   - **Shared spawn code.** It goes through the same spawn consent, PATH (`plugin_env::which`) and process-group code (`ProcManager`) as `claude`.
   - **Ready.** Ready means the `server listening on` line, then an authenticated `GET /api/info`, which must answer with a version `>= 2.4.0`. An older version is refused with a message naming it.
   - **Auth and stop.** HTTP Basic, user `opencode`. The server is stopped with SIGTERM when its window closes or its vault closes. A crash is reported in each open OpenCode chat and restarted on the next send; chats resume by their session id.
   - **What is never used.** `opencode service`, the user's background server, `--stdio`, port 4096 and `/api/pair` are never touched.
2. **`Transport` seam.**
   - **Split.** `agent/runner.rs` splits into the existing backend-neutral `Session` state machine (queue, steer, cancel, busy, restarts, sub-agents, changes, title) and a `Transport` trait with two implementations.
   - **`StdioTransport`.** Today's `claude` child, moved as is.
   - **`OpencodeTransport`.** Per chat: `POST /api/session` with `location.directory` = vault root, `agent`, `model` and `permissions`, its id stored as the chat's session id. Send is `POST /api/session/{id}/prompt`, with `delivery: steer|queue` for mid-turn input. Stop is `POST /api/session/{id}/interrupt`, and model and agent changes are `POST …/model` and `POST …/agent`.
   - **Shared server.** The server, its HTTP client and its one SSE subscription are shared by the window's OpenCode chats in an `OpencodeServer` owned by the `opencode` feature scope.
   - **Fan-out.** Events are fanned out by `data.sessionID`, a child session going to its parent's chat.
   - **Mapper.** A pure mapper `agent/opencode_events.rs`, the twin of `claude_stream.rs`, maps v2 events to `AgentEvent`:
     - `session.text.*` and `session.reasoning.*` become text and thinking;
     - `session.tool.*` becomes tool calls and results;
     - `session.execution.*` becomes the turn's start and end;
     - `session.usage.updated` and `session.step.ended` become usage and cost;
     - `permission.asked` and `form.created` become a permission request and a question;
     - `session.created` with a `parentID` becomes a sub-agent start.
   - **Resync.** The stream is volatile by contract. On a reconnect or an overflow, the transport resyncs the open chats from the replayable log (`/api/experimental/session/{id}/log?after=<seq>`), or from `GET /api/session/{id}/message` when the log cannot resume.
3. **Permissions and questions.**
   - **Permissions.** `permission.asked` is shown in the existing permission card. Its three answers map to `once`, `always` and `reject` on `POST /api/session/{id}/permission/{requestID}/reply`. "Always" is OpenCode's own saved approval, and Writer keeps no copy. OpenCode rejects every pending request in the session on `reject`, and the card says so.
   - **Questions.** `form.created` (the agent asking the user) is shown in the existing question card and answered at `…/form/{formID}/reply`.
4. **Adapters.**
   - `OpencodeAdapter` implements `RoleAdapter` and `ToolsAdapter` (ADRs 2026-11-17 and 2026-11-19) in the `opencode` feature. It renders roles as `agents` with `mode: subagent`, and it gives Writer's MCP server as `Launch::Config`: `mcp.servers.writer = {type: "local", command: [writer launcher, "vault=<root>", "mcp"]}`.
   - It turns read rules into OpenCode permission rules, `{action, resource, effect}`, last match wins. Tool names are `writer_<tool>`.
   - `restart_on_config_change` is `false`. A change to Writer's part rewrites its config file and applies at runtime where the API allows: MCP through `/api/experimental/mcp/writer`, instructions per session. Otherwise it applies with `POST /api/location/reload`, or with a server restart at the next idle moment. Sessions are never reloaded.
5. **Tool names in shared code.**
   - The Changes card's edit and shell tool sets (`agent/changes.rs`, `edit_inverse.rs`) and the web tool metadata (`features/agent/web/lib/tool-kinds.ts`) stop naming Claude's tools directly.
   - Each backend supplies one table that maps its tool names to neutral kinds: `edit`, `write`, `shell`, `read`, `search`, `subagent`, `web`, `mcp`. The core reads only kinds.
   - Claude's table reproduces today's names exactly.
6. **Feature and settings.**
   - A built-in feature `opencode` (`apps/desktop/features/opencode/`, `dependsOn: agent`, kill switch `features.opencode.enabled`) owns the server, the transport, the adapter, the models table and its settings fragment.
   - The settings are `agent.opencode.binary-path`, `agent.opencode.model`, `agent.opencode.disabled-models`, and one model per role tier: `agent.opencode.model-cheap`, `agent.opencode.model-standard` and `agent.opencode.model-strong`.
   - `agent.default-backend` (`claude` | `opencode`) is the agent's.
   - The registry entry in `features/agent/web/lib/backends.ts` moves from `coming-soon` to available, with `modelsSource: "server"` and `minVersion: "2.4.0"`.
   - The agent never names OpenCode in its code. It reaches the backend through a `agent.backends` provider point (`features/points.rs`), which `opencode` answers.
7. **Sign-in.** With no provider beyond OpenCode's built-in free one, the composer still works on the free models, and Settings shows "Connect a provider: opencode auth login". Writer never calls the connect or credential endpoints.

### Non-goals

- Connecting providers from Writer (OAuth or API keys). That stays the user's `opencode auth login`.
- OpenCode's own sharing, worktrees, revert, compaction controls, voice or image models.
- Migrating existing Claude chats to OpenCode or the reverse.
- Codex or other ACP backends.
- Running the user's background `opencode service` or attaching to a server Writer did not start.

### Consequences

- Good: a second backend without a second pane. The `Transport` seam and the tool-kind tables make the next backend a mapper, a transport and two tables.
- Good: one server per window serves all its OpenCode chats, so a new chat starts quickly once the server is up (about 6 s cold start, once).
- Bad: the v2 HTTP API reports version 0.0.1, and Writer uses some `/api/experimental` routes. Writer pins `>= 2.4.0`. The contract test against the pinned OpenAPI, and the fixtures, catch drift on each OpenCode upgrade.
- Bad: splitting `runner.rs` is the largest refactor of the agent since it was built. It is done first, with no behaviour change, and proven by the unchanged Claude goldens and tests.
- Neutral: the user's OpenCode config applies, so their agents, MCP servers and rules show up in Writer's OpenCode chats too, as in their terminal.

## Implementation Plan

Phases, one at a time, each validated and reviewed before the next (the project rule).

0. **Spike and fixtures.**
   - Record real event captures in a fresh temp dir with a temp HOME/XDG, on OpenCode's free built-in model:
     - a text turn;
     - an edit and a shell call with `ask` permissions;
     - a sub-agent;
     - an interrupt;
     - a steer.
   - Scrub them into `agent/fixtures/opencode/`.
   - Settle the unknowns from the 2026-11-23 research: the edit tool's metadata and diff shape, how a sub-agent launch links to its child session, `permission.asked` for `edit`/`shell`, whether `session.idle` is still emitted, whether config-injected MCP servers connect and how their tools are named, and the "no provider" error.
   - Write `SPECs/opencode-backend-spec.md` from them.
1. **`Transport` seam.**
   - Split `runner.rs` into `Session` plus `Transport`, and move the Claude child into `StdioTransport`.
   - Give Claude's tools their kind table and make the core read kinds.
   - No behaviour change: all Claude goldens, fixtures and runner tests pass unchanged.
2. **OpenCode transport and mapper.**
   - `OpencodeServer` (spawn, auth, ready, stop, restart) and `OpencodeTransport`.
   - `opencode_events.rs` with goldens from phase 0 (`WRITER_UPDATE_GOLDEN=1 cargo test golden`).
   - A fake OpenCode server for tests: a small local HTTP and SSE server that replays fixtures, in the style of `e2e/fixtures/agent-fake-claude`.
3. **Adapters and config.** `OpencodeAdapter` (roles, Writer's MCP server, read rules), the builder for Writer's config file, and the permission and question cards wired to the reply endpoints.
4. **Feature, settings and models table.**
   - The `opencode` feature, the `agent.backends` point and the backend picker in the new-chat menu.
   - Settings > Agent > OpenCode with the models table (tabs, search, capabilities, costs, Enabled switches), and the composer's model dropdown fed by the enabled models.
5. **Docs.** `SPECs/native-agent-spec.md` §9 points to the new spec, `CHANGELOG.md`, and the user-facing docs.

- **Affected paths:**
  - `src-tauri/src/agent/{runner.rs, session.rs, changes.rs, edit_inverse.rs, sub_tracker.rs, subagents.rs, events.rs}`;
  - new `src-tauri/src/agent/{transport.rs, opencode_events.rs}` and `agent/fixtures/opencode/`;
  - `src-tauri/src/features/points.rs`;
  - new `apps/desktop/features/opencode/` (`feature.json`, `rust/`, `web/`, settings fragment);
  - `features/agent/web/lib/{backends.ts, tool-kinds.ts, model-catalog.ts}` and the new-chat menu;
  - `shared/agent-roles.json` (unchanged roles; the adapter output is pinned by tests);
  - `SPECs/`, `CHANGELOG.md`.
- **Patterns to follow:**
  - the `claude_stream.rs` split: a pure mapper, goldens and scrubbed fixtures;
  - the feature rules in `.agents/skills/writer-feature/SKILL.md`: an owned point, the feature scope owns its threads, and off degrades;
  - `commands::blocking` for every IPC command that touches the server;
  - the redaction rules of `logging.rs`: never log the password, prompts, note text or tool output.
- **Patterns to avoid:**
  - `opencode` names inside `agent/` (the agent asks the point);
  - Claude tool-name literals outside Claude's table;
  - a second pane or a second note format;
  - writing `opencode.json`, `.opencode/` or anything in `~/.config/opencode` (Writer's own file lives in its app data folder);
  - calling `/api/credential` or `/api/integration/*/connect/*`;
  - a fixed port, or binding beyond `127.0.0.1`.
- **Dependencies:** none added. `reqwest`, already in, for HTTP and streaming. Typed models cover only the routes and events Writer uses (`agent/opencode_api.rs`), and a contract test checks each of them against a pinned copy of 2.4.0's OpenAPI, `apps/desktop/shared/opencode/openapi-2.4.0.json`. An OpenCode upgrade refreshes that copy, and the test lists what changed.
- **Tests:**
  - **Mapper goldens** for every captured flow.
  - **Transport, against the fake server:**
    - send;
    - steer and queue;
    - interrupt;
    - a permission round trip (once, always, reject);
    - a question round trip;
    - a sub-agent child routed to its parent;
    - an SSE drop followed by a resync from messages;
    - a server crash, then a restart on the next send;
    - a version below the minimum refused.
  - **Feature off:** no server process, and Claude chats are unchanged.
  - **Config builder:** Writer's config file is pinned as JSON. Writer's MCP server and the roles are present, and no secret is in it. It is written 0600 in the app data folder, never in the vault.
  - **Contract:** every route, method and field Writer uses exists in the pinned OpenAPI.
  - **Settings (jsdom):** the models table filters (All, Enabled, Free, search), and its switches update `agent.opencode.disabled-models`.
  - **Phase 1:** proven by the existing Claude suite unchanged.

## Verification

- [ ] Phase 1 lands with `git diff` showing no change under `src-tauri/src/agent/fixtures/` or `shared/agent-golden/`, and the full test suite green.
- [ ] An OpenCode chat in a real window sends, streams text and tools, asks permission, stops on Stop, and resumes after a Writer restart.
- [ ] A question the agent asks (`form.created`) shows in the question card like Claude's `AskUserQuestion`, and the answer reaches the agent.
- [ ] A sub-agent shows in the chat and the tray like a Claude sub-agent: card, model, its own tool calls, running and done, resumed. It is fed by the child session's events, routed to the parent chat.
- [ ] The server listens only on `127.0.0.1`, rejects a request without the password, and is gone after its window closes (`pgrep -f "opencode serve"`).
- [ ] No file is written under the vault's `.opencode/` or `~/.config/opencode`, and the password appears in no log.
- [ ] The models table lists the server's models with costs and capabilities, and a switched-off model is absent from the composer's dropdown.
- [ ] With `features.opencode.enabled = false` or OpenCode not installed, Claude chats behave as before, and the new-chat menu shows OpenCode as unavailable.
- [ ] `vp check`, `vp test`, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` green.

## More Information

- Supersedes, in ADR 2026-11-17 "Build a first-party agent pane over the claude CLI's stream-json protocol", the line that a second backend would come "over ACP": OpenCode comes through its server; ACP remains an option for Codex.
- Research of 2026-11-23: the OpenAPI from a private v2.4.0 server, the online docs, and the open unknowns listed in phase 0. An earlier note in `SPECs/native-agent-spec.md` §9 named `session.step.streamed` and `session.idle`. In v2.4.0 these are `session.text.*` / `session.tool.*` and `session.execution.*`.
- Related: ADR 2026-11-17 roles and adapters, ADR 2026-11-19 Writer's MCP server through adapters, ADR 2026-11-20 "Let features cooperate through owned points, optional services and rare requires", ADR 2026-11-17 "Restart claude agent sessions when their loaded config changes".
