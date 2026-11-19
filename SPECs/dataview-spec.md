# Dataview (DQL) spec

Status: implemented in code, tested in Rust and jsdom, not seen in a real window. Decision: [`docs/decisions/2026-11-18-run-dataview-queries-natively-on-the-bases-engine.md`](../docs/decisions/2026-11-18-run-dataview-queries-natively-on-the-bases-engine.md). Sibling: the Tasks ADR (`2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases`).

Clean-room note: the grammar, the inline-field scanner and the field names come from the public Dataview documentation and its MIT-licensed source (see `THIRD_PARTY_NOTICES.md`); no Obsidian code is read.

## Shape

````
```dataview block --> dql::parse --> Lowered { Document, kind, unmapped } --> bases::run_view (dialect: dql)
````

- `src-tauri/src/dql/`: `parser.rs` (positions in every error), `lower.rs` (DQL to a Bases `Document`), `tasks.rs` (`TASK_FIELDS`, the `task.*` names), tests over `shared/dql-vectors.json` (fixture vault, clock 2024-03-15T10:30:00, 30 queries, 8 error vectors).
- `Lowered::live_text()` is the document with `dialect: dql`, what a block runs. `Lowered::base_text()` is the plain `.base` (no `dialect`), `Err` when a clause has no Bases form.
- `index::inline_fields` (core, shared with Tasks): the `inline_fields` table and the public scanner `scan_line`; vectors in `shared/inline-field-vectors.json`. Raw text is stored and parsed on read. Inline fields are visible only under the DQL dialect, so Bases results never change.

## Supported

- `TABLE [WITHOUT ID]`, `LIST [WITHOUT ID]`, `TASK`, `CALENDAR`; `FROM` with `#tag`, `"folder"`, `"file.md"`, `[[link]]`, `outgoing([[link]])`, `and`/`or`/`-`/parentheses; `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, `//` comments. Keywords are case-insensitive.
- Pipeline: `FROM` and the `WHERE`s before a `FLATTEN` become document filters; a `WHERE` after a `FLATTEN` joins that step; a later `SORT` outranks earlier ones; a `LIMIT` before another clause is an error. Non-TASK queries add `file.ext == "md"`. A row whose filter errors is dropped.
- Dataview semantics under the dialect: one precedence level for `and`/`or`/`&`/`|`, `-` inside names, DQL truthiness (empty list, object, string are false), swizzled `rows.field`, canonical field keys (`Estimated Hours` is `estimated-hours`), `GROUP BY` ascending by key, `FLATTEN` of a non-list keeps one row.
- Implicit `file.*`: name, folder, path, ext, link, size, ctime, mtime, cday, mday, tags (with `#` and parents), etags, inlinks, outlinks, aliases, frontmatter, day, tasks, lists, starred. Functions: the shared Bases ones rewritten to method form plus the dialect table in `bases/dialect.rs` (`icontains`, `regexmatch`, `dateformat`, `padleft`, ...).
- `CALENDAR` renders as the Bases `calendar` view (month grid, Monday first; `dateProperty` in the view); rows without a date are counted, not drawn.
- Executor extension keys (kept in `View.extra`, ignored by Obsidian): `flatten`, `dqlGroup`, `dateProperty`, `separator`; document keys `dialect: dql`, `rows: tasks`.

## Not covered

- `dataviewjs`, inline JS, inline `=` queries, `csv()` sources: a block shows "dataviewjs is not supported" with the code collapsed; nothing is evaluated.
- Nested lambdas, object literals, `date(eom)` style keywords: reported as unmapped (the live query may still run).
- Not in the live engine but recorded as unmapped for Convert: dialect functions, `file.tags`/`etags`/`day`/`tasks`/`lists`/`starred`, `FLATTEN`, non-TASK `GROUP BY`, `WHERE`/`SORT` after a group.
- Convert cannot know that a bare name is an inline field, so a plain base may show an empty column for it.

## TASK queries (contract with the Tasks feature)

A TASK query lowers to `rows: tasks` with the `task.*` names of `dql/tasks.rs` (`task.status` is the status type, `task.done` the done date; no GROUP BY groups by the file link). Lowering is unit-tested here; execution needs the Tasks feature's rows and `task` namespace, so `a_task_query_returns_the_task_rows_the_fixture_expects` is `#[ignore = "needs tasks-feature rows"]` until that lands.

## Feature

`apps/desktop/features/dataview/` (kill switch `features.dataview.enabled`, default on). Rust: commands `dql_lower` (pure) and `dql_convert` (writes `Dataview query.base` beside the note, numbered when taken), CLI `writer dql query="..." [file=|path=] [format=]`. Web: one editor extension `dataview.blocks` replaces a closed ` ```dataview ` fence with a widget while the caret is away (range-select to edit, docs/editor.md); the widget lowers in Rust (debounced), then renders the Bases `EmbeddedBase` through the `bases.views` service (`loadEmbeddedBase`), or says "Bases is turned off". Errors show line, column and the line with a caret. "Convert to Base" is disabled with the unmapped clauses as its tooltip; on success it offers Replace block (`![[... .base]]`) or Keep.

Coexistence: the first time a block shows while the Obsidian Dataview plugin (`dataview`) is running in the plugin host, a one-time prompt offers to turn it off in Writer's own plugin state (`.obsidian` is never written); the answer is remembered (`writer.dataview.takeoverAsked`). The prompt is the shared `src/lib/plugin-takeover.ts` (Excalidraw's takeover is the same pattern). The widget is the shared `src/lib/react-block-widget.ts`, as the Bases embed.

Off: blocks are plain code fences and `writer dql` reports the feature is off.

## Tests

Rust: inline-field vectors, DQL parser and lowering, vectors run through the real index and executor, dialect never changes Bases results, convertible queries give the same rows as their plain base, feature manifest and ACL, `dql_lower`. jsdom: feature registration and kill switch, block widget (placeholder never calls the backend, error position, embed, convert flow), calendar grid.
