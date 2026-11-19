# Tasks spec

Status: implemented (see "Unverified in a real window"). ADR: [`2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases`](../docs/decisions/2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases.md).

Native tasks as the built-in feature `tasks` (`apps/desktop/features/tasks/`, kill switch `features.tasks.enabled`, default on). Everything that is logic is Rust and Tauri-free (`src-tauri/src/tasks/`); the feature folder is glue and UI.

## 1. Grammar (`tasks/grammar.rs`)

- A task is a list item with a checkbox. The status symbol is any single character. A trailing block id `^id` is set aside first.
- Signifiers are stripped from the end of the text, in any order, at most 20 passes, in the Tasks plugin's order: priority, done, cancelled, due, scheduled, start, created, recurrence, on completion, tags, id, depends on. What is left is the description (trailing tags stay in it).
- Emoji format: priority 🔺 ⏫ 🔼 🔽 ⏬ (highest to lowest); 🛫 start; ➕ created; ⏳ (also ⌛) scheduled; 📅 (also 📆 🗓) due; ✅ done; ❌ cancelled; 🔁 recurrence; 🏁 on completion; ⛔ depends on; 🆔 id. A variation selector after an emoji is accepted.
- Dataview format: `[key:: value]` or `(key:: value)`, a trailing comma allowed, read through the core inline-field scanner (`index/inline_fields.rs`, the one reader of that syntax).
- Both formats are always read. Writes use the vault's format (section 3).
- Pinned by `shared/task-vectors.json` (parse, write and toggle vectors read by the Rust tests).

## 2. Index (core, `index/`)

- `list_items(file_id, line, parent_line, indent, marker, task_status, text, section_heading)`: every list item, with its parent from an open-items stack.
- `tasks` carries `status_symbol, text, description, due, scheduled, start, created, done, cancelled, priority, recurrence, on_completion, task_id, depends_on, tags, block_id, parent_line` (dates `YYYY-MM-DD`, nullable) and an index on `due`. The status type is not stored: it depends on the vault's custom statuses, so it is computed at query time.
- Schema and parser versions bump; the index is a cache and rebuilds.

## 3. Writes (`tasks/edit.rs`, `ops.rs`)

Byte-minimal: only the task's lines change, line endings and the rest of the file stay; an existing token has only its value replaced; a new token goes before the block id (Dataview tokens with two leading spaces).

- Toggle: next status of the cycle. Unknown symbols are TODO with next `x`. Done stamps `✅` when `tasks.set-done-date` is on (cancelled shares the flag); leaving done removes it. A recurring task writes its next occurrence above (or below, `tasks.recurrence-position`); due, scheduled and start keep their distance to the reference date, `when done` counts from today. `on completion: delete` removes the line. The restart status is the first TODO status of the chain, else IN_PROGRESS, else a space.
- Set or clear one field (due, scheduled, start, priority, recurrence), add a task. Values are validated (real dates, the five priorities, a recurrence phrase the rules read).
- Every file command takes the description the caller listed (`expect`): a moved line is refused ("changed since it was listed"), never guessed. The editor commands (`task_line_*`) transform the editor's own line text so unsaved content is never overwritten.
- Recurrence (`recurrence.rs`): every [N|other] day, week, month, year; weekday; weekday lists; `on the 15th`, `last day`, `2nd Tuesday`; `when done`. No new crate.
- Format and statuses (`settings.rs`): Writer's settings (`tasks.format` vault|emoji|dataview) and `.writer/task-statuses.json` first, then the Tasks plugin's `.obsidian/plugins/obsidian-tasks-plugin/data.json` (read-only, `.obsidian` is never written), then the defaults.

## 4. Task rows in Bases

- A base sets `rows: tasks` (Writer extension, default `files`). Rows are tasks with `task.description`, `text`, `status` (type: `TODO|DONE|IN_PROGRESS|ON_HOLD|CANCELLED|NON_TASK`), `symbol`, `checked` (closed), `due`, `scheduled`, `start`, `created`, `done`, `cancelled`, `priority`, `recurrence`, `on_completion`, `id`, `depends_on`, `tags`, `block`, `urgency` (the plugin's weighted score), `line`, `parent`, `indent`, `heading`, plus the file's `file.*` and `note.*`.
- In a file base `task.x` stays an ordinary note property; the `task` namespace exists only on task rows (a row carries its `line`).
- SQL pushdown only narrows; `run_view` verifies every row (a differential test pins pushdown against a full scan). Today comes from the clock.
- Web: the `task.checked` cell is the one editable cell of a task row, written by the tasks feature through the service `tasks.rows` (status cycle, done date, next occurrence), then the table requeries. Other `task.*` cells are read-only. Read-only with a reason while the feature is off or the note has unsaved editor changes. Embedded bases keep this one write.

## 5. CLI (`cli/cmd_tasks.rs`, feature-gated commands in `features/tasks/rust/cli.rs`)

- `writer tasks filter=<expr> [sort=<property>] [desc] [limit=<n>]`: a Bases expression over task rows; the older selectors still apply.
- `task:add text=… [due= scheduled= start= priority= recurrence= path=]`, `task:done ref=path:line`, `task:edit ref=path:line [due= … clear=a,b]`. Settings come from the global `config` file.

## 6. The Tasks page

Page kind `tasks` (core, `feature: "tasks"`; off, the tab shows the "turned off" page). Sections Today, Upcoming, Overdue, No date, By folder: each a static `rows: tasks` base (`tasks/page.rs`) drawn by the Bases view through the `bases.views` service (`loadTextEmbed`). Quick add (page button, command "Add task") appends to `tasks.inbox` (default `Tasks.md`, created with its folders on first use).

## 7. Editor

- Click on a checkbox goes through Rust (`task_line_toggle`); the answer is applied only if the line is still what it was.
- Commands: Open tasks, Add task, Toggle task, Edit task (dialog: due, scheduled, start, priority, repeats), Convert tasks block to base.
- Completions: after a date signifier (📅 ⏳ 🛫 ➕ ✅ ❌ ...) or a Dataview date key (`due::`...) the editor offers today, tomorrow, next week, next month and the next of each weekday as `YYYY-MM-DD`; after a priority key the five priorities; after 🔁 or `repeat::` recurrence phrases. They join the editor's one autocompletion (`lib/editor-completion-sources.ts`).
- Custom statuses: a list item whose box holds a character core does not draw (`- [/]`) shows that character as a small box (`status-marks.ts`); a click cycles the status through Rust like a checkbox. `[ ]`, `[x]` and `[X]` stay core's checkbox.
- ` ```tasks ` blocks are not executed. A closed block shows a small "Tasks query" card (`query-decorations.ts`, a block widget over `lib/react-block-widget.ts`) with "Convert to Base" and "Edit"; "Convert to Base" is also in the block's context menu and the command lowers the query to a `rows: tasks` base (`tasks/block.rs`), writes `<note> tasks.base` next to the note under a free name and replaces the block with `![[…]]`. Mapped: status, dates (absolute and `today`, `in 3 days`), priority, recurrence, text fields, tags, `exclude sub-items`, parenthesised and/or/not/xor (left to right), sort, one `group by`, limit, columns. An instruction that does not map (`filter by function`, `happens`, date ranges, blocked/blocking, presets, a second `group by`, `show tree`) is named by line and the block is left as is.
- Obsidian Tasks plugin: on the first toggle through Writer while the plugin runs, one prompt offers to turn it off in Writer (`lib/plugin-takeover.ts`; never `.obsidian`).

## 8. Settings

`tasks.format`, `tasks.set-done-date`, `tasks.recurrence-position`, `tasks.inbox` (feature fragment); `features.tasks.enabled`.

## Not in v1

`show tree`; blocked/blocking queries; undo of a base checkbox toggle (toggle again).

## Unverified in a real window

The editor checkbox click and the dialogs, the Tasks page layout and its embedded sections, the block conversion flow, the takeover prompt.
