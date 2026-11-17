# Agent roles: backend-neutral sub-agents

Status: proposal (2026-11-17). Not implemented. Depends on: `SPECs/native-agent-spec.md` ("Orchestration and sub-agents"), `SPECs/builtin-plugins-spec.md` (Step 4, pilot `agent`), ADR "build first-party features as built-in plugins". Applies `engineering-philosophy` (DRY > SOLID > KISS).

## 1. Problem

Orchestration today is Claude-shaped end to end:

- `agent/subagents.rs::agents_json` hard-codes one role (`writer-explorer`) as Claude's `--agents` JSON, with Claude tool names (`Read`, `Glob`, `Grep`, `Bash`) and Claude model aliases (`haiku`).
- `agent.subagent-model` is one vendor-model string.
- The `ORCHESTRATE` line in the system block names `writer-explorer` and "Agent/Task calls", both Claude Code vocabulary.
- There is no `writer-worker`, because delegated edits are not covered by the Changes card (section 2, answer A).

Goal: define roles once as data, let each backend adapter translate them, and keep the prompt text, the settings and the permission rules free of vendor names. First additional backend: OpenCode.

## 2. Prerequisite: do sub-agent edits reach the Changes card? (verified)

Answer: yes for the `Write`/`Edit` tool_use itself, with one caveat about attribution and timing. Evidence:

- Real CLI (claude, `-p --output-format stream-json --verbose --agents '{worker: tools [Write]}'`, fresh empty temp dir): the sub-agent's `Write` arrives on the same stdout as an `assistant` message with top-level `"parent_tool_use_id": "<id of the Agent tool_use>"`, a full `input` (`file_path` absolute, `content`), and its `tool_result` also carries the parent id. The parent's own `Agent` tool_use has `parent_tool_use_id: null` and `name: "Agent"` (input: `subagent_type`, `description`, `prompt`). `system` events `task_started`, `task_progress`, `task_updated`, `task_notification` surround it. The run ended with two `result` messages (the sub-agent's notification woke a second main-agent step).
- `claude_stream.rs` does not drop these: both the streamed path (`content_block_start`, L261) and the full-message path (L378) emit `ToolCallStarted`/`ToolCallInput` with `parent_tool_call_id: Self::parent_tool(v)`. Unknown `system` subtypes are ignored.
- `runner.rs` (L725-756) collects `(tool, input)` for every `ToolCallInput` and `PermissionRequest` regardless of parent, then calls `changes.capture(...)`; `changes.rs::capture` filters only by tool name (`EDIT_TOOLS` = Edit, MultiEdit, Write, NotebookEdit; `Bash` marks "a shell ran") and confines paths to the vault. So a sub-agent `Write` is snapshotted exactly like a main-agent one, as long as the snapshot is taken before the file changes.

Caveats to close before shipping `worker`:

1. Ordering: the pre-image must be taken before the sub-agent's tool runs. With `acceptEdits` or an allow rule there is no `PermissionRequest`, so the snapshot happens when the `ToolCallInput` event is processed, which can race the tool execution (the CLI emits the assistant message, then runs the tool). This is the same race that exists for the main agent today; a test with a fake `claude` that emits a sub-agent edit with `parent_tool_use_id` must pin it.
2. Turn boundary: `close_turn` runs on the first `TurnFinished`. A sub-agent that outlives the first `result` (background or woken by `task_notification`) would edit after the card closed. Fix: treat a turn as open while any `Agent`/`Task` tool call with no `tool_result` exists, and ignore the first `result` when background tasks are listed (`background_tasks_changed`); or attach late edits to a follow-up card.
3. UI: the card should list the file once with its author (main agent or role name). `parent_tool_call_id` already identifies the sub-agent call; map it to a role name through the `Agent` call's `subagent_type`.
4. Permissions: sub-agent tool calls appear to use the parent's permission flow (spec says so; not re-verified for `can_use_tool` control requests, which should carry `tool_use_id` of the sub-agent call). The `worker` phase must verify that a manual-mode permission card for a sub-agent edit is attributed and answerable.
5. Bash in a sub-agent is "a shell ran" only; same limit as the main agent.

Requirement: no `worker` role ships until a fake-claude runner test and one manual real-CLI check show a sub-agent edit producing a card entry with a working Undo.

## 3. Role registry (one source of truth)

File: `apps/desktop/shared/agent-roles.json`, read by Rust (`include_str!`, serde) and TypeScript (JSON import), like `shared/code-files.json`. A contract test in each language parses it and checks the invariants below.

```json
{
  "version": 1,
  "tiers": ["cheap", "standard", "strong"],
  "capabilities": {
    "read": "Read files in the working directory and added folders",
    "search": "Find files by name and content (glob, grep)",
    "writer-cli-read": "Run read-only `writer` commands (search, backlinks, links, properties, bases, base:query)",
    "edit": "Modify existing files",
    "write": "Create files",
    "bash-limited": "Run shell commands; only the permission rules decide which"
  },
  "roles": [
    {
      "id": "explorer",
      "purpose": "Cheap read-only helper: finds, reads and summarises notes ...",
      "prompt": "You explore a vault of Markdown notes for another agent. ...",
      "tier": "cheap",
      "capabilities": ["read", "search", "writer-cli-read"],
      "readOnly": true
    },
    {
      "id": "worker",
      "purpose": "Makes a bounded set of edits to named notes and reports what changed.",
      "prompt": "...(section 6)",
      "tier": "standard",
      "capabilities": ["read", "search", "writer-cli-read", "edit", "write"],
      "readOnly": false,
      "requires": ["changes-card-subagents"]
    }
  ]
}
```

Invariants (contract test): ids are unique lowercase slugs; every capability exists; `readOnly` roles hold none of `edit`, `write`; `bash-limited` is never in a `readOnly` role and `writer-cli-read` is the only shell capability a `readOnly` role may have; a role with `requires` is skipped by adapters until the named feature flag is true (flag list owned by the registry reader, one place); every prompt is backend-neutral (no tool names, no vendor model names; test greps for `Read`, `Glob`, `Grep`, `Bash`, `haiku`, `sonnet`, `opus`, `Task`, `Agent`). The capability text is the neutral wording; adapters supply tool names. Prompt sentences that depend on a capability (the `writer` CLI paragraph today) are stored as `promptByCapability: {"writer-cli-read": "..."}` and appended only when the capability is granted AND the managed skills are installed (replaces `EXPLORER_PROMPT_CLI`).

Backend-visible names are `writer-<id>` (`writer-explorer`, `writer-worker`), derived in one function, so existing chats and the orchestration text keep working.

## 4. Backend adapters

A backend adapter is a pure function `roles + tier models + flags -> backend config`, living with its backend (Rust, Tauri-free, golden-tested like `claude_stream`):

```
trait RoleAdapter {
    fn tool_names(cap) -> &[&str];                 // capability -> backend tools / permission rules
    fn render(roles, tier_models, flags) -> Rendered;  // argv fragment, env, or files to place
}
```

Capability tables are data in the adapter (a `match`), not branches in callers; adding a capability touches the registry and each adapter table, and a test fails if an adapter does not cover every capability (no silent drop).

### 4.1 Claude Code (exists, refactored)

`--agents <json>`: `{ "writer-<id>": { description: purpose, prompt, tools: [...], model: <alias> } }`.

| capability        | Claude tools                                          |
| ----------------- | ----------------------------------------------------- |
| `read`            | `Read`                                                |
| `search`          | `Glob`, `Grep`                                        |
| `writer-cli-read` | `Bash` (only with managed skills installed; see note) |
| `edit`            | `Edit`, `MultiEdit`                                   |
| `write`           | `Write`                                               |
| `bash-limited`    | `Bash`                                                |

Note: Claude's tool list cannot restrict Bash to `writer` subcommands; the read-only guarantee comes from the permission rules (`agent.allowed-tools`), as today. A `readOnly` role with `writer-cli-read` is therefore "read-only by prompt plus rules", and the spec must keep saying so. Tier to model: setting `agent.claude.tier-models` (section 5), values are aliases or pinned names validated like `--model`. Unverified (carried from the native spec): that the CLI honours per-agent `model` and `tools`. The real-CLI run for section 2 used `tools: ["Write"]` and `model: "haiku"` and the sub-agent wrote the file; that confirms `tools` accepts the field, not that other tools were denied (not tested).

### 4.2 OpenCode (future `opencode` feature)

Researched from the public docs (fetched 2026-11-17). Treat as provisional: the pages describe a "V2" format that differs from the older `agent`/`tools`/`permission` format I know, and I could not confirm which version users have installed.

- https://opencode.ai/docs/agents/: agents come from `.opencode/agents/<name>.md` (project), `~/.config/opencode/agents/<name>.md` (global) or the `agents` key of any OpenCode config (`opencode.jsonc`). Fields: `description`, `mode` (`primary` | `subagent` | `all`), `model` (`provider/model` with optional `#variant`, or `{providerID, model, variant}`), `system` (Markdown: the body), `permissions` (ordered list of `{action, resource, effect}`, effect `allow|ask|deny`, last match wins; actions include `edit`, `shell`, `read`, `glob`, `grep`, `webfetch`, `websearch`, `subagent`), `steps`, `hidden`, `disabled`. `tools`, `temperature`, `prompt` and `maxSteps` are documented as legacy.
- https://opencode.ai/docs/models/: selectors are `provider/model[#variant]`; no `small_model` option on that page; no tier concept; variants (`low`, `high`, `max`) are per-model options; models are listed with `/models` in a session (no documented CLI listing command).

Mapping (adapter table):

| capability        | OpenCode permissions                                        |
| ----------------- | ----------------------------------------------------------- |
| `read`            | allow `read`                                                |
| `search`          | allow `glob`, `grep`                                        |
| `writer-cli-read` | `shell` ask/allow for `writer <cmd> *` resources, else deny |
| `edit`, `write`   | allow `edit`                                                |
| `bash-limited`    | `shell` ask                                                 |
| (anything absent) | explicit `deny` rule, so a role never inherits defaults     |

Because `shell` accepts a `resource` pattern, OpenCode can enforce the `writer`-only restriction that Claude cannot (verify the pattern syntax before relying on it). Placement: write the agents as managed files in the workspace (`.opencode/agents/writer-<id>.md`, a marker line for versioning like `managed_skills/`), or pass them inline through a config env var if one is documented (not confirmed). Writing into the vault is the managed-skills precedent but dirties user folders; prefer an inline mechanism when confirmed. Not confirmed: how OpenCode streams sub-agent tool calls and whether they carry a parent id (needed for section 2 behaviour; if absent, the OpenCode mapper must tag them itself or the Changes card falls back to file-system diffing for that backend); the headless/server protocol Writer would drive; sign-in detection.

### 4.3 Codex and others

Out of scope; the adapter trait is the only thing they must implement, and a backend without sub-agents simply returns `Rendered::none()` and the orchestration line is not sent (section 7).

## 5. Tiers and settings

Roles name a tier, never a model. Settings (all `scope: global`, in the `agent` feature fragment, validated like `agent.model`):

| key                           | type   | default (Claude)                                                      | meaning                                                 |
| ----------------------------- | ------ | --------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent.claude.model-cheap`    | string | `haiku`                                                               | tier `cheap`; blank or `auto` = default                 |
| `agent.claude.model-standard` | string | `sonnet`                                                              | tier `standard`                                         |
| `agent.claude.model-strong`   | string | `default` (the chat's own)                                            | tier `strong`                                           |
| `agent.opencode.model-<tier>` | string | blank = use `agent.opencode.default-model`, else the OpenCode default | `provider/model[#variant]`, only when the backend ships |

The per-backend keys are contributed by each backend's feature fragment (the contract test already rejects keys outside a feature's prefix), so the `agent` fragment owns only backend-neutral keys (`agent.orchestrate`, `agent.role.<id>.enabled`, optional `agent.role.<id>.tier` override). One resolver `resolve_tier_model(backend, tier, settings) -> Option<String>` in Rust, twin-free: TypeScript never resolves tiers, it only renders the settings rows from the schema.

Migration of `agent.subagent-model`: on settings load, if `agent.subagent-model` is set and `agent.claude.model-cheap` is unset, copy the value into `model-cheap` and mark the old key deprecated (kept readable for one release, hidden in the UI, removed after). Same blank/`auto`/unsafe rules as today (`title::cheapest_model`, which then becomes `claude`'s tier fallback, not a global rule). The title model (`agent.title-model`) stays separate for now; open question 3.

An unknown or unavailable model for a tier never silently falls back to a different vendor: the adapter drops the role for that session and the pane shows a one-line notice ("explorer disabled: model X not available"), per "fail explicitly".

## 6. Neutral orchestration text

The system block keeps one line, `ORCHESTRATE`, rendered by `writer_prompt` from the registry and the adapter's vocabulary:

- Role list: `writer-<id>` plus its `purpose`, only for roles the adapter actually rendered this session.
- Delegation verb: a per-backend string for "launch a sub-agent" supplied by the adapter (`"Agent/Task call"` for Claude, whatever the OpenCode `subagent` action is called), so the common sentence reads "run sub-agents in parallel (several {launch} in one message)".
- Policy sentences (split independent work, delegate mechanical exploration to the explorer, delegate bounded edits to the worker, do trivial work yourself) are fixed neutral text in the prompt module, with the worker sentence present only when the worker is rendered.
- No roles rendered (setting off, backend without sub-agents, models unavailable): no line, no `--agents`.

Goldens: the four existing variants stay byte-identical for Claude with the explorer only (regression guard for the refactor); new goldens add the worker variant and an OpenCode variant. The 'budget' test keeps its size limit.

## 7. Permissions and the Changes card, per role

| role     | tools it may use             | permission flow                                                                                                                                   | Changes card                                                                                        |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| explorer | read, search, `writer` reads | no prompts for reads inside the vault; `writer` reads allowed by default rules; anything else shows a normal card                                 | none expected; a test asserts no edit tool is in its set                                            |
| worker   | adds edit and write          | same cards and rules as the main agent in the chat's mode (`manual` default); never auto-allowed by the role; `agent.disallowed-tools` still wins | requires answer A items 1-4 solved and tested; edits listed with the role name; Undo works per file |

Rules: a role can never widen what the user's permission mode allows; roles narrow the tool surface, rules decide prompts. `worker` is off by default (`agent.role.worker.enabled` false) until the section 2 requirement is met, then default on with orchestration. Concurrent workers editing the same file are possible; the prompt tells the orchestrator to give workers disjoint files, and the card's first-snapshot-wins rule keeps Undo correct (it restores the turn's original).

Worker prompt (proposal, neutral):

> You make a bounded set of edits to Markdown notes for another agent. You receive the exact files to change and what to change. Read the file first, make the smallest edit that does it, keep the author's wording, formatting, frontmatter and links (links are by file name; never rename or move files), and do not touch any other file. If the task needs more than the files you were given, or is ambiguous, stop and say so instead of guessing. Reply with one line per file: the vault-relative path and what you changed.

## 8. Fit with built-in features

- `agent` feature (Step 4 pilot): owns `shared/agent-roles.json` consumption, `RoleAdapter` trait, the Claude adapter (today's `subagents.rs`, renamed `roles/claude.rs`), the neutral settings and the Settings > Agent rows (a "Sub-agents" group: enabled switch per role, tier per role). The registry file lives under `apps/desktop/shared/`, not in the feature folder, because both the agent core and every backend feature read it (shared contract, same rule as `code-files.json`).
- `opencode` feature (later, `dependsOn: ["agent"]`): a `Feature<R>` whose `setup` registers a backend implementation (detect, spawn, stream mapper, `RoleAdapter`) in the agent feature's backend registry and contributes `agent.opencode.*` settings. The TS `AGENT_BACKENDS` descriptor list becomes contributions from features (today: a static array with OpenCode "coming soon"); the descriptor gains `roles: "supported" | "none"`. Adding a backend then touches its own feature folder and nothing in `agent/`, which is the consolidation rule's test.
- Before any of this the agent code is moving to `apps/desktop/features/agent/` (in progress elsewhere); this spec does not name file paths inside it beyond the shared JSON.

## 9. Phased plan

1. Verify and pin answer A: fake-claude runner test with `parent_tool_use_id` edits, the in-flight Agent-call turn boundary, attribution in `TurnChangesSummary`. No behaviour change for explorer.
2. Registry JSON + contract tests; refactor `agents_json` to render from it; Claude adapter; goldens unchanged. Neutral `ORCHESTRATE` rendering. Tier settings and migration of `agent.subagent-model`.
3. Settings UI group, per-role switch, role attribution in the Changes card; real-CLI manual check; turn on `worker` behind its switch, then default on.
4. OpenCode spike (separate spec): confirm config injection, permission patterns, sub-agent stream shape and parent ids, headless protocol; then the `opencode` feature with its adapter.
5. Remove the deprecated `agent.subagent-model` key.

## 10. Decisions (user, 2026-11-17)

1. Tiers: `cheap`, `standard`, `strong`; `strong` defaults to the chat's own model.
2. `worker` ships **on by default**, but only once the Changes-card prerequisites (answer A items 1-4: snapshot ordering test, turn kept open until every sub-agent finishes, per-role attribution, sub-agent permission cards) are implemented and tested. Until then it is not offered.
3. The title call moves onto the cheap tier: one cheap model per backend (`agent.title-model` migrates like `agent.subagent-model`). Every tier model setting is a **dropdown** of the backend's known models (from the model catalog the composer's model picker already uses), with a "custom" entry for a free value, never a bare text field.
4. OpenCode: Writer writes **managed agent files under `.opencode/agents/`** in the vault, installed and versioned like managed skills (marker, overwritten when stale, never touching user files there).
5. Roles are built-in only for now; the registry shape keeps room for vault-defined roles (`.writer/roles/*.json`) later.
6. OpenCode: support only the documented **V2 format and later** (`agents` key, `permissions` rules, `provider/model#variant`); the older `agent`/`tools`/`permission` format is not supported.
