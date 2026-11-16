# Properties panel (collapsible)

Status: implemented in code and unit-tested (jsdom); not run in a real window. Decision: [`docs/decisions/2026-11-16-show-note-properties-in-a-collapsible-panel-edited-by-byte-minimal-text-splices.md`](../docs/decisions/2026-11-16-show-note-properties-in-a-collapsible-panel-edited-by-byte-minimal-text-splices.md).

## Problem

The frontmatter of a note is shown above the editor as an always-open list of text inputs. In a real vault a large share of notes has 7 or more properties, so the body starts below the fold, and every edit re-stringified the whole block (comments, quoting, list style and `{{placeholders}}` lost). The panel must (1) collapse to one cheap row, (2) stay bounded when open, (3) show properties with type-appropriate controls, (4) never reformat or corrupt user text.

## Where things live (as built)

The frontmatter is not part of the CodeMirror document. `OpenFile.frontmatter` (store) holds the YAML text between the `---` lines; `OpenFile.content` the body; `serializeDocument` joins them on save (`lib/frontmatter.ts`, `lib/save.ts`). The panel is a React component rendered by `editor-pane.tsx` above `ProseMarkEditor`. So the CodeMirror block-widget patterns in `docs/editor.md` (decoration shape, range-select, `posAtDOM`, `scrollSnapshot`) do not apply, and an edit is a store update (`updateFrontmatter`), not an editor transaction: CodeMirror undo/redo does not cover it.

| Piece                                                               | Role                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `lib/frontmatter-properties.ts`                                     | parse to typed rows, refusals, verified byte-minimal edits, collapse heuristic, new-type table |
| `components/editor-area/properties-panel.tsx`                       | header toggle, bounded body, rows, add row, source view                                        |
| `components/editor-area/property-value.tsx`                         | value and key controls per row kind                                                            |
| `components/editor-area/property-links.ts`                          | open a `[[wikilink]]` or URL value                                                             |
| `components/editor-area/use-vault-property-keys.ts`                 | vault property names from `index_properties` (30 s cache)                                      |
| `stores/properties-panel-store.ts`, `hooks/use-properties-panel.ts` | per-note collapsed/source state for the session; setting read                                  |
| `shared/settings.schema.json`                                       | `editor.properties-default-collapsed`                                                          |

`lib/yaml-entries.ts` is no longer used by the app (only a legacy-globals test imports it).

## Behaviour

### Collapsed / expanded

- Header: one button with a chevron, `Properties (N)` and `aria-expanded`/`aria-controls`; a click, Enter or Space toggles. One click either way.
- Collapsed: that row only, plus up to three tag chips (`tags`/`tag` values, list or string) and `+n` for the rest.
- Default state: the setting `editor.properties-default-collapsed`, an enum: `auto` (default) collapses a block with more than 6 properties or more than 8 lines; `collapsed` always; `expanded` never. A toggle on a note overrides it for that note until the app quits (not persisted; keyed by path). Thresholds: `PROPERTIES_COLLAPSE_AUTO_PROPS`, `PROPERTIES_COLLAPSE_AUTO_LINES`.
- Expanded: the body is capped at `max-h-[40vh]` and scrolls inside, so a huge block cannot push the note off screen. A Source button (`aria-pressed`) swaps the rows for a textarea with the raw YAML.
- Not collapsible away: a note with no frontmatter shows nothing; typing `---` on the first line of such a note still opens an empty panel (existing `editor-clipboard.ts` behaviour) with the add-property field focused.

### Row kinds

| Kind                                                                                     | Control                                                                      | Edit writes                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| text, empty                                                                              | text input (blur or Enter commits, Escape reverts)                           | value token; empty clears to `key:`         |
| number (plain `-?\d+(.\d+)?`)                                                            | number-validated input                                                       | value token                                 |
| checkbox                                                                                 | checkbox                                                                     | `true`/`false`                              |
| date, datetime                                                                           | native date / datetime-local (a space separator and seconds are preserved)   | value token                                 |
| `[[wikilink]]`, URL                                                                      | link button (opens note / URL) and an Edit field                             | value token                                 |
| list, tags                                                                               | chips with remove, an add input (Enter, comma, blur; Backspace removes last) | one `- item` line, or the `[a, b]` brackets |
| tags written as one string                                                               | chips over `a b` / `a, b`, separator kept                                    | the string                                  |
| nested map                                                                               | read-only nested key/value text, "Edit nested properties in Source"          | none                                        |
| multi-line string, flow map (`{{date}}`), alias, unquoted `[[x]]` list, non-plain number | read-only source text                                                        | none                                        |

Also: key rename (blur or Enter; refused for an empty or existing name), remove (x button, keyboard reachable). Removing the last property drops the frontmatter block (previous behaviour). Add property: name field with the vault's names as a datalist (`index_properties`), a type picker (text, number, checkbox, date, date & time, list, tags) preselected from the vault's dominant type for that name, Add button or Enter. A new list is written `key: []` and becomes a block list on the first item.

### Edit rules (never reformat user text)

Edits are text splices on the frontmatter string built from the `yaml` Document node ranges: a value change replaces only the value token (quote style kept), a list change touches one line or the brackets of a flow list, a removal drops the property's own lines, an add appends one line at the end. Comments, blank lines, key order, other properties and unknown shapes stay byte-identical. Every edit is re-parsed and compared with its semantic outcome (all other properties unchanged and in order); on a mismatch it is refused with a message and nothing is written. A string that would parse as another type (`true`, `123`) is quoted.

Refused shapes (panel shows a message and the raw text only): unparsable YAML (tab indentation, unclosed flow, ...), duplicate keys (named in the message), flow-mapping root, non-mapping root, non-scalar keys. Raw text is always editable.

### Performance

The panel subscribes to its own file's `frontmatter` string (`useFrontmatter`), the per-note panel state, and one setting. Typing in the body changes `content` only, so the panel does not render (tested). Vault keys are fetched once when the add field mounts, cached 30 s.

### Not done

- Tag value autocomplete (`index_properties` lists names and types, not tag values; no tags index command is exposed to the frontend).
- Changing the type of an existing property (remove and add instead), reordering rows, a property-specific widget for `cssclasses` (no `cssclasses`, `publish` or banner key exists in the measured vault).
- Property edits in CodeMirror undo/redo.
- Rendering in a real window (layout, focus return to the editor after a chip add, native date input look).

## Real-world shapes (aggregated, anonymised)

Measured on the user's main vault with a throwaway script (frontmatter block only; no values, titles or paths recorded). 2,601 Markdown files, `.obsidian`, `.git`, `.trash` and `node_modules` skipped.

**Coverage.** 2,303 notes (88.5%) have frontmatter, 298 (11.5%) none. 0 empty blocks, 0 CRLF, 0 BOM, 0 blocks not at the start of the file, 0 unclosed blocks, 0 `...` closers. 6 notes are frontmatter only.

**Size.**

| Metric                   | p50 | p90 | p99   | max    |
| ------------------------ | --- | --- | ----- | ------ |
| Lines of the block       | 9   | 21  | 41    | 65     |
| Bytes of the block       | 193 | 745 | 1,825 | 24,096 |
| Properties per note      | 6   | 14  | 16    | 27     |
| Items in a list value    | 2   | 5   | 10    | 30     |
| Length of a string value | 10  | 45  | 200   | 1,057  |

47% of notes have more than 6 properties, 25% more than 10, and 57% have blocks longer than 8 lines. An always-open panel would push the body down by more than 8 rows in over half of the vault; this is why the default is `auto`. 102 string values exceed 200 characters, 1 exceeds 1,000.

**Keys.** 247 distinct keys. Naming: 96 plain lowercase, 77 snake_case, 38 camelCase, 28 hyphenated, 6 containing a space (one of them, a creation-date key, is in 663 notes), 2 with capitals. 0 non-ASCII keys. Most frequent (notes): `tags` 2,151; `type` 885; `updated_at` 826; `created_at` 809; a spaced creation-date key 663; `title` 586; `area` 481; `status` 463; a list of people (`attendees`) 353; a person-reference key 346; a link-valued owner key 311; `when` 300; `related` 277; `collaborators` 229; `priority` 227; `due` 226; `sources` 200; `done_on` 190; `epoch` 175; `contradictions` 164. About 15 generated-note schemas (machine-written keys such as ids, counts, timestamps) account for hundreds of notes each. Keys differing only by case, space, hyphen or underscore across notes: 3 groups (for example a spaced and a snake_case spelling of the same name); 0 within one block. Obsidian special keys: `tags` (2,151 notes), `aliases` (47, always a list); `cssclasses`, `publish`, banner or cover keys: 0; `date` 85, `created` 140.

**Value types** (counts of values): plain string 5,225; list of strings 3,638; date `YYYY-MM-DD` 3,107; datetime 984 (`T` or space separated, minutes); wikilink string 699 (always quoted); integer 665; empty list 420; null/empty 233; URL 228; boolean 175; nested map 45; empty string 29; template placeholder string 23; list with nulls 16; mixed list 9; float 4; multi-line string 4; list of numbers 3; list of maps 1. Unquoted `[[x]]` (which YAML reads as a nested list): 0.

**Per key, the type is mostly stable** but some keys mix: due dates are a date or empty (31% empty); `author`, `collaborators`, `related`, `employee` mix list, string and empty; a person-reference key is a string in 82% and a list in 18%.

**Tags.** 2,151 notes: block list 1,790 (753 of those contain nested `a/b` tags, 3 are `#`-prefixed), space-separated string 338, one-word string 10, empty 10, 2 placeholders. So 16% of tag values are a single string, not a list: the panel treats `tags: a b/c` as chips.

**Style.** Flow lists in 212 blocks (9%), nearly all `[]` empty; flow maps 2 blocks (both an unquoted `{{date}}`, which YAML parses as a one-key flow map with a map key); anchors, aliases, merge keys 0; block scalars 2 notes; YAML comments inside a block 1 note; tab indentation 2. Quoting: titles are double-quoted in 28%, ids and some sources always double-quoted, some usage fields single-quoted, so scalar style must be preserved per value.

**Problem blocks** (counts of notes). Unparsable: 6 (0.26%; unexpected token or a multi-line implicit key). Duplicate key in one block: 8 (0.35%). Templater/Dataview-style placeholders (`{{...}}`, `<% ... %>`) in the block: 19, only 2 unquoted `{{` (those parse but with a surprising shape); the rest are quoted or plain `<%` strings. Nested map values: 45 notes, depth 1, 43 of them under one `metadata` key. Inline Dataview `key:: value` fields: 0 notes.

**`.base` files.** 27, all valid YAML; 125 views: table 109, cards 16. They reference mostly file fields (`file.name`, `file.inFolder`, `file.ext`, `file.hasTag`, `file.path`, `file.folder`, `file.hasLink`, `file.mtime`) and three note properties.

### What the shapes require

| Finding                                       | Requirement in the panel                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Median 6, p90 14 properties, 57% over 8 lines | Collapsed one-row default for large blocks; open body capped and scrolling |
| 338 space-separated `tags` strings            | `tagString` kind: chips over the string, separator kept                    |
| 753 nested `a/b` tags                         | Chips show the text as is; no splitting on `/`                             |
| Dates 3,107 and datetimes 984                 | Native date/datetime inputs; keep `T` vs space and seconds                 |
| Quoted wikilinks 699                          | Link kind: open the note; edit the text                                    |
| Many spaced and mixed-style key names         | Keys edited as plain text; key quoting by `yaml` only when needed          |
| `[]` in 212 blocks, `key:` null in 233 values | Empty list becomes a block list on first add; null fills in place          |
| 8 duplicate-key blocks, 6 unparsable          | Refuse rows, explain, offer raw text                                       |
| `{{date}}` unquoted, flow maps                | Read-only source row; other rows still editable; text untouched            |
| Comments, mixed quoting, block scalars        | Value-token splices; multi-line strings read-only                          |
| 45 nested maps under one key                  | Read-only readable nested rows                                             |
| Tab indentation (2)                           | Unparsable: raw text only, never "fixed"                                   |

## Tests

`tests/frontmatter-properties.test.ts` (kinds, refusals, byte-exact splices for each edit kind, comments and placeholders preserved, collapse rules) and `tests/properties-panel.test.tsx` (summary row, heuristic, per-note toggle, bounded body, setting, no re-render on body changes, edits, chips, add with type, raw fallback, duplicate keys, placeholder rows, Source toggle). Fixtures are invented and shaped after the table above.

## Unverified in a real window

Layout and spacing against the editor column and top fade; focus return to the editor after using the panel; native date input rendering; the 40vh cap against a short window; the `index_properties` suggestions against the real index; opening a wikilink or URL from a row.
