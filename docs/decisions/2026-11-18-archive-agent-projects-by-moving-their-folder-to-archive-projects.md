---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Archive agent projects by moving their folder to Archive/Projects

## Context and Problem Statement

An agent project is a vault folder with `project.md` (Copilot's format) and `AGENTS.md` ([projects ADR](2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md)). The project home already has "Archive": it sets Copilot's `copilot-project-archived-at` key and hides the project from the pickers, but the folder stays where it was, so finished projects still sit among active work in the vault and there is no way to bring an archived project back from the UI. The user asked (2026-11-18) for archived projects to be moved to an archive folder, hidden from the agent UI, and restorable.

## Decision Drivers

- One rule for "archived", shared by the app, the CLI and Copilot.
- One move path for archive and unarchive (DRY), callable from the app and the `writer` CLI.
- Never lose a turn: no move while a chat of the project is running a turn or waiting on a permission.
- Links keep working: links resolve by file name ([link ADR](2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md)), so a folder move does not break `[[Note]]`.
- Archived notes stay ordinary vault notes (search, links, Obsidian).
- Never write `.obsidian`, never read `~/.claude`.

## Considered Options

- A. Keep the `copilot-project-archived-at` flag as the archived rule and also move the folder to a configurable archive folder (default `Archive/Projects`); unarchive moves it back.
- B. Flag only, folder left in place (today).
- C. Move to `.writer/archive/` (hidden app data).
- D. Move to an `Archive/` subfolder next to the project.
- E. Location as the archived rule (any project under the archive folder is archived), no flag.

## Decision Outcome

Chosen option: **A**.

1. **Archived rule**: `copilot-project-archived-at` is the only test (already read by `project::list` and Copilot). The agent UI filters on it everywhere a project is offered: the switcher and project list, `@` mentions, the new-chat project choice and the `agent.project-badge` file-tree decoration. A project moved into the archive folder by hand but not flagged stays active.
2. **Archive folder**: setting `agent.projects-archive-folder` in the agent settings fragment, a vault-relative folder, default `Archive/Projects`, created on first use, confined to the vault (`vault_ops::confine`), never a dot folder.
3. **Archive** (`project::archive(root, rel, true, now)`, the one function): sets `copilot-project-archived-at` and `writer-project-archived-from: <vault-relative folder before the move>` through the one project write path (`project::update` / byte-minimal frontmatter patcher), then renames the whole folder (notes, `AGENTS.md`, `.chats/`, `.memory/`) into the archive folder in one `rename`. A name already taken gets " 2", " 3", and so on. If the rename fails the frontmatter is restored. A project already inside the archive folder is only flagged.
4. **Unarchive** (`project::archive(root, rel, false, now)`): moves the folder back to `writer-project-archived-from` (missing or invalid key: the vault root for a project inside the archive folder; a project only flagged elsewhere, for example by Copilot, just loses the flag and stays put; a taken name gets a suffix; a missing parent is created), then removes both keys. Chats resume because their cwd is the original folder again.
5. **Busy guard**: the Tauri command refuses (`Busy`, with the chat count) while any chat whose cwd is inside the project runs a turn or has a pending permission; idle sessions of the project are stopped first, and their open tabs show the chat as closed. The CLI has no sessions to check.
6. **Surfaces**: the project home "Archive" button (existing confirm dialog, now saying where the folder goes), a collapsed "Archived" section in the project browser listing archived projects with "Unarchive", palette commands "Archive project" and "Unarchive project...", and `writer project:archive path=<folder>` / `writer project:unarchive path=<folder>` through the same function.
7. Folder-qualified links (`[[Projects/X/Note]]`, Markdown relative paths) are not rewritten, the same as any folder move today.

### Consequences

- Good: finished projects leave the active part of the vault and the agent UI, and come back with one click to the same place.
- Good: Copilot sees the same archived state (its own key).
- Bad: path-qualified links into a moved project break until a folder-aware `relocate` exists.
- Neutral: archived notes are still found by search, Quick Open and the graph.

### Non-goals

- Hiding the archive folder in the file tree, search or Quick Open.
- Automatic archiving.
- Rewriting folder-qualified links.
- Archiving the vault-root chats (they are not a project).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/agent/project.rs` (`archive` gains the move, restore target, suffixing and rollback; `KEY_ARCHIVED_FROM`), the agent feature's Rust commands (`features/agent/rust/`, the busy guard over `AgentSessions`, bindings regenerated with `WRITER_UPDATE_BINDINGS=1 cargo test bindings`), `features/agent/settings.schema.json` (`agent.projects-archive-folder`), `src-tauri/src/cli/` (`project:archive`, `project:unarchive`, the generated CLI skill reference and `BUNDLE_VERSION` bump if the skill text changes), `features/agent/web/` (project home confirm text, Archived section with Unarchive in the project browser, palette commands, projects store refresh, badge filter), `SPECs/native-agent-spec.md` section 4.6, `SPECs/writer-cli-spec.md`, `CHANGELOG.md`.
- **Patterns to follow**: the one project write path (`project::update`); `vault_ops::confine` for both folders; `commands::blocking` for the command; adapters and stores as they are; link activation for the Archived rows.
- **Patterns to avoid**: a second move or frontmatter writer; a location-based archived test; any code under the home folder; moving while a turn runs.
- **Tests**: Rust: archive moves and flags, name clash suffix, rollback when the rename fails, unarchive to the recorded folder, to the root when the key is missing, with a suffix when the original is taken, already-inside-archive only flags, setting outside the vault or a dot folder rejected; the command refuses while a fake-`claude` chat of the project is busy; CLI round trip. TS: archived projects absent from the switcher, mentions and badge, present in the Archived section, Unarchive calls the command and refreshes.

### Verification

- [x] Archiving moves the folder under `Archive/Projects/`, sets both keys and removes the project from the switcher, mentions and tree badge.
- [x] Unarchive returns it to its previous folder and the old chats open and resume.
- [x] A name clash on either side gets a numeric suffix; nothing is overwritten.
- [x] Archive is refused while a chat of the project runs a turn or waits on a permission.
- [x] `writer project:archive` and the app produce the same result.

## Pros and Cons of the Options

### A. Flag plus move

- Good, because one rule shared with Copilot and the folder really leaves the active area.
- Bad, because the move needs a busy guard and a restore target.

### B. Flag only

- Good, because nothing moves.
- Bad, because finished projects stay in the active folders; the user asked for a move.

### C. `.writer/archive/`

- Good, because fully out of sight.
- Bad, because dot folders are not indexed: search and links break, Obsidian does not see the notes.

### D. `Archive/` next to the project

- Good, because archives stay near their siblings.
- Bad, because archives scatter across the vault.

### E. Location as the rule

- Good, because no flag to keep in sync.
- Bad, because Copilot would still list the project, and a restore target would still need a key.

## More Information

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) section 4.6. Related: [projects as folders](2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md), [chats in a hidden folder under the project](2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md), [links resolve by file name](2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md). Revisit when `relocate` handles folders (then rewrite path-qualified links on archive).

Addendum 2026-11-18 (surfaces, after user feedback): the agent pane splits a **Projects list** (header folder button, "Show all projects" in the title dropdown, palette "Agent: Projects": filter, New project, active rows, collapsed "Archived (n)") from the **project detail** (one project only; the icon is the "Change icon" button; no actions menu). "Archive project…" lives in the row "…" menus of the list and the title dropdown and in the palette, and opens a confirmation modal (core `src/components/confirm-dialog.tsx`) that archives in place without navigating; "Unarchive" is on archived rows of the list. This replaces the project home "Archive" button and "Archived" section of point 6.
