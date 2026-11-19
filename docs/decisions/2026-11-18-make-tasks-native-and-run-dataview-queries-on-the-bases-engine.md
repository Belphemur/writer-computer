---
status: superseded
date: 2026-11-18
decision-makers: Writer maintainers
---

# Make tasks native and run Dataview queries on the Bases engine

> **Superseded (2026-11-18)** by [Make tasks a native built-in feature, with task rows in Bases](2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases.md) and [Run Dataview queries natively on the Bases engine](2026-11-18-run-dataview-queries-natively-on-the-bases-engine.md): the user asked for two plugins with two ADRs.

## Context and Problem Statement

Tasks (MIT, 4.6M downloads) and Dataview (MIT, 5.4M) are among the most used Obsidian plugins. Writer's index stores tasks as `(file_id, line, status, text)` only (`index/schema.rs`, parser `index/markdown.rs`): no dates, priority, recurrence, nesting, list items or inline fields. Writer's Bases engine (`src-tauri/src/bases/`, Rust) has values, about 100 functions, filter, sort, group, limit and SQL pushdown, but one row per file. Research of both plugins' source (2026-11-18) pinned the Tasks line grammar (end-anchored signifiers, statuses, recurrence, urgency), the Dataview inline fields (`key:: value`, `[k:: v]`, `(k:: v)`, canonicalised keys), its list-item model and its DQL grammar. The user asked (2026-11-18) for native Tasks and Dataview's query language, as much as possible in Rust, and chose: write tasks in the vault's format; v1 Tasks with editor actions, a Tasks page, agent and CLI access, and "direct integration with bases for the way to embed it, we should be able to make base based on task"; Dataview DQL blocks and "Convert to Base"; `dataviewjs` shown as a placeholder, never run.

## Decision Drivers

- One index, one query executor (Bases) for files, tasks and DQL; DRY across Bases, Tasks and Dataview.
- As much as possible in Rust, shared with the `writer` CLI.
- Vaults keep their syntax byte for byte; edits are byte-minimal.
- No JavaScript from notes is ever run.

## Considered Options

- A. Extend the Rust index with list items, tasks fields and inline fields; tasks become Bases rows; DQL compiles to the Bases executor; Tasks UI as a built-in feature.
- B. Port each plugin's own engine separately (a Tasks query engine and a Dataview engine).
- C. Rely on the Obsidian plugins through the plugin host.

## Decision Outcome

Chosen option: **A**.

1. **Index** (Rust, `index/`):
   - `list_items(file_id, line, parent_line, indent, marker, task_status, text, section_heading)`: every list item with its parent, so nesting is known.
   - `tasks` extended: `status_symbol`, `status_type` (`TODO | DONE | IN_PROGRESS | ON_HOLD | CANCELLED | NON_TASK`), `description`, `due`, `scheduled`, `start`, `created`, `done`, `cancelled` (dates `YYYY-MM-DD`, local, nullable), `priority` (`highest..lowest`, null = none), `recurrence` (text), `on_completion`, `task_id`, `depends_on`, `tags`, `block_id`, `parent_line`.
   - `inline_fields(file_id, line, key, canonical_key, raw, wrapping)`: Dataview's three forms, indexed for every note (used by DQL, Bases and Tasks' Dataview format), not shown in the properties panel in v1.
   - One Tauri-free parser module `src-tauri/src/tasks/` (line grammar: Tasks emoji signifiers, end-anchored and order-independent with the 20-pass cap, the Dataview-format fields, statuses, recurrence) used by the index and the writers. Shared vectors `apps/desktop/shared/task-vectors.json` (lines → parsed fields → re-serialised) pin it and the TS editor helpers.
2. **Format**: read both formats always. Write in the vault's format: the Tasks plugin's `taskFormat` in `.obsidian/plugins/obsidian-tasks-plugin/data.json` if present (read-only), else the emoji format; setting `tasks.format` (`vault` default, `emoji`, `dataview`) overrides. Custom statuses come from the same Tasks settings (read-only) plus Writer's `.writer/task-statuses.json`.
3. **Writes** (Rust, byte-minimal through `vault_ops`): toggle (next status; writes the done date when `tasks.set-done-date`, default on; on a recurring task writes the next occurrence above or below per `tasks.recurrence-position`, dates shifted by the rule, `when done` from today), set a field (due, scheduled, start, priority, recurrence), add a task. Recurrence rules in Rust (Tasks' natural-language grammar mapped to our own rule type; no JS rrule).
4. **Bases over tasks**: a base may set `rows: tasks` (a Writer extension key in `.base`; default `files`). Rows are then tasks with properties `task.description`, `task.status`, `task.done`, `task.due`, `task.scheduled`, `task.start`, `task.created`, `task.priority`, `task.recurrence`, `task.urgency` (Tasks' weighted score), `task.tags`, `task.line`, plus the file's (`file.*`, `note.*`), so filters, sorts, groups, formulas and every view type work, and `![[Tasks.base]]` embeds it. Checkboxes in task rows toggle the source through the Rust write path. Obsidian does not know `rows: tasks`; the user decided (2026-11-18) Obsidian compatibility does not matter for task bases (file bases are unaffected).
5. **Tasks feature** (`apps/desktop/features/tasks/`, kill switch `features.tasks.enabled`, default on):
   - Editor: clicking a checkbox uses the Rust toggle; custom statuses cycle; autocomplete after a signifier or `due::` (dates, `today`, `tomorrow`, weekdays, priorities, recurrence phrases); a small edit popover (due, scheduled, start, priority, recurrence) from the task's context menu.
   - Tasks page (a page kind): Today, Upcoming, Overdue, No date, and By folder, each a built-in base definition over `rows: tasks` rendered by the Bases view (no second list UI); quick add writes to the daily note or a chosen note (setting `tasks.inbox`).
   - Agents and CLI: `writer tasks` (a base-style filter grammar over task rows), `task:add`, `task:done`, `task:edit` (Rust), documented in the `writer-cli` skill.
   - Existing ```` ```tasks ```` query blocks are left as plain code blocks in v1 (not executed, no conversion; "Convert to Base" is Dataview's only).
6. **Dataview** (`apps/desktop/features/dataview/`, kill switch `features.dataview.enabled`, default on):
   - A Rust DQL parser (`src-tauri/src/dql/`) lowering `TABLE`, `LIST`, `TASK` and `CALENDAR` with `FROM` (tags, folders, files, `[[links]]`, `outgoing()`, `and`, `or`, negation), `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT` to the Bases executor: `TABLE` and `LIST` over file rows, `TASK` over task rows, `FLATTEN` as a new executor step (one row per list element), Dataview's group result (`key`, `rows`) as a grouped view. DQL-only functions and semantics (loose `=`, `dur()`, luxon-style `dateformat`, swizzling) are added to `bases/functions.rs` behind a DQL dialect flag, never changing Bases results.
   - ```` ```dataview ```` blocks render live through the Bases web views (table, list, task list, calendar); errors show the DQL position.
   - "Convert to Base" on a block writes an equivalent `.base` (and replaces the block with `![[...base]]` on confirm) where the query maps; otherwise it says which clause does not.
   - ```` ```dataviewjs ```` and inline JS show "dataviewjs is not supported" with the code collapsed; never executed. Inline `=` queries are not rendered in v1.
7. **Plugin coexistence**: when Writer's Tasks or Dataview feature is on and the same Obsidian plugin is enabled in the plugin host, a one-time prompt offers to disable the plugin in Writer (never touching `.obsidian`), as for Excalidraw.

### Consequences

- Good: one index and one executor serve files, tasks and DQL; agents get tasks through the CLI.
- Good: existing Tasks and Dataview syntax keeps working; JavaScript from notes never runs.
- Neutral: `rows: tasks` bases are Writer-only, by the user's choice.
- Bad: DQL semantics differ from Bases in corners (loose equality, durations), carried by a dialect flag that must stay contained.

### Non-goals

- Running `dataviewjs`, Tasks `filter/sort/group by function`, or any JS.
- Rendering or converting ```` ```tasks ```` blocks in v1; inline `=` queries; inline fields in the properties panel.
- Dataview's `csv()` source and `CALENDAR` beyond a month grid.

## Implementation Plan

- **Affected paths**: `src-tauri/src/index/` (schema migration for `list_items`, extended `tasks`, `inline_fields`; `markdown.rs` scanning; incremental updates), new `src-tauri/src/tasks/` (grammar, statuses, recurrence, urgency, serialiser, writes), new `src-tauri/src/dql/` (lexer, parser, lowering), `src-tauri/src/bases/` (`rows: tasks` source, `FLATTEN`, grouped rows, DQL dialect functions), `vault_ops.rs` (task writes), `cli/` (`tasks`, `task:*`); `apps/desktop/features/tasks/` and `apps/desktop/features/dataview/` (web: editor extensions, Tasks page, DQL block renderer, converters; Rust glue); `apps/desktop/features/bases/web` (task row cells with checkboxes; a calendar view if absent); shared vectors `task-vectors.json`, `inline-field-vectors.json`, `dql-vectors.json` (query → lowered base → rows on a fixture vault); specs: new `SPECs/tasks-spec.md`, `SPECs/dataview-spec.md`, updates to `SPECs/obsidian-bases-spec.md`, `SPECs/note-graph-spec.md` if links change, `SPECs/writer-cli-spec.md`; the `writer-cli` and `writer-bases` skills (bump `BUNDLE_VERSION`); `THIRD_PARTY_NOTICES` for adapted MIT code (Tasks, Dataview); `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: Tauri-free Rust cores with thin glue; shared vectors for Rust/TS twins; one write path; Bases as the only executor and view layer; `docs/design.md`; the read-only Obsidian settings layer (property types).
- **Patterns to avoid**: a second query engine or list UI; JS evaluation; rewriting whole lines or files.
- **Tests**: task grammar vectors (every signifier, both formats, any order, trailing tags and block ids, variation selectors, `⌛`/`📆` read and normalised on write); statuses and custom cycles; recurrence (every n days/weeks/months, weekdays, `when done`, month ends, DST); toggle writes and next occurrence placement; inline fields (three forms, nesting, escapes, canonical keys, overlap dropped); index incremental updates; `rows: tasks` bases (filters, sorts, groups, urgency, embeds, checkbox toggles the source); DQL vectors (each clause and source; FLATTEN; GROUP BY rows; TASK; CALENDAR; errors with positions; dialect functions never change Bases results); Convert to Base for DQL blocks (mapped and unmapped clauses); dataviewjs never executed; CLI commands; Tasks page sections.

### Verification

- [ ] A vault's Tasks-format tasks show their due dates and priorities in a `rows: tasks` base; checking one writes the done date and the next recurrence.
- [ ] `![[Tasks.base]]` embeds a task base in a note.
- [ ] A ```` ```dataview ```` TABLE, LIST and TASK block render the same rows as the fixture expects.
- [ ] "Convert to Base" turns a DQL block into a working base.
- [ ] `dataviewjs` never runs.
- [ ] `writer task:add` / `task:done` change one line only.

## Pros and Cons of the Options

### A. One index, Bases executor

- Good, because DRY, Rust, and Bases views for free.
- Bad, because the executor grows (task rows, FLATTEN, a dialect).

### B. Separate engines

- Good, because exact plugin semantics.
- Bad, because three query engines and three UIs to keep in sync.

### C. Plugin host

- Good, because no work.
- Bad, because no CLI or agent access, no Rust, JS from notes runs.

## More Information

Research: the four-plugin source review of 2026-11-18 (both MIT; Tasks `src/TaskSerializer/*`, `src/Task/Recurrence.ts`, `src/Task/Urgency.ts`; Dataview `src/query/parse.ts`, `src/expression/*`, `src/data-import/inline-field.ts`). Related: the Bases ADRs, the Excalidraw ADR (plugin takeover prompt), the property types ADR (read-only Obsidian settings layer).
