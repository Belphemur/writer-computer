---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Make tasks a native built-in feature, with task rows in Bases

## Context and Problem Statement

The Tasks plugin (MIT, 4.6M downloads) is among the most used in Obsidian. Writer's index stores tasks as `(file_id, line, status, text)` only (`index/schema.rs`, parser `index/markdown.rs`): no dates, priority, recurrence, nesting or list items. Writer's Bases engine (`src-tauri/src/bases/`, Rust) has filters, sorts, groups, formulas and views, one row per file. Research of the plugin's source (2026-11-18: `src/TaskSerializer/*`, `src/Task/Recurrence.ts`, `src/Task/Urgency.ts`, `src/Statuses/*`) pinned the line grammar (end-anchored signifiers, statuses, recurrence, urgency). The user asked (2026-11-18) for native Tasks as its own plugin, as much as possible in Rust, and chose: write tasks in the vault's format; editor actions, a Tasks page, agent and CLI access, and "direct integration with bases for the way to embed it, we should be able to make base based on task"; Obsidian compatibility does not matter for task bases. Dataview is a separate plugin with its own ADR (`2026-11-18-run-dataview-queries-natively-on-the-bases-engine`); both share the core index and the Bases executor described here.

## Decision Drivers

- One index and one query executor (Bases) for files and tasks; no second list UI.
- As much as possible in Rust, shared with the `writer` CLI.
- Vaults keep their task syntax byte for byte; edits are byte-minimal.
- No JavaScript from notes is ever run.

## Considered Options

- A. Extend the core Rust index with list items and task fields; tasks become Bases rows; a `tasks` built-in feature for the UI.
- B. Port the Tasks plugin's own query engine and UI.
- C. Keep the Obsidian plugin through the plugin host.

## Decision Outcome

Chosen option: **A**.

1. **Core index** (Rust, `index/`, shared with the Dataview feature, owned by core so either feature works alone):
   - `list_items(file_id, line, parent_line, indent, marker, task_status, text, section_heading)`: every list item with its parent, so nesting is known.
   - `tasks` extended: `status_symbol`, `status_type` (`TODO | DONE | IN_PROGRESS | ON_HOLD | CANCELLED | NON_TASK`), `description`, `due`, `scheduled`, `start`, `created`, `done`, `cancelled` (dates `YYYY-MM-DD`, local, nullable), `priority` (`highest..lowest`, null = none), `recurrence` (text), `on_completion`, `task_id`, `depends_on`, `tags`, `block_id`, `parent_line`.
   - One Tauri-free grammar module `src-tauri/src/tasks/` (Tasks emoji signifiers, end-anchored and order-independent with the 20-pass cap; the Dataview-format task fields `[due:: …]` through the core inline-field scanner of the Dataview ADR; statuses; recurrence) used by the index and the writers. Shared vectors `apps/desktop/shared/task-vectors.json` (line → parsed fields → re-serialised) pin it and the TS editor helpers.
2. **Format**: read both formats always. Write in the vault's format: the Tasks plugin's `taskFormat` in `.obsidian/plugins/obsidian-tasks-plugin/data.json` if present (read-only), else the emoji format; setting `tasks.format` (`vault` default, `emoji`, `dataview`) overrides. Custom statuses come from the same Tasks settings (read-only) plus Writer's `.writer/task-statuses.json`.
3. **Writes** (Rust, byte-minimal through `vault_ops`): toggle (next status; writes the done date when `tasks.set-done-date`, default on; on a recurring task writes the next occurrence above or below per `tasks.recurrence-position`, dates shifted by the rule, `when done` from today), set a field (due, scheduled, start, priority, recurrence), add a task. Recurrence rules in Rust (Tasks' natural-language grammar mapped to our own rule type).
4. **Bases over tasks** (core Bases engine): a base may set `rows: tasks` (a Writer extension key in `.base`; default `files`; Obsidian compatibility not required, by the user's choice). Rows are tasks with properties `task.description`, `task.status`, `task.done`, `task.due`, `task.scheduled`, `task.start`, `task.created`, `task.priority`, `task.recurrence`, `task.urgency` (Tasks' weighted score), `task.tags`, `task.line`, plus the file's (`file.*`, `note.*`), so filters, sorts, groups, formulas and every view type work, and `![[Tasks.base]]` embeds it. Checkboxes in task rows toggle the source through the Rust write path. The Dataview feature's `TASK` queries run on the same rows.
5. **Tasks feature** (`apps/desktop/features/tasks/`, kill switch `features.tasks.enabled`, default on):
   - Editor: clicking a checkbox uses the Rust toggle; custom statuses cycle; autocomplete after a signifier or `due::` (dates, `today`, `tomorrow`, weekdays, priorities, recurrence phrases); a small edit popover (due, scheduled, start, priority, recurrence) from the task's context menu.
   - Tasks page (a page kind): Today, Upcoming, Overdue, No date, and By folder, each a built-in base definition over `rows: tasks` rendered by the Bases view; quick add writes to the note named by the setting `tasks.inbox` (default `Tasks.md` at the vault root, created on first use; Writer has no daily notes yet, and a later daily-notes feature may offer "Today's daily note" as a choice).
   - Agents and CLI: `writer tasks` (a base-style filter grammar over task rows), `task:add`, `task:done`, `task:edit` (Rust), documented in the `writer-cli` skill.
   - Existing ` ```tasks ` query blocks are not executed in v1; they show a small "Tasks query" card with "Convert to Base" (the user, 2026-11-18): the query (filters, sort, group, limit, layout) is lowered to a `rows: tasks` base, written as a `.base` and, on confirm, the block is replaced with `![[…base]]`; an instruction that does not map (e.g. `filter by function`) is named and the block is left as is.
   - Plugin coexistence: if the Obsidian Tasks plugin is enabled in the plugin host, a one-time prompt offers to disable it in Writer (never touching `.obsidian`).

### Consequences

- Good: tasks get dates, priorities, recurrence and nesting in one Rust index, viewed and embedded through Bases; agents reach them through the CLI.
- Good: existing Tasks syntax keeps working.
- Neutral: `rows: tasks` bases are Writer-only, by the user's choice.
- Bad: the Bases executor grows a second row kind.

### Non-goals

- Executing ` ```tasks ` blocks in place in v1 (they convert to a base instead); Tasks' `filter/sort/group by function` or any JS.
- A task list UI outside Bases views.

## Implementation Plan

- **Affected paths**: `src-tauri/src/index/` (schema migration for `list_items` and extended `tasks`; `markdown.rs` scanning; incremental updates), new `src-tauri/src/tasks/` (grammar, statuses, recurrence, urgency, serialiser, writes, the `tasks` block query parser and its lowering to a base), `src-tauri/src/bases/` (`rows: tasks` source and task properties), `vault_ops.rs` (task writes), `cli/` (`tasks`, `task:*`); `apps/desktop/features/tasks/` (editor extensions, edit popover, Tasks page, Rust glue); `apps/desktop/features/bases/web` (task row cells with checkboxes); `apps/desktop/shared/task-vectors.json`; specs: new `SPECs/tasks-spec.md`, updates to `SPECs/obsidian-bases-spec.md` and `SPECs/writer-cli-spec.md`; the `writer-cli` and `writer-bases` skills (bump `BUNDLE_VERSION`); `THIRD_PARTY_NOTICES` for adapted MIT code; `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: Tauri-free Rust cores with thin glue; shared vectors; one write path; Bases as the only executor and view layer; the read-only Obsidian settings layer (property types); `docs/design.md`.
- **Patterns to avoid**: a second query engine or list UI; JS evaluation; rewriting whole lines or files.
- **Tests**: grammar vectors (every signifier, both formats, any order, trailing tags and block ids, variation selectors, `⌛`/`📆` read and normalised on write); statuses and custom cycles; recurrence (every n days/weeks/months, weekdays, `when done`, month ends, DST); toggle writes and next occurrence placement; list-item nesting; index incremental updates; `rows: tasks` bases (filters, sorts, groups, urgency, embeds, checkbox toggles the source); CLI commands; Tasks page sections; Convert to Base for ` ```tasks ` blocks (mapped instructions, an unmapped one named, block replaced on confirm); feature off.

### Verification

- [ ] A vault's Tasks-format tasks show their due dates and priorities in a `rows: tasks` base; checking one writes the done date and the next recurrence.
- [ ] `![[Tasks.base]]` embeds a task base in a note.
- [ ] The Tasks page shows Today, Upcoming, Overdue, No date and By folder; quick add appends to `Tasks.md` (created if missing).
- [ ] `writer task:add` / `task:done` change one line only.
- [ ] "Convert to Base" turns a ` ```tasks ` block into a working task base.

## Pros and Cons of the Options

### A. Core index, Bases rows

- Good, because DRY, Rust, Bases views and embeds for free.
- Bad, because the executor grows a row kind.

### B. Port the plugin's engine

- Good, because exact plugin semantics.
- Bad, because a second query engine and UI.

### C. Plugin host

- Good, because no work.
- Bad, because no CLI or agent access, no Rust.

## More Information

Supersedes, with the Dataview ADR, `2026-11-18-make-tasks-native-and-run-dataview-queries-on-the-bases-engine` (split into two plugins at the user's request). Related: the Bases ADRs, the property types ADR (read-only Obsidian settings layer), the Excalidraw ADR (plugin takeover prompt).
