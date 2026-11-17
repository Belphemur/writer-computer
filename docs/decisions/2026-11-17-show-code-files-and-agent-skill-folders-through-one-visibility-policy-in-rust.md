---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Show code files and agent skill folders through one visibility policy in Rust

## Context and Problem Statement

Writer became a notebook for agents. An agent skill is a folder with a `SKILL.md` and scripts (py, sh, js, ts) in `.agents/skills/<name>/` and `.claude/skills/<name>/`, and vaults hold code next to notes. Until now the sidebar, quick open, the vault index and the watcher showed only `.md` and `.base`, and hid every dot-folder, so skills and their scripts could not be seen or edited in the app. Four surfaces (tree listing, index walker, watcher filter, name search) each had their own copy of "hidden means a leading dot", so widening any of them one by one would drift.

## Decision Drivers

- One place decides what the vault shows; no per-surface copies.
- Secrets (`.env`, keys) and the app's own folders (`.obsidian`, `.git`, `.chats`, `.writer`) must stay hidden.
- No new dependency; the code editor must reuse the language data the markdown editor already loads for fenced code.
- The `writer` CLI shares the index and must not need the app's settings to behave.

## Considered Options

- A Tauri-free `code_files` module holding the policy (extensions, ignored folders, agent-skills exception), used by the listing, walker, watcher and name cache; settings pushed into it by the app.
- Per-surface edits (a second extension list in the index, in the watcher, in `fs.rs`).
- Index everything and filter only in the UI.

## Decision Outcome

Chosen option: the `code_files` module, because it is the only choice with one source of truth that the CLI also links against (defaults when no app is running). The policy is process-wide and set from `files.code-extensions`, `files.ignored-folders` and `files.show-agent-folders` whenever settings load or change. Hidden segments stay hidden except the `skills` subtree of a top-level `.agents` or `.claude`; ignored folder names (`node_modules`, `target`, `dist`, `build`, `__pycache__`, `.venv`, ...) are hidden at any depth; secret-looking names are never listed or opened as text; symlinks are never followed. Code files are listed and indexed as rows (name, size, mtime) but their text is not full-text indexed.

### Consequences

- Good, because one function (`rel_is_visible`) answers for the tree, the index walker and the watcher, and a test per rule pins it.
- Good, because no dependency was added: highlighting uses `@codemirror/language-data` already in the lockfile.
- Bad, because the policy is process-wide: two windows share one setting (the settings are global-scope anyway).
- Bad, because a folder named like an ignored one (`build`, `out`, `vendor`) hides its notes too until the user edits `files.ignored-folders`.
- Bad, because the index only picks up a changed ignore list or agent-folder switch at the next workspace open.
- Neutral, because file contents of code files are not searched; the agent has `rg`.

## Implementation Plan

- **Affected paths**: `src-tauri/src/code_files.rs`, `commands/fs.rs`, `index/{paths,build,names}.rs`, `watcher.rs`, `relocate/mod.rs`, `commands/settings.rs`, `shared/settings.schema.json`, `src/lib/code-files.ts`, `src/components/code-editor/`.
- **Dependencies**: none.
- **Patterns to avoid**: a second hidden-file rule in a surface; reading a code file without `read_text_guarded`.

### Verification

- [x] `cargo test code_files` covers listing, visibility, symlinks, binary guard, mode on save, index and relocate.
- [x] `vp test tests/code-files.test.ts` covers routing, language resolution, highlighting and the editor setup.

## More Information

Spec: [`SPECs/code-files-spec.md`](../../SPECs/code-files-spec.md).
