---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Run Dataview queries natively on the Bases engine

## Context and Problem Statement

Dataview (MIT, 5.4M downloads) lets notes hold ` ```dataview ` queries in its own language (DQL) and adds inline fields (`key:: value`, `[key:: value]`, `(key:: value)`). Many vaults depend on it. Writer's Bases engine (`src-tauri/src/bases/`, Rust) already has values, about 100 functions, filter, sort, group, limit and SQL pushdown, about 60% of what DQL needs; the gaps are list and task rows, `FLATTEN`, Dataview's grouped `rows` result, the output shapes and inline fields. Research of the plugin's source (2026-11-18: `src/query/parse.ts`, `src/expression/*`, `src/data-import/inline-field.ts`, `src/data-model/*`) pinned the grammar, the inline-field scanner and the list-item model. The user asked (2026-11-18) for Dataview's query language natively as its own plugin, as much as possible in Rust, and chose DQL blocks and "Convert to Base", with `dataviewjs` shown as a placeholder, never run. Tasks is a separate plugin with its own ADR (`2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases`); both share the core index and the Bases executor.

## Decision Drivers

- One executor (Bases) for files, tasks and DQL; DQL lowers to it rather than a second engine.
- As much as possible in Rust.
- Existing DQL blocks keep their text; results match Dataview on a fixture vault.
- No JavaScript from notes is ever run.

## Considered Options

- A. A Rust DQL parser lowering to the Bases executor, with the core index extended by inline fields; a `dataview` built-in feature for blocks and conversion.
- B. Port Dataview's own engine.
- C. Keep the Obsidian plugin through the plugin host.

## Decision Outcome

Chosen option: **A**.

1. **Core index: inline fields** (Rust, `index/`, owned by core and shared with the Tasks feature, whose Dataview task format reads them): `inline_fields(file_id, line, key, canonical_key, raw, wrapping)` for Dataview's three forms (the scanner of `inline-field.ts`: wrappers, nesting, `\` escapes, overlapping fields dropped, keys canonicalised as Dataview does). Values parse as numbers, dates, durations, links, lists or booleans, else text. Not shown in the properties panel in v1. Pinned by `apps/desktop/shared/inline-field-vectors.json`.
2. **DQL** (Rust, `src-tauri/src/dql/`): a lexer and parser for `TABLE [WITHOUT ID]`, `LIST [WITHOUT ID]`, `TASK`, `CALENDAR` with `FROM` (`#tag`, `"folder"`, `"file.md"`, `[[link]]` incoming, `outgoing([[link]])`, `and`, `or`, negation, parentheses), `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, comments; lowered to the Bases executor:
   - `TABLE` and `LIST` over file rows, with implicit `file.*` fields (from the index: name, folder, path, ext, link, size, times, tags, inlinks, outlinks, aliases, tasks, lists, frontmatter, day).
   - `TASK` over the core task rows (the Tasks ADR's `rows: tasks`), with list-item nesting.
   - `FLATTEN` as a new executor step (one row per list element); `GROUP BY` producing Dataview's `key`/`rows` result as a grouped view.
   - DQL-only functions and semantics (loose `=`, `dur()` and calendar-aware date arithmetic, luxon-style `dateformat`, swizzling `rows.field`, Dataview's null ordering) in `bases/functions.rs` behind a DQL dialect flag, never changing Bases results.
3. **Dataview feature** (`apps/desktop/features/dataview/`, kill switch `features.dataview.enabled`, default on):
   - ` ```dataview ` blocks render live through the Bases web views (table, list, task list, calendar month grid); errors show the DQL line and column.
   - "Convert to Base" on a block writes an equivalent `.base` where every clause maps (and, on confirm, replaces the block with `![[…base]]`); otherwise it names the clause that does not map.
   - ` ```dataviewjs ` and inline JS show "dataviewjs is not supported" with the code collapsed; never executed. Inline `=` queries are not rendered in v1.
   - Plugin coexistence: if the Obsidian Dataview plugin is enabled in the plugin host, a one-time prompt offers to disable it in Writer (never touching `.obsidian`).
   - Agents and CLI: `writer dql query="…"` runs a query headless and prints the rows (the same Rust engine), documented in the `writer-cli` skill.

### Consequences

- Good: existing DQL blocks work with no plugin; queries run in Rust and are reachable by agents.
- Good: JavaScript from notes never runs.
- Bad: DQL semantics differ from Bases in corners, carried by a dialect flag that must stay contained.

### Non-goals

- Running `dataviewjs` or any JS; inline `=` queries; inline fields in the properties panel.
- Dataview's `csv()` source; `CALENDAR` beyond a month grid.
- Writing notes (Dataview's task-completion write is the Tasks feature's job).

## Implementation Plan

- **Affected paths**: `src-tauri/src/index/` (`inline_fields` table and scanner, incremental updates), new `src-tauri/src/dql/` (lexer, parser, lowering, errors with positions), `src-tauri/src/bases/` (`FLATTEN`, grouped rows, DQL dialect functions, implicit `file.*` fields), `cli/` (`dql`); `apps/desktop/features/dataview/` (block renderer, Convert to Base, placeholder, Rust glue); `apps/desktop/features/bases/web` (calendar month view if absent); shared vectors `inline-field-vectors.json` and `dql-vectors.json` (query → lowered base → rows on a fixture vault); specs: new `SPECs/dataview-spec.md`, updates to `SPECs/obsidian-bases-spec.md` and `SPECs/writer-cli-spec.md`; the `writer-cli` skill (bump `BUNDLE_VERSION`); `THIRD_PARTY_NOTICES` for adapted MIT code; `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: lowering to the one executor; shared vectors; Tauri-free Rust with thin glue; `docs/design.md`.
- **Patterns to avoid**: a second query engine; JS evaluation; a dialect leaking into Bases results.
- **Tests**: inline fields (three forms, nesting, escapes, canonical keys, overlap dropped, value parsing); DQL vectors (each clause and source, `WITHOUT ID`, FLATTEN, GROUP BY rows, TASK with nesting, CALENDAR, comments, errors with positions); dialect functions never change Bases results; Convert to Base (mapped and unmapped clauses, block replacement on confirm); dataviewjs never executed; CLI `dql`; feature off.

### Verification

- [ ] A ` ```dataview ` TABLE, LIST and TASK block render the rows the fixture expects.
- [ ] "Convert to Base" turns a DQL block into a working base.
- [ ] `dataviewjs` never runs.
- [ ] `writer dql` prints the same rows as the block.

## Pros and Cons of the Options

### A. Lower to the Bases executor

- Good, because one engine, Rust, Bases views for free.
- Bad, because a dialect flag in the function library.

### B. Port Dataview's engine

- Good, because exact semantics.
- Bad, because a second engine to maintain.

### C. Plugin host

- Good, because no work.
- Bad, because JS from notes runs, no CLI or agent access.

## More Information

Supersedes, with the Tasks ADR, `2026-11-18-make-tasks-native-and-run-dataview-queries-on-the-bases-engine` (split into two plugins at the user's request). Related: the Bases ADRs, the Tasks ADR (task rows and list items).
