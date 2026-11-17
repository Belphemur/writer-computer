# Agent memory (cross-chat memory for the native agent)

Status: investigation and proposal. No code changed. Owners of related text: [native-agent-spec.md](native-agent-spec.md) (4.5 instruction layers, 4.5.1 Writer system block, 9 chats), [agent-roles-spec.md](agent-roles-spec.md), ADRs on [projects](../docs/decisions/2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md), [chats](../docs/decisions/2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md), [agent roles](../docs/decisions/2026-11-17-define-agent-roles-once-and-map-them-to-each-agent-backend-through-adapters.md).

## 1. Question

Does Writer's agent "properly do memories", i.e. remember facts across chats in a vault or project the way Claude Code does, and what should Writer add?

## 2. How Claude Code remembers (public docs, claude 2.1.326)

Source: <https://code.claude.com/docs/en/memory> (also <https://code.claude.com/docs/en/settings>, <https://code.claude.com/docs/en/sub-agents>).

- **Instruction files** (written by the user): `CLAUDE.md` (and `.claude/CLAUDE.md`, `CLAUDE.local.md`) in the cwd and every parent, `~/.claude/CLAUDE.md`, managed policy. `AGENTS.md` is read when no `CLAUDE.md`/`CLAUDE.local.md` exists on the path (setting "Project instructions", default `claude-md-or-agents-md`, since v2.1.277). Subdirectory files load on demand.
- **Auto memory** (written by Claude): on by default in local sessions. Directory `~/.claude/projects/<project>/memory/`, with a `MEMORY.md` index (first 200 lines or 25 KB loaded every session) and one topic file per memory (frontmatter `type`: user, feedback, project, reference; Claude Code adds `modified`). Topic files are read on demand. `<project>` is derived from the git repository root (all subdirectories and worktrees share one), else from the cwd. Machine-local, never synced.
- **Controls**: `autoMemoryEnabled` (user or project settings), env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `autoMemoryDirectory` (absolute or `~/` path, honored from any settings scope including `--settings`), `/memory` (browse, edit, toggle; interactive only), `--bare` turns auto memory off.
- **Sub-agents** do not receive the main conversation's auto memory unless they are forks; a sub-agent can have its own via its `memory` field.

## 3. What we verified with the real CLI

All runs in fresh dirs under `/private/tmp/claude-502/-Users-antoinea-repos-writer-computer/memtest*`, haiku, 2 to 6 turns. `~/.claude` was never read; the default location was learned by asking the model for the path in its own instructions.

| #   | Check                                                                                           | Result                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `CLAUDE.md` in cwd with `--setting-sources user,project,local`                                  | Loaded (answered the codename).                                                                                                                                                              |
| 2   | Auto-memory path with Writer's flags (`--setting-sources user,project,local`), cwd a plain dir  | Present: `~/.claude/projects/-private-tmp-...-memtest2/memory/`. Same with `--setting-sources ""`: so the flag does not gate auto memory.                                                    |
| 3   | "Remember my cat is Miso" with `--settings '{"autoMemoryDirectory":"<dir>"}'`                   | Wrote `MEMORY.md` plus `user-cat-miso.md` there; a NEW session (no `--resume`) answered "Miso". Cross-session memory works, in a Writer-chosen directory, with no file written in the vault. |
| 4   | Same in `--permission-mode default` (no `acceptEdits`)                                          | The memory write needed no prompt (it is auto-allowed, even for a dir outside cwd).                                                                                                          |
| 5   | Directory inside the vault `.writer/memory/` with a system prompt saying "Never touch .writer/" | The agent still wrote there (the instruction is not a guard for the CLI's own memory tool).                                                                                                  |
| 6   | git repo root vs `Projects/P` subfolder as cwd                                                  | Same memory dir (keyed by the git root). Outside git it is keyed by cwd.                                                                                                                     |

Also seen in the repo: `system/init` carries `memory_paths` (native-agent-spec appendix A); Writer ignores it.

## 4. How Writer maps onto it today

- **Flags** (`claude_stream.rs::build_args`): `--setting-sources user,project,local`, `--append-system-prompt`, `--permission-prompt-tool stdio`, `--session-id`/`--resume`. None disables `CLAUDE.md`, `AGENTS.md` or auto memory. `--bare` is never used. `env.rs` keeps `HOME`, drops only secret-looking names and `WRITER_*`; `CLAUDE_CODE_*` passes through, so a user-set `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is honored.
- **Title call** (`build_title_args`) uses `--setting-sources ""` and `--tools ""`: it does not write memory.
- **cwd** is the project folder, else the vault root (`session.rs`, spec 4.5). Instruction files from vault root down to the project load natively (ADR on projects, `project_context.rs` injects a shadowed `AGENTS.md`).
- **Chat restore** resumes the CLI session (`--resume`) or replays a capped seed (spec section 9). That is conversation continuity, not memory.
- **Sub-agents**: `writer-explorer` and `writer-worker` run inside the chat process (`subagents.rs`); per the docs they get no auto memory.

Verdict: the mechanisms work, unmanaged and invisible. Auto memory is on today, so a user who says "remember X" gets a file written under `~/.claude/projects/...`.

## 5. Gaps found

1. **Fragmented scope.** A vault that is not a git repo (the common case) gets one memory directory per cwd: vault root, and every project folder separately. A fact told in a project chat is unknown in a plain chat and vice versa. A vault inside a git repo is shared, so behavior differs by an accident of the filesystem.
2. **Memory leaves the vault.** It lives in the user's home, keyed by absolute path: moving or renaming the vault or project folder loses it, and a vault synced to another machine does not carry it. This sits badly with Writer's local-first, plain-files-in-the-vault promise.
3. **Invisible.** No sidebar entry, no Settings section, no `/memory` (interactive only). The user cannot see, edit or delete what the agent "knows". Writer's context ledger labels CLI loads "not itemised".
4. **Writer's prompt is silent.** The system block (writer_prompt.rs, budget 2000 chars) says nothing about memory, and tells the agent "Never touch .writer/", which conflicts with any in-vault memory location. Check 5 shows the CLI does not obey it for memory, so behavior would be inconsistent with the stated rule.
5. **No settings.** No `agent.*` key for memory on/off or location. The only off-switch is an env var outside Writer.
6. **Changes card interaction.** An in-vault memory write is a `Write` tool call and would appear in the end-of-turn Changes card (changes.rs) and Undo; an out-of-vault one does not.
7. **Backend lock-in.** Memory is a Claude Code feature. The agent-roles ADR targets OpenCode next; nothing neutral exists for it to read.
8. **Sub-agents** never see memory (docs); the explorer can miss vault facts that the main agent knows. Acceptable by design (the main agent passes what is needed), but should be stated.

## 6. Options

- **A. Do nothing, document.** Cheap; leaves gaps 1, 2, 3, 5.
- **B. Keep Claude's mechanism, move the directory into the vault.** Pass `--settings '{"autoMemoryDirectory":"<vault>/.writer/memory"}'` (verified, check 3; no settings file written, so no `.claude/settings*.json` edit and nothing under `.obsidian/`). One vault-wide directory fixes gap 1; plain Markdown in the vault fixes 2; a viewer fixes 3. Cost: the memory format stays Claude's (frontmatter plus `MEMORY.md`); reliance on a documented but newer setting (version check, fallback to default). Project-level memory is the open design point (7.2).
- **C. Writer-owned memory, backend-neutral.** Writer defines the files (`.writer/memory/MEMORY.md` plus topic notes), tells any backend via the system block to read/write them, and keeps `autoMemoryEnabled` off for Claude. Neutral, fully ours; but we re-implement what Claude does well (when to save, dedupe, index size limits), and the model follows prose less reliably than its built-in tool.
- **D. Hybrid (recommended path): B now, shaped so C is a drop-in.** Use B's directory and Claude's native memory tool today; keep the layout and the system-block wording backend-neutral so another adapter only has to map "memory directory" to its own config (as roles do).

## 7. Recommendation

Adopt D in phases, behind one new setting, defaulting to the current behavior until the user opts in (so we never silently move or orphan existing memories).

7.1 **Location.** `<vault>/.writer/memory/` (hidden: `.writer/` is already Writer's own folder, excluded from the sidebar and index, never synced into Obsidian's `.obsidian/`; it travels with the vault). Hidden-from-sidebar but reachable through the viewer in 7.4. Reject `.obsidian/` (clean-room rule: never write there) and a visible `Memory/` folder (pollutes the user's notes; revisit if users want it searchable).

7.2 **Scope.** Vault-wide by default (one directory, fixes gap 1). Project-level facts: a project's `AGENTS.md` is already its durable, human-written memory, and the agent may be told to append stable project decisions there only on request (no silent edits to user files). Optional later: a `memory/` folder beside `project.md` and `autoMemoryDirectory` per project spawn (the spawn already knows the project). Decision for the user: Q2.

7.3 **Spawn and prompt.** When the setting is on: add `--settings` JSON with `autoMemoryDirectory` (built by one pure function in `claude_stream.rs`, validated like other values, absolute path inside the confined vault, never from model input). Extend the Writer block by replacing text, not growing past 2000 chars: one neutral line, e.g. "Durable memory for this vault is the Markdown folder `.writer/memory/`: read `MEMORY.md` first; save only stable facts or preferences the user asks you to remember or corrects you on, one short note each, never note contents or secrets." Reword FORBIDDEN to "Never touch .obsidian/, .git/, other .writer/ files or secret files". Golden tests for both block variants change in the same commit.

7.4 **UI.** Settings > Agent section "Memory": toggle, location (read-only path, "Open folder"), list of memory files with open, delete and "Forget all"; later a sidebar panel through the contribution points in `src/lib/features/`. Memory files open as normal notes in the editor (they are Markdown), so no new editor is required. Surface the `memory_paths` from `system/init` to show which files the CLI loaded.

7.5 **Changes card.** Exclude the memory directory from the Changes card and Undo (a memory save is not a note edit), via the existing path-confinement in `changes.rs`; shown instead as a small "Saved to memory" line in the transcript (the CLI already prints "Saved N memories").

7.6 **Sub-agents.** No memory for explorer/worker by default (matches the CLI). The orchestration line stays; the main agent passes relevant facts in the delegation prompt. Revisit once roles gain a `memory` capability in `shared/agent-roles.json`.

7.7 **Privacy.** Memory stays on disk in the vault; never logged (logger rules); the redaction of secrets stays at the model's discretion plus the prompt rule, so state clearly in Settings that memory is plain text readable by anyone with the vault. Existing home-directory memories are neither read nor migrated by Writer (we never read `~/.claude`); offer a note explaining where they are and how to copy them.

7.8 **Backend-neutral.** Add `memory_directory` as a neutral capability next to the role capabilities; the Claude adapter maps it to `autoMemoryDirectory`; an OpenCode adapter maps it to its own config or to the prompt line alone.

## 8. Phased plan with tests

| Phase | Work                                                                                                                                                                                                                                                                                                                     | Tests                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Docs only: native-agent-spec 4.5 "Memory" paragraph stating today's behavior and where it lives; CHANGELOG not needed.                                                                                                                                                                                                   | Existing spec tests.                                                                                                                                                                                   |
| 1     | `agent.memory` setting (`off`/`default`/`vault`, default `default`) in `features/agent/settings.schema.json`, Settings section, Rust count tests in `config.rs`. Spawn plumbing: pure `memory_settings_json(root, mode)` in `claude_stream.rs`; `off` sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` via `env.rs` (one place). | Unit: argv contains `--settings` only in `vault` mode and the path is inside the vault; unsafe path rejected; `off` env present; `default` argv unchanged (golden argv test). Fake-claude runner test. |
| 2     | Writer block memory line and reworded FORBIDDEN, conditional on the mode.                                                                                                                                                                                                                                                | Golden text for the variants, `stays_within_the_budget`, neutral-template test.                                                                                                                        |
| 3     | Changes-card exclusion for `.writer/memory/`.                                                                                                                                                                                                                                                                            | `changes_tests.rs`: a Write there yields no card entry; a note Write still does.                                                                                                                       |
| 4     | Settings > Agent "Memory" list/open/delete/forget-all through thin `commands/` handlers (async, `blocking`), allowlist tests, vault-confined paths.                                                                                                                                                                      | Rust handler tests on a fixture vault; React tests for the section.                                                                                                                                    |
| 5     | Per-project memory and the neutral `memory_directory` capability for the OpenCode adapter.                                                                                                                                                                                                                               | Adapter table tests.                                                                                                                                                                                   |

Manual checks only a real window and the real CLI can give: that haiku and sonnet actually save to the vault directory unprompted, how often memory writes show a permission card in `manual` mode under `--permission-prompt-tool stdio` (check 4 used plain `-p`, not stdio), and the viewer UX.

## 9. Open questions for the user

1. Should vault-wide memory in `.writer/memory/` become the default for new vaults (phase 1 ships opt-in), or stay opt-in permanently?
2. Project scope: one shared vault memory, or one memory per project, or only `AGENTS.md` as project memory?
3. Hidden `.writer/memory/` (recommended) or a visible, searchable folder in the vault?
4. Should memory be shown in the Changes card for transparency instead of excluded (7.5)?
5. Do we want a Writer-owned format (option C) rather than Claude's file layout, accepting the loss of its built-in save logic?
6. Should we try to import existing home-directory memories (needs reading `~/.claude`, which Writer's rules currently forbid)?

## Decisions (user, 2026-11-17)

1. Default: `agent.memory = vault` for every vault (memory in the vault by default; `default` = Claude's home location and `off` remain options).
2. Scope: both. One vault-wide memory, plus one per project (a project chat sees the vault memory and its project's memory; a vault chat sees the vault memory only).
3. Location: hidden (`.writer/memory/` for the vault, a hidden folder in the project for project memory), shown and editable through a "Memory" section in Settings > Agent.
4. Memory writes are not shown on the Changes card.
5. Format: Claude Code's memory format for now; other backends convert in their adapter. kremory is not adopted (see the evaluation summary in the chat of 2026-11-17: young, heavy, needs its own LLM and embedder); its ideas (bi-temporal facts, reversible consolidation) may be built later on the vault index.
6. Import: Writer offers a one-time, user-initiated import of the existing Claude Code memory for this vault (and its projects) from the user's home Claude folder into the vault memory. Writer reads only the matching project memory directories, never anything else under the Claude folder, and only when the user clicks Import.

ADR: [Keep agent memory in the vault through the backend's own memory tool](../docs/decisions/2026-11-17-keep-agent-memory-in-the-vault-through-the-backends-own-memory-tool.md).
