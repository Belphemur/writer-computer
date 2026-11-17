---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Keep agent memory in the vault through the backend's own memory tool

## Context and Problem Statement

The agent pane runs the `claude` CLI (stream-json). Claude Code's auto memory is already on for every Writer chat, unmanaged: a "remember X" from the user is written as Markdown under the user's home Claude folder, in a directory keyed by the git root or, outside git, by the spawn cwd. The investigation in [`SPECs/agent-memory-spec.md`](../../SPECs/agent-memory-spec.md) (real CLI 2.1.326, temp dirs only) found:

- **Fragmented scope.** A vault that is not a git repo gets one memory per cwd (vault root and every project folder separately), so a fact told in a project chat is unknown in a vault chat.
- **Memory leaves the vault.** It is keyed by absolute path in the home folder: moving, renaming or syncing the vault loses it. This contradicts Writer's local-first, plain-files-in-the-vault promise.
- **Invisible.** No setting, no viewer, no way to edit or forget.
- **Prompt conflict.** The Writer system block says "Never touch .writer/"; the CLI's own memory tool ignores prompt rules (check 5).
- **Backend lock-in.** Memory is a Claude Code feature; the [agent roles ADR](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md) targets OpenCode next.

Verified: `--settings '{"autoMemoryDirectory":"<dir>"}'` makes the CLI save `MEMORY.md` plus one note per fact into `<dir>`, a new session (no `--resume`) recalls it, and the write needs no permission prompt even in `default` mode. No settings file is written. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off.

## Decision Drivers

- Memory travels with the vault and is one plain-text folder the user can read, edit and delete.
- One memory for the whole vault, plus one per project, independent of git layout.
- The memory location comes from Writer, never from model input, and is confined to the vault.
- Never write `.obsidian/`; never read the home Claude folder except in a user-clicked import, and then only the matching project memory directories.
- Keep the CLI's built-in judgment about what to save; do not re-implement it in prose.
- Backend-neutral shape, mapped per backend by the adapter like roles.
- No new dependency; the Writer block stays within its 2000-character budget.

## Considered Options

- A. Redirect the backend's own memory tool into the vault (`autoMemoryDirectory` for Claude), with neutral wording and a neutral `memory_directory` capability.
- B. Keep Claude's default home location and only document it.
- C. A Writer-owned memory format told to the model through the system block (Claude's auto memory off), or an external memory library such as kremory.

## Decision Outcome

Chosen option: **A**.

1. **Setting.** `agent.memory` in the agent feature's settings fragment, values `vault` (default), `default` (Claude's home location, today's behavior) and `off`. `vault` passes `--settings` with `autoMemoryDirectory`; `off` sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` through `env.rs` (the one env builder); `default` leaves argv and env unchanged.
2. **Locations.** Vault memory is `<vault>/.writer/memory/`. Project memory is `<project>/.memory/`, the hidden-folder pattern of `<project>/.chats/` ([chats ADR](2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md)). Both are dot folders, so the index, watcher, sidebar and Quick Open already skip them.
3. **Scope.** A vault chat's spawn uses the vault memory directory. A project chat's spawn uses the project memory directory as its `autoMemoryDirectory` (where new facts land) and is told in the Writer block to also read the vault memory's `MEMORY.md`; so a project chat sees both, a vault chat sees the vault memory only. The path is built by one pure function from the session's confined root and project, absolute, inside the vault, never from model input.
4. **Prompt.** The Writer block gains one neutral memory line (names the folder, "read `MEMORY.md` first, save only stable facts or preferences the user asks you to remember or corrects you on, never note contents or secrets") and the FORBIDDEN rule is reworded to "Never touch .obsidian/, .git/, other .writer/ files or secret files". No vendor or tool name. With `off` or `default` no memory line is sent. The block stays within 2000 characters.
5. **Changes card.** Writes under either memory directory are excluded from the end-of-turn Changes card and Undo (`changes.rs`); a memory save is not a note edit.
6. **UI.** Settings > Agent gets a "Memory" section: the mode, the vault and project memory paths (read-only, "Open folder"), the list of memory files with open (as a normal note tab), delete and "Forget all". All through thin async `commands/` handlers using `commands::blocking`, vault-confined.
7. **Import.** A one-time, user-initiated "Import from Claude Code" button copies the existing home memory for this vault and its projects into the vault and project memory folders. It reads only `<home Claude folder>/projects/<key>/memory/` for the keys derived from the vault root and each project path (Claude's own path-to-key rule), nothing else under that folder, and only when clicked. Existing files in the target are never overwritten (name clash: suffix). Nothing is deleted from the home folder.
8. **Format.** Claude Code's memory layout (`MEMORY.md` index plus frontmatter notes) for now. Other backends convert in their adapter.
9. **Backend-neutral.** `memory_directory` is a neutral capability next to the role capabilities; the Claude adapter maps it to `autoMemoryDirectory`, a later OpenCode adapter maps it to its own config or to the prompt line alone.

### Consequences

- Good: memory is in the vault, survives moves and sync, is the same with or without git, and is visible and editable as Markdown.
- Good: the CLI keeps deciding when to save, deduping and sizing its index; Writer adds no save logic.
- Good: the "Never touch .writer/" contradiction is gone.
- Bad: memory is plain text readable by anyone with the vault; the Settings section says so. Secret redaction relies on the model plus the prompt rule.
- Bad: reliance on a newer Claude setting; if a CLI ignores `autoMemoryDirectory`, memory falls back to the home location silently. The manual check below covers the shipped CLI; revisit on a CLI that drops the setting.
- Bad: hidden folders are skipped by Obsidian Sync and some tools (same trade-off as `.chats/`).
- Neutral: users with existing home memory see an empty vault memory until they click Import; no silent migration.
- Neutral: sub-agents (explorer, worker) get no memory, matching the CLI; the main agent passes relevant facts in the delegation prompt.

### Non-goals

- kremory or any external memory library, vector search, embeddings. Its ideas (bi-temporal facts, reversible consolidation) may be built later on the vault index under a new ADR.
- A Writer-owned memory format.
- Memory for sub-agents.
- A memory sidebar panel (possible later through the feature contribution points).
- Automatic or repeated import from the home Claude folder; deleting anything there.
- The OpenCode mapping itself (built with the `opencode` feature).

## Implementation Plan

- **Affected paths**:
  - `apps/desktop/features/agent/settings.schema.json`: `agent.memory` (`vault`|`default`|`off`, default `vault`, description including the plain-text warning); Rust count tests in `config.rs`.
  - `apps/desktop/src-tauri/src/agent/claude_stream.rs`: pure `memory_settings_json(dir)` and its use in `build_args` (only in `vault` mode); `build_title_args` unchanged (title call writes no memory).
  - `apps/desktop/src-tauri/src/agent/env.rs`: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for `off`.
  - `apps/desktop/src-tauri/src/agent/session.rs` (or wherever the spawn resolves root and project): one pure `memory_dir(root, project) -> PathBuf` inside the vault; create the directory before spawn.
  - `apps/desktop/src-tauri/src/agent/writer_prompt.rs`: memory line (vault, or vault plus project read line) and reworded FORBIDDEN; goldens.
  - `apps/desktop/src-tauri/src/agent/changes.rs`: exclusion of both memory directories.
  - `apps/desktop/src-tauri/src/agent/subagents.rs` and `shared/agent-roles.json` capability table: `memory_directory` mapping for the Claude adapter.
  - New async commands in the agent feature (`plugin:agent|memory_list`, `memory_delete`, `memory_forget_all`, `memory_import_claude`) with `feature.json` permissions, tauri-specta bindings regenerated (`WRITER_UPDATE_BINDINGS=1 cargo test bindings`).
  - `apps/desktop/features/agent/web/`: the Settings > Agent "Memory" section.
  - `SPECs/agent-memory-spec.md` and `SPECs/native-agent-spec.md` (memory paragraph); `CHANGELOG.md`.
- **Patterns to follow**: Tauri-free pure path and argv builders with goldens (`claude_stream.rs`); one env builder (`env.rs`); vault confinement through `vault_ops.rs`; feature commands through `contain` and `commands::blocking`; hidden dot folders as for `.chats/`; adapter capability tables as data (roles ADR).
- **Patterns to avoid**: a memory path from model or tool input; writing any settings file (`.claude/settings*.json`) or anything under `.obsidian/`; reading the home Claude folder outside the import command or beyond the matching `projects/<key>/memory/` directories; logging memory contents or paths; vendor or tool names in the Writer block; growing the block past its budget.
- **Tests**:
  - Argv goldens: `vault` adds `--settings` with the vault path (vault chat) or the project path (project chat); `default` argv byte-identical to today; `off` env contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and no `--settings`.
  - `memory_dir` rejects paths outside the vault (`..`, symlink escape) and is never derived from input.
  - Writer block goldens per mode and scope; `stays_within_the_budget`; neutral-template test (no vendor/tool names).
  - `changes_tests.rs`: a Write under `.writer/memory/` or `<project>/.memory/` yields no card entry; a note Write in the same turn still does.
  - Memory commands on a fixture vault: list, delete, forget-all confined to the memory dirs; allowlist tests green.
  - Import on a fixture fake home: copies only the matching keys' `memory/` files, ignores other keys and other files, never overwrites, idempotent on a second run.
  - Fake-claude runner test: the spawned argv and env per mode.
  - React test for the Memory section (list, delete, forget-all confirm, import button).

### Verification

- [ ] `agent.memory` exists with default `vault`, and the Rust and TS settings tests pass.
- [ ] Argv and env goldens for `vault` (vault and project chats), `default` and `off` pass; `default` is unchanged from before.
- [ ] Memory writes produce no Changes card entry; note edits in the same turn still do.
- [ ] The Writer block names the memory folder only in `vault` mode, stays within 2000 characters, and no longer says "Never touch .writer/".
- [ ] Import reads only the matching `projects/<key>/memory/` directories, only on click, and never overwrites.
- [ ] Manual, real CLI in a temp vault: "remember X" in a vault chat lands in `.writer/memory/`, a new chat recalls it; in a project chat it lands in `<project>/.memory/` and the vault fact is still recalled.

## Pros and Cons of the Options

### A. Redirect the backend's memory tool into the vault

- Good, because it keeps the CLI's tuned save behavior and fixes location, scope and visibility with one spawn flag.
- Good, because the neutral capability lets other backends map the same folder.
- Bad, because the format is Claude's and the redirect depends on a newer CLI setting.

### B. Keep Claude's home location

- Good, because it costs nothing.
- Bad, because memory stays fragmented, outside the vault, invisible and Claude-only.

### C. Writer-owned format or an external memory library

- Good, because it is fully backend-neutral and ours.
- Bad, because it re-implements save, dedupe and index sizing in prose the model follows less reliably than its built-in tool.
- Bad (kremory), because it is young and heavy and needs its own LLM and embedder, a new dependency stack for a local-first editor.

## More Information

Spec and evidence: [`SPECs/agent-memory-spec.md`](../../SPECs/agent-memory-spec.md) (real-CLI checks, gaps, decisions of 2026-11-17). Related: [first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [agent roles and adapters](2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md), [chats as notes](2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md), [projects](2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md). Revisit if the CLI drops `autoMemoryDirectory`, if users want memory searchable (a visible folder), or when a memory layer over the vault index is proposed.

Verification note (2026-11-17, implemented). Checked by tests: `agent.memory` exists with default `vault` (Rust schema load, `tests/agent-settings-schema.test.tsx`); argv with `--settings` for a vault chat and a project chat, `default` argv unchanged, `off` env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` with no `--settings` (`claude_stream` and `runner_tests::memory_modes_set_the_spawn_argv_env_and_prompt`, fake `claude`); `memory_dir` rejects `..`, an outside path and symlink escapes (`memory_tests.rs`); the Writer block's memory line per scope, the 2000-character budget (path up to about 60 characters in the worst case), neutral wording and the reworded FORBIDDEN (`writer_prompt` tests); memory writes absent from the Changes card while a note edit in the same turn is kept (`changes_tests.rs`); list, delete and forget-all confined to the memory folders and import from a fake home that copies only the matching keys, never overwrites and is idempotent (`memory_tests.rs`, `features/agent/rust/mod.rs`); the Memory section (`features/agent/tests/agent-memory.test.tsx`). Checked once against the real CLI 2.1.326 (haiku, a fake vault in a temp folder, no settings file written): "remember my cat is Miso" in a vault chat landed in `.writer/memory/` (`MEMORY.md` plus `user-cat-miso.md`) and a new session answered "Miso"; in a project chat a codename landed in `<project>/.memory/`, the vault memory was untouched, and a new project session answered both the codename and the cat. Deviations: the memory line omits "one short note each" (budget); the capability is named `memory-directory` like the other registry keys; commands are `agent_memory_*` like the other agent commands. Not verified: the Settings section in a real window, and how often a memory write raises a permission card in `manual` mode under `--permission-prompt-tool stdio` (the real check used plain `-p`).
