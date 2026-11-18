# Property types and wikilink properties

Status: implemented (unverified in a real window). Builds on [properties-panel-spec.md](properties-panel-spec.md). Decisions: [ADR](../docs/decisions/2026-11-17-record-property-types-in-writers-own-file-and-read-obsidians-types-json-read-only.md), and for `object` [ADR](../docs/decisions/2026-11-18-add-an-object-property-type-edited-as-indented-rows-up-to-two-levels.md).

## Goal

Every property row starts with an icon showing its type. Clicking it opens a menu to change the type. Like Obsidian, a property name has ONE type across the vault; the value in the open note is converted when that is safe.

## Types

Obsidian's names are the wire names everywhere (Rust enum `PropertyType`, TS `PropertyType`): `text`, `multitext` (shown as "List"), `number`, `checkbox`, `date`, `datetime` ("Date & time"), `tags`, `aliases`, plus Writer's own `relationships`, `enum` and `object`. The menu offers `text`, `multitext`, `relationships`, `enum`, `object`, `number`, `checkbox`, `date`, `datetime` (Relationships right after List); `tags` and `aliases` are special names that show their own icon and appear in the menu only while current.

| id              | label         | icon (`@hugeicons/core-free-icons`) | value                                           |
| --------------- | ------------- | ----------------------------------- | ----------------------------------------------- |
| `text`          | Text          | `TextIcon`                          | a string                                        |
| `multitext`     | List          | `LeftToRightListBulletIcon`         | a list                                          |
| `relationships` | Relationships | `Link01Icon`                        | one `[[link]]` or a list of `[[links]]` (below) |
| `enum`          | Enum          | `DropdownFieldTypeIcon`             | a string from the type's list (below)           |
| `object`        | Object        | `BracesIcon`                        | a map, edited as indented rows (below)          |
| `number`        | Number        | `HashtagIcon`                       |                                                 |
| `checkbox`      | Checkbox      | `CheckmarkSquare02Icon`             |                                                 |
| `date`          | Date          | `Calendar03Icon`                    |                                                 |
| `datetime`      | Date & time   | `Clock01Icon`                       |                                                 |
| `tags`          | Tags          | `Tag01Icon`                         | special name                                    |
| `aliases`       | Aliases       | `AtIcon`                            | special name                                    |

Obsidian has no Link type: `relationships` is Writer's, and a `[[wikilink]]` is still, to Obsidian, a text or list value. So `relationships` is stored only in `.writer/property-types.json` (as `"relationships"`); an `.obsidian/types.json` entry of that name is skipped and Writer never writes it there. Plugins see it as `multitext` (the vault holds lists of links under that name) or `text` (single links), through `metadataTypeManager.getAllProperties/getPropertyInfo/getAssignedType`, and `setType('relationships')` from a plugin is rejected ("Unknown property type"). The mapping is one function, Rust `PropertyType::obsidian_name`, reported as `obsidianType` in the `property_types` result.

One registry per language: `src/lib/property-types.ts` (id, label, icon, inline warning) and the Rust enum. Icons come from the app's icon library (`@hugeicons/core-free-icons`). The unknown/mixed state (a value that does not fit the declared type) shows a warning icon, the tooltip "Type: not a ..." and an inline note on the row; the value is never rewritten.

## Where the type lives (single source of truth)

`src-tauri/src/property_types.rs`, Tauri-free:

1. `.writer/property-types.json`, Writer's own record, `{"types": {"name": "number"}}` (Obsidian's format, lower-cased names). The only file written (atomic replace, `.writer` must resolve inside the vault). Wins.
2. `.obsidian/types.json`, read-only. Unknown type strings and a broken file are skipped. Writer never writes it (a test scans the written paths).
3. No record: inferred from the index's observed value types (most common wins; `bool` is checkbox, `list` is multitext, `object` is object); the names `tags`/`tag` and `aliases`/`alias` are Tags and Aliases. **Relationships are inferred automatically**, with no manual step: per value, a single `[[...]]` (`link`) or a list in which every item is a `[[...]]` (the synthetic `links`, computed read-only from `prop_items` by `Index::list_shapes` and folded in by `property_types::refine_list_shapes`; no schema change) is a link value, including `[[Note|Alias]]`, `[[Note#Heading]]`, `[[folder/Note]]`. An empty value or empty list is neutral (counted as `null`), it never forces a type. Per property name, when no type is recorded and every non-empty value of that name across the vault is a link or a list of links (singles, lists, or a mix across notes), the property is `relationships`. One note holding plain text (or a list with a plain item) makes the vault-wide type something else, and the link-only notes then show the mixed state. A recorded type always wins and the user can switch away by hand; inference never writes the record, it only decides what the panel shows and what Bases and plugins see.

`property_types` (command) returns every vault property merged case-insensitively, plus recorded names no note uses, as `{key, count, types, type, source: writer | obsidian | inferred, mismatched}`; `mismatched` counts notes whose value does not fit (`PropertyType::fits`). `property_type_set(name, ty)` records a type. The frontend reads them through `lib/property-types-ipc.ts` into one Zustand store (`stores/property-types-store.ts`, 30 s freshness, optimistic set with rollback, newest fetch wins); the panel, the add-property suggestions and the plugin host's `app.metadataTypeManager` (`getAllProperties`, `getPropertyInfo`, `getAssignedType`, `setType`) all read it. `setType` from a plugin writes Writer's record.

A row's declared type is the recorded one (Writer or Obsidian); with only an inferred type the row shows its own value's type and the tooltip says how many other notes use a different one.

Bases: the engine still receives typed values from the index and never re-types them ([`bases/README.md`](../apps/desktop/src-tauri/src/bases/README.md) U19). The record is a UI concern.

## Changing a type

Choosing a type (a) records it vault-wide and (b) converts THIS note's value, as one `updateFrontmatter` call (one undo step) through the panel's verified byte-minimal splices (`lib/property-conversion.ts`; comments, key order and CRLF stay). Other notes are never rewritten: a value that does not fit shows the unknown/mixed state. A value that cannot convert is kept, the type is still recorded, and the row shows the inline warning.

| from \ to   | text          | list (List, Tags, Aliases)       | number       | checkbox          | date           | date & time       |
| ----------- | ------------- | -------------------------------- | ------------ | ----------------- | -------------- | ----------------- |
| text / url  | -             | split on commas (not in `[[ ]]`) | if parseable | true/false/yes/no | common formats | common formats    |
| link        | -             | one item                         | refused      | refused           | refused        | refused           |
| number      | quoted digits | one item                         | -            | refused           | refused        | refused           |
| checkbox    | `"true"`      | one item                         | refused      | -                 | refused        | refused           |
| date        | -             | one item                         | refused      | refused           | -              | `T00:00` appended |
| date & time | -             | one item                         | refused      | refused           | time dropped   | -                 |
| list        | joined `", "` | -                                | refused      | refused           | refused        | refused           |
| empty       | unchanged     | `[]`                             | unchanged    | unchanged         | unchanged      | unchanged         |

Relationships column (the shape is kept: a single link stays single, a list stays a list):

| from \ to                           | relationships                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text / url                          | one `[[x]]` stays a single link; `[[a]], [[b]]` splits into a list (commas inside `[[ ]]` do not split); plain text only if it resolves by file name, else refused "Not a link" |
| link                                | unchanged (single)                                                                                                                                                              |
| list                                | every item must be a link or resolve by file name, else refused "Not a link"; stays a list; an empty list is unchanged                                                          |
| number, checkbox, date, date & time | refused "Not a link"                                                                                                                                                            |
| empty                               | unchanged (the first link is written later, as a single value)                                                                                                                  |

From relationships: to text a list is joined `", "` (a single link is already text and stays quoted); to list the items are kept as quoted link strings (a single link becomes one item). Plain text resolves through `resolve_wiki_link` (by file name, never by title) and is written as `[[File name]]` using the resolved note's own name.

Number: `^[-+]?(\d+\.?\d*|\.\d+)$` after trimming. Dates accept `YYYY-MM-DD` (also `/` and `.`), `D/M/YYYY` or `M/D/YYYY` only when one part is above 12, `March 5, 2026`, `5th Mar 2026`; times `H:mm[:ss]` with an optional offset (dropped); output is `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`. Tags drop a leading `#`. Multi-line strings, placeholders and every conversion to or from Object are refused ("edit it in Source"); a map is already an Object and an empty value stays unchanged.

## Enum

A Writer-only type: a property whose value is always one of a list, shown as a dropdown. Obsidian has no such type, so like `relationships` it is stored only in `.writer/property-types.json`, an `.obsidian/types.json` entry named `enum` is skipped, and plugins see it as `text` (`PropertyType::obsidian_name`; `setType('enum')` from a plugin is rejected). The value on disk is a plain string, so the note stays valid for Obsidian. The registry flag `writerOnly` (TS) and `PropertyType::is_writer_only` (Rust) name the Writer-only types once (`relationships`, `enum`, `object`).

- File shape: an enum entry is an object, `{"types": {"status": {"type": "enum", "values": ["todo", "doing", "done"]}}}`; every other type stays a bare string, so old files load unchanged. Values are ordered, trimmed, non-empty, unique (case-sensitive), one line each. Unknown entries in the file are preserved on rewrite. `property_types` reports `values` (empty for other types).
- Value cell: always a dropdown (`EnumSelect`, a listbox popover: arrows, Home/End, Enter, Escape, type-to-add), with an empty choice that clears the value and a final "Add value..." entry. Adding appends to the type's values through `property_type_set(name, "enum", values)` (the one write path, `usePropertyTypesStore.addEnumValue`) and sets it on the note. A note whose value is not in the list shows it marked "not in list" and still selectable in the list; it is never rewritten until the user picks another value. Only text values (and empty) get the dropdown; a number or list under an enum type keeps its own editor and the "Not text" warning.
- Converting to Enum: `property_type_set(name, "enum")` without `values` seeds the list with every distinct existing value of the property across the vault (scalar texts and list items, from the index's `props` / `prop_items`), sorted by note count descending then name; when the type already is an enum its values are kept. Notes are not rewritten (this note's value converts like text). Converting away keeps every note unchanged and drops the list.
- Add property: choosing Enum records an empty list (nothing observed yet); values are added from the dropdown.
- Bases: an enum property is text in expressions and in the engine. The table's cell editor for a text cell of an enum property is the same `EnumSelect` (through `PropertyEnumSelect`, core), so adding a value works there too.

## Object

A Writer-only type: a property whose value is a YAML map, the skill `metadata:` of `.agents/skills/*/SKILL.md` being the reference case. Decision: [ADR](../docs/decisions/2026-11-18-add-an-object-property-type-edited-as-indented-rows-up-to-two-levels.md). Like `relationships` and `enum` it is stored only in `.writer/property-types.json` (`"object"`); an `.obsidian/types.json` entry of that name is skipped, plugins see `text` (`obsidian_name`, `setType('object')` rejected), and Writer never writes `.obsidian`. It is inferred when the index sees maps (`vtype` `object`); `fits` accepts only maps and empty values. Add property with Object writes `key: {}`.

- **Levels**: the property's map is level 1, a map in it level 2. Anything deeper (a map inside a level-2 map), a flow map (`{a: 1}`), an anchored map, a multi-line string, a placeholder or a duplicated key is shown read-only as its YAML source with "Edit in Source" and is never rewritten. A list item that is a map stays read-only too.
- **Panel**: the row shows a disclosure ("3 keys", "Empty") and, open (the default), indented key/value rows. Each key is a row of its own: rename in place (Enter or blur, Escape reverts), edit the value in place, "x" removes the key, "+ Add key" at the end of each map (level-2 maps have their own) adds it with an empty value. Leaf values are inferred like an untyped property with no type picker: text, number, checkbox, date, date & time, link/url, or a list of text (the chip editor). Keys in a map are never tags or relationships. An empty map is `{}`; removing a map's last key leaves `key: {}`, adding the first key to `{}` turns it into a block (a comment on that line stays). The Remove x and the labels of nested rows name the whole path (`metadata.flags.beta`).
- **Writes** are byte-minimal: one splice per nested key, never a re-stringified map. A set replaces that key's value (or lines), an add appends lines after the map's last entry using the map's own indentation (two spaces more than the map for `{}`), a remove drops the key's lines, a rename replaces the key token. Comments, order, blank lines and every other key stay identical. Each result is re-parsed and compared with the old block with only that key changed, else refused. Two implementations, one behaviour: the TS panel splicer `src/lib/frontmatter-nested.ts` (the `yaml` Document ranges) and the Rust patcher `index/patch/nested.rs` (via `patch::set_property` / `remove_property`, so `vault_ops`, Bases and the CLI get it), pinned by `apps/desktop/shared/nested-property-vectors.json` that both test suites read (set, add, remove, rename, levels, comments, read-only parts, refusals).
- **Dotted paths**: `metadata.version`, level 2 `metadata.flags.beta`. A name containing a dot that is itself a top-level key wins ("exact name first"); otherwise it is nested when its first part is a property holding a map, else an ordinary new property. CLI: `writer property:set name=metadata.version value=2` (the existing value's type is kept, so `2` stays a number), `property:read` (any depth), `property:remove` (an emptied map becomes `{}`). Writes reach two levels; a flow map, a map deeper than that or a key that holds a map (set its keys instead) is refused with the file untouched.
- **Bases**: `note.metadata.version` in a filter or formula is member access on the map (the engine's `Value::Object`); in `order`, `sort`, `groupBy` and `note["metadata.version"]` the dotted name resolves through `Interp::note_value` (exact property first, then into the map, any depth). Filter pushdown skips dotted names (the SQL key is top-level only). Tests: `nested_keys_of_an_object_property_work_in_columns_filters_sort_and_group`, `an_exact_dotted_property_name_wins_over_the_nested_key`.
- **Index**: nested keys are not properties of the vault: not in the Properties list, `props` or `prop_items`.

## Add property

The "Add property" row has the same type menu up front and a name field that suggests the vault's existing names (most used first) with their type icons; a known name defaults to its recorded type. Choosing a type there records it (a known name's type is not rewritten). List, tags and aliases rows keep their chip editing; date rows keep the native `date` / `datetime-local` inputs the panel already had.

## Relationships properties

- One value cell: a chip per link (`property-wikilink.tsx` link button: click opens the note, unresolved targets dimmed and dotted, "x" removes the link) and a "+" (or "+ Add link" while empty). Reorder by drag is not offered (the app has no generic drag util for chips).
- "+" opens a picker (`relationship-picker.tsx`): a popover with a search field over the vault's own `fuzzy_search` (fuzzy, typo tolerant, recents first when empty, `index/rank.rs`; there is no second search), each result as note name plus folder hint. Type to filter, arrows move, Enter picks, Escape closes and refocuses "+", a click outside closes. Notes already in the property (by file name or path, any alias or heading form) are hidden. Typing `[[` in the raw inputs of text or mixed-list rows still autocompletes.
- A pick writes `"[[File name]]"` by file name, never by title; the folder path form (`[[Projects/Beta]]`) only when another note shares the name (`linkForNote`). The first link of an empty property is a single value; a second turns it into a list; a list gains an item. Removing the only link of a single value empties the property. Every add or remove is one `updateFrontmatter` call (one undo step) through the single quoted, byte-minimal, CRLF-safe write path.
- Middle-click on a chip (`auxclick`, button 1) opens the note in a new tab through `editorApi.openFileInNewTab`, the path an editor wiki link's middle-click uses; Bases link cells do the same. A plain click navigates in place; Cmd/Ctrl+click is not special anywhere for links, so it behaves like a plain click here too.
- Renaming a note rewrites these links (single, flow list, block list, alias, heading, folder forms; tests in `relocate/linkfix.rs`).
- Bases: a single link is a `link` value and a list of links a `list` of `link` values, so `list(employee).contains(list(this.employee)[0])` works whether `employee` is a single link or a list; aliases, headings and folder forms compare by the note they point to (test `relationships_properties_work_as_link_and_list_of_links`). `file.links` and `file.backlinks` already include frontmatter links.
- CLI: `writer properties types` adds each property's type (`relationships` included) to the vault-wide listing.
- Backlink counts on chips and the graph tables of `note-graph-spec.md` are not part of this type (the index records frontmatter links in `links` with `in_fm = 1`, without the property name).

## Wikilink properties

- `[[Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]` in a text value or a list item render as a clickable link (label: alias, else note, else `Note > Heading`). Click opens the note through the file-name resolver (`resolve_wiki_link`); a missing note shows a dimmed dotted style (checked once per 5 s per target).
- Editing keeps the raw `[[...]]` text. Typing `[[` in a property input opens note-name suggestions: the same ranked search as the editor (`wikiSuggestions` in `lib/wiki-links.ts`, used by both), arrows/Enter/Tab/Esc.
- YAML stays valid: a link is written quoted (`"[[x]]"`) by the single write path. `[[x]]` unquoted is a YAML nested list; the panel reads it (value or list item) as the link, and the index does too (`index/frontmatter.rs` `fold_unquoted_links`, so Bases `link()` and `file.links` see a link). A real nested list (`[[a, b], c]`) stays a list. An unquoted link is rewritten quoted only when that property is edited.
- Renaming a note rewrites property links through `relocate/linkfix.rs` (frontmatter strings, quoted and unquoted; tests for both).

## Not done

- More than two editable levels, lists of objects, a type per nested key; `writer` CLI commands for property types; the sidebar/tag views do not use types yet (nothing there needs one).
- A second window sees a type change after its next fetch (30 s cache), not live.
- No custom date picker beyond the browser's native inputs.
