---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Define agent roles once and map them to each agent backend through adapters

## Context and Problem Statement

The agent pane orchestrates by default: the Writer system block tells Claude to split work and delegate small read-only jobs to a sub-agent, and `agent/subagents.rs` passes one Claude-specific definition, `writer-explorer`, through the CLI's `--agents` JSON (model from `agent.subagent-model`, tools Read, Glob, Grep and Bash when the `writer` CLI is installed). Two needs outgrow that:

- a `worker` sub-agent that makes delegated edits, which is only acceptable if its edits reach the end-of-turn Changes card (review and Undo);
- other coding-agent backends than Claude Code later, OpenCode first, which describe sub-agents in their own config format.

Writing each sub-agent per backend would duplicate the purpose, prompt and permission intent of every role in every backend. A real-CLI check (spec `SPECs/agent-roles-spec.md`, answer A) showed sub-agent `Write` calls reach the stream with `parent_tool_use_id` and are already captured by `changes.rs`, with three gaps: the turn closes on the first `result` while a sub-agent can still write, edits are not attributed to a role, and sub-agent permission cards in manual mode are untested.

## Decision Drivers

- One source of truth for what a role is (DRY), read by Rust and TypeScript like the settings schema.
- Roles narrow what a sub-agent may do; they never widen the user's permissions or bypass permission cards.
- No vendor model names or tool names inside role definitions: models come from tiers, tools from capabilities.
- A delegated edit is always reviewable on the Changes card and undoable.
- No new dependency.

## Considered Options

- A. One shared role registry (`apps/desktop/shared/agent-roles.json`) with neutral capabilities and model tiers, and one pure adapter per backend that maps it to that backend's config.
- B. Separate sub-agent definitions per backend, in each backend's code.
- C. User-defined roles from vault files from the start.

## Decision Outcome

Chosen option: **A**, with built-in roles only.

1. **Registry**: `apps/desktop/shared/agent-roles.json` defines `tiers` (`cheap`, `standard`, `strong`), `capabilities` (`read`, `search`, `writer-cli-read`, `edit`, `write`, `bash-limited`) and `roles`. Each role has `id`, `purpose`, `prompt` (backend-neutral text), `tier`, `capabilities`, `readOnly` and `requires` (preconditions such as `changes-coverage`). Built-in roles: `explorer` (cheap, read-only: read, search, writer-cli-read) and `worker` (standard: read, search, edit, write, writer-cli-read). Vault-defined roles (`.writer/roles/*.json`) are not supported now; the shape allows layering them later.
2. **Adapters**: a pure, Tauri-free `RoleAdapter` per backend maps roles, capabilities and tiers to backend config. The Claude adapter (today's `agent/subagents.rs`) produces the `--agents` JSON (model alias from the tier setting, tool list from a capability table). The OpenCode adapter, in a later `opencode` feature (`dependsOn: agent`), supports OpenCode's V2 format and later only (`agents` key, `permissions` rules, `provider/model#variant`) and writes managed agent files under `.opencode/agents/` in the vault, versioned by marker and overwritten when stale like managed skills, never touching the user's own files there.
3. **Tiers and models**: `strong` defaults to the chat's own model. Each backend owns one model setting per tier in its feature's settings fragment, shown as a **dropdown** of that backend's known models (the model catalog the composer's model picker uses) with a "custom" entry, never a bare text field. The title call uses the cheap tier. `agent.subagent-model` and `agent.title-model` migrate into the Claude cheap-tier setting (copied on first run, then removed).
4. **Orchestration text**: the system block renders one orchestration line from the roles the active adapter actually produced, with a backend-supplied verb for launching a sub-agent; the text names no vendor or tool. With `agent.orchestrate` off, no line and no roles are sent.
5. **Worker gate**: `worker` is **on by default**, but is offered only once its `changes-coverage` requirement is met in code and tests: (a) a fake-claude test pins snapshot-before-write for an edit carrying `parent_tool_use_id`; (b) the turn stays open while any `Agent`/`Task` call has no `tool_result` or background tasks are listed, so late sub-agent edits land on the card; (c) each Changes-card entry is attributed to its role through `parent_tool_call_id` -> the `Agent` call's `subagent_type`; (d) a sub-agent edit in manual permission mode raises an attributed, answerable permission card. Until all four pass, the adapter omits `worker`.
6. **Ownership**: the `agent` built-in feature owns the registry consumer, the Claude adapter, the tier settings and the orchestration line.

### Consequences

- Good: a role is written once; a new backend adds an adapter and its settings, not new role definitions.
- Good: delegated edits stay reviewable and undoable before `worker` is ever offered.
- Good: models are chosen per tier from a list, and the two vendor-name settings disappear.
- Bad: adapters can express only what a backend supports; a capability a backend cannot narrow (Claude's tool list cannot restrict Bash to `writer` commands) falls back to the permission model and the role prompt, which the adapter must document per capability.
- Bad: two settings migrate, which needs a one-time migration with tests.
- Neutral: OpenCode's stream shape, sub-agent parent ids and headless protocol are not confirmed yet; they are verified when the `opencode` feature is built.

### Non-goals

- The OpenCode backend itself (its own feature later).
- Vault-defined roles.
- Any change to the permission model or the trust model.
- Support for OpenCode formats older than V2.

## Implementation Plan

- **Affected paths**:
  - `apps/desktop/shared/agent-roles.json` (new) and its Rust and TS readers (Rust via `include_str!` like `settings.schema.json`; TS via a static import).
  - `apps/desktop/src-tauri/src/agent/subagents.rs` becomes the Claude adapter over the registry; `agent/writer_prompt.rs` renders the orchestration line from adapter output; `agent/claude_stream.rs` maps `task_*` system events and keeps `parent_tool_call_id`; `agent/runner.rs` and `agent/changes.rs` for the turn-open rule and per-role attribution; `agent/events.rs` and `src/lib/agent/events.ts` for the attributed change entries.
  - `apps/desktop/shared/settings.schema.json` (or the `agent` feature's settings fragment once Step 4 lands): per-tier model settings for Claude with dropdown metadata, migration of `agent.subagent-model` and `agent.title-model`, `config.rs` count test.
  - Settings UI: the tier dropdowns fed by `src/lib/agent/model-catalog.ts`.
  - `src/components/agent/turn-changes-card.tsx`: role label on sub-agent entries.
  - `SPECs/agent-roles-spec.md` (decisions recorded), `SPECs/native-agent-spec.md` (orchestration section).
- **Patterns to follow**: shared JSON contract consumed by both sides (as `settings.schema.json`); adapters pure and Tauri-free with goldens; capability tables as data; managed files for OpenCode following `managed_skills/` (marker, version, never touch user files).
- **Patterns to avoid**: vendor model names or tool names in `agent-roles.json`; per-backend copies of role prompts; a sub-agent definition that grants a tool the user's permission mode would not allow; offering `worker` before its requirement passes.
- **Tests**:
  - Registry contract: every role's tier and capabilities exist; prompts contain no vendor or tool names; every capability is mapped (or explicitly marked unsupported with a documented fallback) by every adapter.
  - Claude adapter goldens: `explorer` output is byte-identical to today's `writer-explorer` JSON; `worker` absent while its requirement is unmet.
  - System block goldens for orchestrate on/off and for the roles produced.
  - Settings migration: old values copied once, old keys removed, dropdown default matches the catalog.
  - Fake-claude: a sub-agent edit with `parent_tool_use_id` lands on the Changes card with its role; the turn stays open until the sub-agent's `tool_result`; a manual-mode sub-agent permission card is attributed and answerable.

### Verification

- [ ] `agent-roles.json` exists and both Rust and TS read it; the contract test passes.
- [ ] The Claude `--agents` JSON for `explorer` is unchanged from today (golden).
- [ ] `agent.subagent-model` and `agent.title-model` are migrated and gone; tier models are dropdowns with a custom entry.
- [ ] The four worker prerequisites have passing tests, and only then `worker` appears in the `--agents` JSON by default.
- [ ] The orchestration line contains no vendor or tool name.

## Pros and Cons of the Options

### A. Shared registry plus adapters

- Good, because roles exist once and new backends only map them.
- Bad, because the registry is one more shared contract to keep in sync, guarded by tests.

### B. Per-backend definitions

- Good, because each backend uses its native format directly, with no mapping layer.
- Bad, because every role's purpose, prompt and permission intent is duplicated per backend and drifts.

### C. User-defined roles from day one

- Good, because users can shape delegation to their vault.
- Bad, because it needs validation, a UI and a trust story before the built-in roles have proven themselves; the registry shape keeps it possible later.

## More Information

Spec: [`SPECs/agent-roles-spec.md`](../../SPECs/agent-roles-spec.md) (OpenCode sources and unconfirmed points, the real-CLI evidence for sub-agent events). Related: [first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [built-in features](2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md), [one settings schema](2026-04-30-one-settings-schema-shared-by-rust-and-typescript.md). Revisit if a backend cannot express capability narrowing at all, or when vault-defined roles are requested.
