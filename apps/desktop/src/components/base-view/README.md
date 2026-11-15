# base-view

The tab body of the `base` page kind: an Obsidian Bases table over a `.base` file, with in-place property editing. Spec: [`SPECs/obsidian-bases-spec.md`](../../../../../SPECs/obsidian-bases-spec.md) (4.3, "Frontend status"). The engine is in Rust; this directory only renders results and writes note properties.

## Map

| File                                         | Role                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.tsx`                                  | `BaseView`: composes the hooks, toolbar, banners, table, notice bar                                                                                                   |
| `use-base-query.ts`                          | `base_read` + `base_query`; request counters (only the latest response lands); debounced requery on `index://changed`; inactive tabs refresh when shown               |
| `use-base-edits.ts`                          | the edit pipeline: one serialized write queue, optimistic cells, rollback, undo/redo stacks, paste/clear/copy, read-only reasons                                      |
| `base-table.tsx`                             | virtualized ARIA grid, selection, keyboard, clipboard events                                                                                                          |
| `cell-view.tsx`, `cell-editor.tsx`           | display renderers and per-kind editors                                                                                                                                |
| `base-toolbar.tsx`                           | view tabs, result count                                                                                                                                               |
| `open-note-sync.ts`                          | dirty check and reload of a note that is open in an editor tab                                                                                                        |
| `use-cell-actions.ts`, `use-pending-view.ts` | opening link/file cells in a new tab; taking `[[x.base#View]]` as the selected view                                                                                   |
| `../../lib/bases/`                           | `types.ts` (the one TS mirror of the Rust shapes), `ipc.ts` (typed `invoke` wrappers, mocked in tests), `cells.ts`, `grid.ts`, `events.ts`, `paths.ts` (pure helpers) |
| `../editor-area/page-kinds/base.ts`          | the page kind; `locationForPath` in `page-kinds/index.ts` routes every file open                                                                                      |

No Zustand store: the only shared state is the tab location (`{path, view?}`), kept in the editor store like every page kind. Everything else is component state.

## Behaviour rules

- A write goes through one path (`runWrite` in `use-base-edits.ts`): refuse if the note is open with unsaved changes, read the note's raw properties (`note_properties`), refuse on a frontmatter error, write or remove, reload a clean open editor, record the undo entry. Writes are serialized, so two edits never interleave.
- The cell shows the new value at once. A failed write removes it again and raises an error notice. After a successful write the table requeries and the optimistic cell is dropped once a query that started after the write has landed.
- Undo writes the previous raw value back (with its original value type, so a date stays an unquoted date) and is refused, with a notice, when the property no longer holds the value the edit wrote. Redo is the mirror image. A paste or multi-cell clear is one undo step.
- Empty text (or an empty list) clears the property. Invalid text keeps the editor open with an error; nothing is coerced.
- Read-only: formula columns, `file.*` columns, error cells, nested values, lists with non-text items, notes whose frontmatter does not parse (found with `note_properties` when a row's cell is selected or edited), notes open in an editor tab with unsaved changes (checked when selected and again when writing).
- Header cells are display-only: sort and group markers come from the view in the document. Changing sort needs the `.base` YAML writer (phase 4).

## Backend contract

The shapes in `lib/bases/types.ts` follow `src-tauri/src/commands/bases.rs` and `src/bases/query.rs` as read from the source; nothing has been run against them yet.

1. Commands: `base_list`, `base_read({path})`, `base_query({path, view?, thisPath?, nowOffsetMinutes?})`, `base_query_text`, `note_properties({path})`, `note_property_set({path, name, value, valueType?})`, `note_property_remove({path, name})`. Argument names are camelCase on the wire (`thisPath`, `nowOffsetMinutes`, `valueType`).
2. Paths: the frontend sends absolute workspace paths; the commands accept absolute or vault-relative (`vault_ops::confine`). Result row paths and `index://changed` paths are vault-relative. `.base` commands refuse non-`.base` paths and `note_*` commands refuse non-`.md` paths.
3. `base_read` resolves to `{text, document, error}`; `document` is `null` and `error` set when the text does not parse (the view shows the error and the raw text). `base_query` for an unparsable base resolves to a result with `error.kind = "document"`; the view shows that one banner. It also resolves (not rejects) for an unknown view (`viewNotFound`). It rejects (an error string) while the index is not ready or for IO errors; the view shows that in a banner.
4. `BaseQueryResult` carries `availableViews` (the view tabs). `rows[i].cells.length == columns.length` and `groups` ranges tile `rows` exactly; otherwise the table shows an error (a missing cell renders as an error cell, bad group ranges as an error message) instead of guessing.
5. `note_properties` resolves to `{properties, order, types, error}`; `error` is non-null when the frontmatter does not parse. Absent keys are absent, a `key:` without value is `null`, wikilinks are their raw `"[[...]]"` string, dates their `YYYY-MM-DD[THH:mm[:ss]]` string.
6. `note_property_set` accepts `valueType` in `text | number | checkbox | date | datetime | list` only (anything else is an error). The frontend therefore sends a link as a `"[[...]]"` string with `valueType: "text"` (`toWireType`). It must keep quoting `[[...]]` strings as valid YAML (the Rust `patch` does the quoting; the frontend relies on it).
7. `note_property_set` / `note_property_remove` return after the index row is refreshed (`index_paths_blocking`) and after marking the write as a self-write, so the requery that follows sees the new value and the watcher does not report an external change. If the watcher still reports one for an open clean editor, `reloadFromDisk` is idempotent.
8. `index://changed` is emitted per window with `{epoch, root, paths, full}`; the view ignores a batch whose `{root, epoch}` is not the current workspace.

## Tests

`tests/bases-lib.test.ts` (pure helpers), `tests/bases-page-kind.test.ts` (registry, routing, store, wiki links), `tests/base-view.test.tsx` (the component against a fake backend: states, windowing, keyboard, edit/rollback/clear/undo/paste, read-only reasons, live updates and stale responses). Nothing runs against the real backend.
