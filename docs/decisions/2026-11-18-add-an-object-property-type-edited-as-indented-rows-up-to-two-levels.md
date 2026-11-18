---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Add an object property type edited as indented rows, up to two levels

## Context and Problem Statement

A property whose value is a YAML map (a skill's `metadata:`, `author: {name, url}`) is read-only today: the properties panel lists its keys and says "Edit nested properties in Source" (`src/lib/frontmatter-properties.ts` row kind `map`, `src/components/editor-area/property-value.tsx`), conversion refuses nested maps (`src/lib/property-conversion.ts`), and the property type system (`property_types.rs`, `SPECs/properties-types-spec.md`) has no type for it. The Bases engine already has object values (`bases/value.rs` `Value::Object`). The user asked (2026-11-18) for an `object` property type with up to two nesting levels, with the skill `metadata` in their vault as the example.

## Decision Drivers

- The frontmatter stays byte-identical outside the key being edited (ADRs `2026-11-15-patch-frontmatter-lines-not-the-whole-block`, `2026-11-16-show-note-properties-in-a-collapsible-panel-edited-by-byte-minimal-text-splices`).
- One type source of truth (`property_types.rs`, ADR `2026-11-17-record-property-types-in-writers-own-file-and-read-obsidians-types-json-read-only`); never write `.obsidian`.
- The panel and the Rust patcher are two splice implementations: nested edits must behave the same in both (DRY through shared vectors).
- Terse UI; no per-key type picker.

## Considered Options

- A. Type `object`; the panel edits it as indented key/value rows (two levels); leaf values inferred; deeper parts read-only; Bases and the CLI address nested keys by dotted path.
- B. An inline YAML text box validated on blur.
- C. A type per nested key (`metadata.version: number`) in `.writer/property-types.json`.

## Decision Outcome

Chosen option: **A** (the user chose each part).

1. **Type**: `object` joins `PropertyType` (Rust and TS, label "Object", a hugeicons braces/object icon). Stored as `"object"` in `.writer/property-types.json` only; Obsidian has no such type, so `obsidian_name` reports `text` and an `.obsidian/types.json` `object` entry (none exists today) would be ignored like `relationships`. Inferred when a property's indexed values are maps (`fits` accepts the map vtype). The type menu offers it.
2. **Levels**: level 1 is the property's map; a level-1 value may itself be a map (level 2). A level-2 value that is a map, or any flow map, multi-line string or placeholder, is shown read-only (its YAML source, "Edit in Source") and never rewritten.
3. **Leaf values**: inferred like an untyped property, no picker: text, number, checkbox, date/datetime, or a list of text (edited as the List editor). Writing keeps YAML scalars as the existing writers do (quoting rules unchanged).
4. **Panel**: the property row shows a disclosure; each key is an indented key/value row editable in place (rename key, edit value, × removes the key, "+ Add key" at the end of each map, level 2 maps get their own "+ Add key"). Keyboard and focus follow the top-level rows. Empty map is `{}` until a key is added.
5. **Writes**: one splice per nested key in each writer: the TS panel splicer (`frontmatter-properties.ts` family) and the Rust patcher (`index/patch.rs` via `vault_ops.rs`). Both are pinned by one shared vectors file `apps/desktop/shared/nested-property-vectors.json` (input frontmatter, path, op, expected output), read by a Rust test and a TS test, like `shared/chord-vectors.json`.
6. **Dotted paths**: a nested key is addressed `metadata.version` (level 2: `metadata.flags.beta`). Bases: `note.metadata.version` in columns, filters, sort and group (the engine's member access on `Value::Object`; verify and fill gaps). CLI: `writer property:read/set/remove name=metadata.version`; a top-level key containing a dot is matched first (exact name wins), so existing dotted names keep working.
7. **Index**: maps are already indexed as values; nested keys are not separate properties in the Properties list and not in `prop_items`.

### Consequences

- Good: skill `metadata` and similar maps become editable without leaving the panel, byte-minimal.
- Good: Bases and the CLI reach nested values with one path grammar.
- Bad: two splicers learn nested keys; the shared vectors are the guard.
- Neutral: nested keys have no types of their own and are not listed as vault properties.

### Non-goals

- More than two editable levels; lists of objects (a list item that is a map stays read-only).
- Per-nested-key types; nested keys in the Properties list, tag pane or `prop_items`.
- Writing `.obsidian/types.json`.

## Implementation Plan

- **Affected paths**: `src-tauri/src/property_types.rs` (variant, `parse`, `wire_name`, `obsidian_name`, `fits`), `src-tauri/src/index/patch.rs` + `vault_ops.rs` (nested set/remove/rename-key), `src-tauri/src/cli/` (`property:*` dotted paths; spec `SPECs/writer-cli-spec.md`), `src-tauri/src/bases/` (member access tests on `note.<obj>.<key>`), TS `src/lib/property-types.ts`, `src/lib/frontmatter-properties.ts` (map rows become editable `object` rows), `src/lib/property-conversion.ts` (convert to/from object: a map stays, a scalar cannot convert, "edit it in Source"), `src/components/editor-area/property-value.tsx` and `properties-panel.tsx` (indented rows), `apps/desktop/shared/nested-property-vectors.json`, `SPECs/properties-types-spec.md` (Types table + an "Object" section), `CHANGELOG.md`; the managed `writer-cli` skill if it documents `property:set` (bump `BUNDLE_VERSION`).
- **Patterns to follow**: byte-minimal splices; the one write path per side; shared vectors for Rust/TS twins; existing row components for leaf editors; `docs/design.md`.
- **Patterns to avoid**: re-stringifying the frontmatter or a whole map; a third writer; a per-key type store.
- **Tests**: shared vectors (set, add key, remove key, rename key, level 2, comments and order kept, read-only deeper parts untouched) in Rust and TS; type inference and `obsidian_name`; panel rows (edit, add, remove, rename, Escape, read-only level 3, flow map read-only); CLI dotted set/read/remove and exact-dotted-name precedence; Bases column, filter and sort on `note.metadata.version`.

### Verification

- [ ] A skill's `metadata` map shows as an Object property with editable indented rows.
- [x] Editing one nested key changes only that line in the file. (`shared/nested-property-vectors.json` in both suites, panel test `edits one nested value and changes only that line`)
- [x] A level-2 map is editable; a level-3 map shows read-only and is never rewritten. (panel tests `edits a level-2 map...`, `a map at level 3 is read-only...`, the vectors)
- [x] `writer property:set name=metadata.version value=2` changes that key only. (`property_set_read_remove_reach_nested_keys_by_dotted_path`)
- [x] A Bases column `note.metadata.version` shows the value and sorts. (engine test `nested_keys_of_an_object_property_work_in_columns_filters_sort_and_group`)
- [x] `.obsidian/types.json` is never written; plugins see the property as `text`. (`object_is_inferred_from_maps_and_reads_as_text_for_plugins`, the host shim test)

## Pros and Cons of the Options

### A. Indented rows

- Good, because it is edited like every other property.
- Bad, because both splicers need nested support.

### B. Inline YAML box

- Good, because simple.
- Bad, because the user edits YAML by hand and a blur re-stringify risks the byte-minimal rule.

### C. Typed per key

- Good, because exact types.
- Bad, because much more UI and a new store shape; not requested.

## More Information

Related: [properties types spec](../../SPECs/properties-types-spec.md), [writer CLI spec](../../SPECs/writer-cli-spec.md), the Bases engine README (`apps/desktop/src-tauri/src/bases/README.md`). Revisit if lists of objects or deeper editing are requested.
