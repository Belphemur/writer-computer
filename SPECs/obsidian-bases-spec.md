# Obsidian Bases Spec

Status: planning spec (research only, no code yet). Follows the "Deferred: Bases, indexing, SQLite" entry in [obsidian-plugins-spec.md](./obsidian-plugins-spec.md).

## Summary

Support Obsidian Bases in Writer: open `.base` files as their own tab, render them (table first, then cards and list), evaluate filters, formulas and summaries with the documented expression language, edit note properties in place, and embed bases in notes (`![[x.base]]`, `![[x.base#View]]`, ` ```base ` blocks). A SQLite vault index in the Rust backend (properties, tags, links, backlinks) backs the queries and also backs the plugin host's `MetadataCache`.

## Clean-room statement

Bases behavior is taken only from public sources: the public help pages (https://obsidian.md/help/bases/*, raw markdown in https://github.com/obsidianmd/obsidian-help), the public `obsidian-api` d.ts and developer docs, and the user's own vault as a black-box sample of real files. No part of the Obsidian application bundle was read. Every behavior not covered by those sources is marked UNKNOWN and is resolved only by black-box experiments (section 6.3).

Source keys used below:

- **H** = `obsidian-help/en/Bases/` (public: https://obsidian.md/help/bases): `Bases syntax.md` (H:syntax), `Views.md` (H:views), `Formulas.md` (H:formulas), `Functions.md` (H:functions), `Create a base.md` (H:create), `Layouts/*.md` (H:table, H:cards, H:list, H:kanban, H:map).
- **D** = `obsidian-api` `obsidian.d.ts` (Bases types, `registerBasesView`) and **G** = `obsidian-developer-docs` `Plugins/Guides/Build a Bases view.md`. Digest of both: `scratchpad/obsidian-api-ref/bases.md` (not committed).
- **V** = the user's vault (confirmed by real files). Status tags: **[C]** confirmed by real files, **[D]** documented publicly, **[C+D]** both, **[U]** unknown / unverified.

## 1. Goals, non-goals, success criteria

### Goals

- Open an existing Obsidian vault's `.base` files in Writer and render the same rows, columns, groups and summaries Obsidian shows, for the features that real vaults use (section 3).
- Parse and evaluate the full documented expression language (section 2.5), including linked-note lookups, `file.backlinks` and `this`.
- Edit note properties from a table cell, writing frontmatter back without disturbing unrelated YAML (comments, key order, scalar styles).
- Embed bases in notes as CodeMirror block widgets.
- A vault index that makes a base over a 10k-note vault feel instant, and that also serves the plugin host.
- Round-trip safety: never rewrite a `.base` unless the user changes it in Writer, and never drop keys Writer does not understand.

### Non-goals (v1)

- Map and Kanban views (Phase 4+ stretch; Map needs the Maps community plugin, H:views).
- Creating or editing filters, formulas and view settings through a full UI (v1 edits via a raw YAML editor and a minimal view menu; the full builder is a follow-up).
- Dataview query compatibility (421 notes in the sampled vault use Dataview blocks; separate feature).
- Sync, publish, mobile, Canvas embeds.
- Custom functions for formulas (H:syntax says plugins will be able to add them "in the future"; no public API exists).
- Pixel parity with Obsidian's chrome. Parity means the same data, not the same CSS.

### Success criteria

1. Every `.base` file in the sample vault (27 files, 125 views) opens without error and each documented-and-supported expression evaluates; expressions that are invalid in Obsidian show a visible error, not a crash (section 4.2.3).
2. Golden suite (section 6): 100% of fixtures pass for filters, formulas, sort, groupBy, summaries, limit; ground-truth expectations come from black-box Obsidian CSV exports.
3. Performance: see 4.1.8 (table over 10k notes interactive in under 300 ms after warm index).
4. A `.base` byte-identical on disk after open, view switching, scrolling, and cell edits in notes (only a cell edit rewrites the note; only a config change rewrites the `.base`).
5. Editing a cell changes only the targeted key's lines in the note's frontmatter (diff test).

## 2. What Bases is (public docs)

Bases is a core plugin that gives "database-like views of your notes" over Markdown files and their properties. A definition lives in a `.base` file or in a `base` code block inside a note (H:introduction, H:create). Layouts by app version: Table 1.9, Cards 1.9, List 1.10, Map 1.10 (requires the Maps plugin), Kanban 1.14; "Additional layouts can be added by community plugins" (H:views).

### 2.1 File format

A `.base` file is YAML. Public type `BasesConfigFile` (D) has optional `filters`, `properties`, `formulas`, `summaries`, `views`. The full set of keys found in docs and real files:

```yaml
name: Optional title # [C] 12/27 files; NOT documented, meaning unknown [U]
filters: # [C+D] global filter, ANDed with each view's filters (H:syntax)
  and: # [C+D] 87 uses; also `or` [C+D] 5 uses; `not` [D] only
    - file.inFolder("Some/Folder") # [C+D]
    - file.ext == "md" # [C] 24 files
    - status != "done" # [C+D] comparison string
    - or: ["formula.days_ago <= 30", "x == null"] # [C+D] nested group
formulas: # [C+D] name -> expression string (always a YAML string)
  days_ago: 'if(updated, (today() - date(updated)).days, "")'
properties: # [C+D] 25/27 files; only `displayName` seen [C+D]
  status: { displayName: Status } # bare id: 151 uses [C]
  formula.days_ago: { displayName: Age } # prefixed id: 93 uses [C]
  file.name: { displayName: Name } # 1 use [C]
summaries: # [D] custom summaries (name -> formula over `values`); 0 uses in V [U-in-practice]
  customAverage: "values.mean().round(3)"
views: # [C+D]
  - type: table # [C+D] table 109, cards 16 in V; list/kanban/map documented, not seen
    name: "My table" # [C+D] 125/125 views
    filters: { and: [...] } # [C+D] 61/125 views; same grammar as global
    order: [file.name, status, formula.days_ago] # [C+D] 124/125; mixed bare / note. / file. / formula. ids
    sort: # [C] 71/125 views; shape confirmed by files, NOT in the help pages
      - { property: due, direction: ASC } # direction ASC | DESC; list = multi-sort in priority order
    groupBy: { property: status, direction: ASC } # [C+D] 51 views; direction ASC | DESC
    groupOrder: [Planned, Done, null] # [D] (d.ts 1.14.3); 0 uses in V
    limit: 10 # [C] 6 views (row cap); UI "Results > limit" [D]
    summaries: { file.name: Count } # [C+D] 76 views; values seen: Count 75, Sum 2, Empty 1, Average 1
    columnSize: { file.name: 420 } # [C] 19 views, table column widths in px; NOT documented
    rowHeight: medium # [C] 1 view; table; UI values short|medium|tall|extra tall [D]
    cardSize: 220 # [C] 2 views; cards width; NOT documented as a key
    # plugin views may add arbitrary keys [D: H:syntax "views can add additional data"]
```

Confirmed-by-files vs documented:

| Key                                                                                      | Source | Notes                                                                        |
| ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `filters` (`and`/`or`)                                                                   | [C+D]  | `not` documented (H:views conjunctions "None of the following"), 0 uses in V |
| `formulas`, `properties.*.displayName`                                                   | [C+D]  |                                                                              |
| `views[].type/name/order/filters/groupBy/limit/summaries`                                | [C+D]  |                                                                              |
| `views[].sort` (list of `{property, direction}`)                                         | [C]    | d.ts `BasesSortConfig {property, direction}` is consistent (D)               |
| `views[].columnSize`, `rowHeight`, `cardSize`                                            | [C]    | key names from files only                                                    |
| top-level `name`                                                                         | [C]    | undocumented; preserve, do not interpret                                     |
| `summaries` (top-level), `groupOrder`                                                    | [D]    | not seen in V                                                                |
| list/cards-specific keys (image property, image fit/aspect, markers, indent, separators) | [U]    | UI names documented (H:cards, H:list), YAML key names unknown                |
| `imageProperty`, `imageFit` etc.                                                         | [U]    | resolve by black-box (6.3)                                                   |

Schema facts [D unless stated]:

- Filter = `string | {and: Filter[]} | {or: Filter[]} | {not: Filter[]}`, recursive, heterogeneous lists (D `BasesConfigFileFilter`). `not: [a, b]` = none of the list are true (H:views). Global and view filters are concatenated with AND. A base without filters "shows all the files in your vault"; there is no `from`/`source` (H:views, H:syntax), so non-Markdown files are included.
- Property id (D `BasesPropertyId`): `note.x`, `file.x`, `formula.x`; a bare name means `note.` (H:syntax). Names with spaces need `note["creation date"]` in expressions; in `order`/`sort`/`properties` keys the bare form with spaces appears in real files [C] (e.g. `creation date:` as a `properties` key).
- Formulas may reference other formulas; no cycles (H:syntax, H:formulas).
- Summaries: view-level map `propertyId -> summaryName`; defaults Average, Min, Max, Sum, Range, Median, Stddev (number), Earliest, Latest, Range (date), Checked, Unchecked (checkbox), Empty, Filled, Unique (any) (H:table). Custom: name + formula over `values` (H:table, H:syntax). **`Count` is used 75 times in real files but is not in the documented list [C, undocumented]**; treat as a built-in "count of rows" and verify (6.3). Summaries are per view; with groupBy the group summary shows at the top of each group, otherwise at the bottom (H:table).

### 2.2 Namespaces and `this`

- `note.*` or bare: frontmatter properties. `file.*`: `file.name`, `file.basename`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.tags` (content and frontmatter), `file.links` (includes frontmatter links), `file.embeds`, `file.backlinks` (slow, no auto-refresh), `file.properties` (object), `file.file` (file object, only usable in specific functions) (H:syntax, H:functions). `formula.*`: formulas in the same base.
- `this`: the base file itself when opened in the main area; the embedding note (or Canvas) when embedded; the active main-area file when the base sits in a sidebar (H:syntax). Embedded `base` code blocks resolving `this` to the note: [D]; edge cases [U].

### 2.3 Filter grammar

A filter string is an expression that must evaluate truthy: a comparison with `== != > < >= <=`, a function call (`file.hasTag("x")`), a boolean combination (`! && ||`), or a bare property/formula (truthy test). Values may contain math and functions (H:views "Components of a filter"). Filters and formulas share one grammar and function set (H:syntax). In V the following filter forms occur [C]: `file.inFolder("…")`, `file.ext == "md"`, `file.hasTag("…")`, `file.hasLink("…")`, `file.path.contains("…")`, `!file.inFolder("…")`, `file.folder.startsWith("…")`, `prop == "literal"`, `prop != "literal"`, `prop == null` / `!= null`, `prop == true`, `list.contains("…")`, `formula.x <= 30`, `length(x) > 0` (see 2.5, likely invalid).

### 2.4 Types and literals

string (single or double quotes), number, boolean, date (with or without time), duration, list `[1,2]` (0-based `x[0]`), object (`x.sub`, `x["sub"]`), link, URL, file, regexp (`/abc/`), html, image, icon, null (H:syntax, H:formulas). Wikilinks in frontmatter become Link values, URLs become URL values (H:syntax). Link equality: same resolved file, or identical text if unresolved; links compare with `file`/`this` (`author == this`, `authors.contains(this)`) (H:syntax). Date arithmetic: `date + "1M"`, `now() - "2h"`, date minus date = duration; units y/M/d/w/h/m/s with long forms (H:syntax); scalar times duration needs the duration on the left (H:functions `duration()`).

Duration fields (`.days`, `.hours`, ...) are NOT documented in H. Real files use `(today() - date(x)).days` 41+ times [C usage, semantics U]: likely a duration field returning a number of days; confirm (6.3).

### 2.5 Operators and functions (H:syntax, H:functions)

Operators: `+ - * / %`, parentheses, `== != > < >= <=`, `! && ||`, indexing `[ ]`, member access `.`.

Lambda-like list functions (`filter`, `map`, `reduce`) take an expression evaluated per element with implicit `value`, `index`, and `acc` (H:functions, H:formulas).

| Type   | Members documented                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| global | `escapeHTML(html)`, `date(str)`, `duration(str)`, `file(path\|file\|url)`, `html(str)`, `if(cond, then, else?)`, `image(path\|file\|url)`, `icon(name)`, `link(path\|file, display?)`, `list(x)`, `max(...)`, `min(...)`, `now()`, `today()`, `number(x)`, `random()` |
| any    | `isTruthy()`, `isType(type)`, `toString()`                                                                                                                                                                                                                            |
| date   | fields `year month day hour minute second millisecond`; `date()`, `format(momentFmt)`, `time()`, `relative()`, `isEmpty()`                                                                                                                                            |
| string | field `length`; `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`, `lower`, `replace(pattern, repl)`, `repeat`, `reverse`, `slice(start,end?)`, `split(sep,n?)`, `startsWith`, `title`, `trim`                                                          |
| number | `abs`, `ceil`, `floor`, `isEmpty`, `round(digits)`, `toFixed(precision)`                                                                                                                                                                                              |
| list   | field `length`; `contains`, `containsAll`, `containsAny`, `filter`, `flat`, `isEmpty`, `join(sep)`, `map`, `reduce(expr, acc)`, `reverse`, `slice`, `sort`, `unique`                                                                                                  |
| link   | `asFile()`, `linksTo(file)`                                                                                                                                                                                                                                           |
| url    | all string functions, nothing URL-specific                                                                                                                                                                                                                            |
| file   | fields `name basename path folder ext size properties tags links ctime mtime`; `asLink(display?)`, `hasLink(file\|string)`, `hasProperty(name)`, `hasTag(...)`, `inFolder(folder)`                                                                                    |
| object | `isEmpty`, `keys`, `values`                                                                                                                                                                                                                                           |
| regexp | `matches(str)`                                                                                                                                                                                                                                                        |

`file.hasTag` matches nested tags (`#a/b` matches `a`) and is any-of (H:functions). Frequency in V [C]: `if` 194, `date(...)` 58, `today()` 39, `.inFolder` 41, `.hasTag` 17, `.format` 17, `.contains` 9, `.hasLink` 6, `link(file.path, title)` 5, `.startsWith` 1, `.length` as a field. Not seen in V at all: list functions `map/filter/reduce/unique/sort/join`, `number()`, `max/min`, `file()`, `asFile()`, linked-note lookups. They remain in scope because the docs feature them, but real-world priority is low.

Undocumented-but-used [C]: global `len(x)` (8 uses) and `length(x)` (2 uses). H documents only the `.length` field. These are probably authored by tooling and very likely evaluate to an error in Obsidian [U]; Writer must treat unknown functions as a visible error (4.2.3), not implement them speculatively.

### 2.6 Views and per-view options

- Table [D]: row per file, column per property; Row height short|medium|tall|extra tall; per-column summaries; cell edit, copy/paste/undo, keyboard navigation (H:table). Real keys: `columnSize`, `rowHeight` [C].
- Cards [D]: Card size, Image property (local attachment link, URL, or hex color), Image fit cover|contain, Image aspect ratio default 1:1 (H:cards). Real key: `cardSize` [C]; others [U].
- List [D]: Markers bullets|numbers|none, Indent properties (first property is the primary item), Separators (default comma) (H:list). Keys [U].
- Kanban [D, 1.14]: requires groupBy; moving a card updates the grouped property (or moves the file when grouped by `file.folder`); settings column width, image property/fit/aspect (H:kanban). Keys [U].
- Map [D]: Maps plugin required; coordinates `"lat, lng"` text or 2-item list; icons and colors from properties/formulas (H:map). Keys [U].
- Toolbar [D]: view menu, Results (limit, copy to clipboard, **Export CSV**), Sort, Group, Filter (All views / This view, advanced code editor), Properties (including add formula), Search, New (H:views). Multiple sorts, one groupBy; group order Auto or Manual; collapsible groups in table/cards/list (H:views).

### 2.7 Embeds

`![[File.base]]` embeds the first view; `![[File.base#View]]` selects a view by name; a ` ```base ` fenced block contains the YAML (H:views, H:create). In V: 1 note embeds a base with `#View Name` [C]; 0 fenced blocks; 0 Canvas embeds. Row limits or max height inside an embed: [U].

### 2.8 Plugin API (D, G)

`registerBasesView(id, {name, icon, factory(controller, containerEl) => BasesView, options(config) => BasesAllOptions[]})` returns `false` if Bases is disabled (D, since 1.10.0). A `BasesView` implements `onDataUpdated()`; `this.data` is a `BasesQueryResult` (`data`, `groupedData`, `properties`, `getSummaryValue`) that is replaced on every change, so views must not retain it or its `BasesEntry` objects; `this.config` is a `BasesViewConfig` (`get`, `getAsPropertyId`, `getEvaluatedFormula`, `getOrder`, `getSort`, `getDisplayName`, `set`) (D, G). Option controls: dropdown, file, folder, formula, multitext, property, slider, text, toggle, group; values are stored in the view's YAML entry under the option `key` (D). `QueryController` and `FormulaContext` are opaque in the d.ts; their internals are [U] and Writer supplies its own.

### 2.9 UNKNOWN list and how to resolve each

All resolved by black-box experiments in a scratch vault using the real Obsidian (section 6.3), recording UI behavior or the documented Export CSV output. No code reading.

| #   | Unknown                                                                                                                                   | Resolution                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| U1  | Meaning of top-level `name:`                                                                                                              | open such a file, change it, observe title/tab/embed; default: preserve, ignore                            |
| U2  | `Count` summary semantics (all types?)                                                                                                    | fixture with text/number/date/null columns, summarize Count, observe                                       |
| U3  | Duration fields (`.days` etc.), rounding, sign                                                                                            | fixture comparing `(today()-date("2020-01-01")).days` with known gap; also `.hours`, `.minutes`, `.years`? |
| U4  | Unknown functions (`len`, `length(x)`) and any error: what is shown in a cell, in a filter, whether the filter row passes/fails           | fixture with deliberate errors; export CSV                                                                 |
| U5  | Referencing a bare name with a space or hyphen; `creation_date` vs `creation date`                                                        | fixture                                                                                                    |
| U6  | YAML keys for cards/list view options (image, fit, aspect, markers, indent, separator), kanban, map                                       | create each view in UI, set options, read the saved YAML                                                   |
| U7  | Sort semantics: mixed types, null placement, case sensitivity, locale; stability                                                          | fixture with mixed columns, export CSV                                                                     |
| U8  | Ordering of groups (auto) and of rows inside a group                                                                                      | fixture                                                                                                    |
| U9  | Date parsing coercions: `date("2024-01-05")`, `date()` on a datetime string, ISO with `T`, timezone, plain date strings compared to dates | fixture                                                                                                    |
| U10 | `date.format` Moment tokens supported (`YYYY-MM-DD`, `ddd`, `MMM D`, `HH:mm`)                                                             | fixture with a token matrix                                                                                |
| U11 | `file.hasTag` case sensitivity and whether inline `#tags` in code blocks count                                                            | fixture                                                                                                    |
| U12 | `==` between string and number, null propagation (`null + 1`, `null.length`), truthiness of `0`, `""`, `[]`                               | fixture matrix                                                                                             |
| U13 | `values.mean()` and other list statistics in custom summaries (docs example uses `mean`, functions page lacks it)                         | fixture                                                                                                    |
| U14 | `file.hasLink(x)` resolution rules (path vs name; frontmatter links; embeds)                                                              | fixture                                                                                                    |
| U15 | `this` for `base` code blocks in notes and in sidebar; relative links                                                                     | fixture                                                                                                    |
| U16 | Row limit/height behavior of embeds                                                                                                       | fixture                                                                                                    |
| U17 | Which files count as "all files": hidden folders, `.obsidian`, attachments, files in excluded folders                                     | fixture                                                                                                    |
| U18 | Link resolution (shortest path, ambiguity), alias handling, case-insensitivity                                                            | fixture with duplicate names                                                                               |
| U19 | Property type resolution when `.obsidian/types.json` disagrees with a value's YAML type                                                   | fixture                                                                                                    |
| U20 | Behavior when a formula references a missing property/formula or has a cycle                                                              | fixture                                                                                                    |

## 3. Real-world usage findings (the user's vault)

Found at one location (not recorded here). Studied read-only; no content copied.

### 3.1 Size

| Metric                                        | Value                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Markdown notes (excluding dependency folders) | 2,580 (about 18 MB), 774 folders, up to 8 levels deep                                                     |
| Biggest folder                                | about 136 notes                                                                                           |
| All files                                     | 6,938 (the bulk is JS/TS inside a dependency folder; ignore rules matter)                                 |
| Wikilinks                                     | about 30,000                                                                                              |
| Tasks (`- [ ]`)                               | about 2,300                                                                                               |
| Inline `#tags`                                | about 600                                                                                                 |
| Notes with frontmatter                        | 2,285 (89%); 4 unparsable                                                                                 |
| Notes using Dataview blocks                   | 421 (out of scope, noted)                                                                                 |
| `.base` files                                 | 27 (one trivial 39-byte default, one 10.7 KB), in 7+ top-level areas                                      |
| Embeds of bases in notes                      | 1 (`![[x.base#View]]`); 0 fenced `base`; 0 in Canvas                                                      |
| Core plugin `bases`                           | enabled (`core-plugins.json`)                                                                             |
| `.obsidian/types.json`                        | present: declares property types (checkbox 30, text 17, multitext 9, number 8, date 5, aliases 1, tags 1) |

Sizing consequence: this vault indexes in well under a second; the 10k-note target (4.1.8) gives a 4x margin.

### 3.2 `.base` shapes

- 27 files, 125 views: 109 table, 16 cards. No list, kanban, map.
- 26/27 have `filters`; 87 `and` groups, 5 `or`, 0 `not`. All global filters are `and`; most contain `file.inFolder(...)` (25) plus `file.ext == "md"` (24) to exclude attachments, which confirms "a base with no filter returns every file".
- 25/27 have `formulas` (261 expressions across filters/formulas/summaries). Formulas are overwhelmingly `if(prop, <expr>, "")` guards (194 `if`), date math `(today() - date(prop)).days` and `.format(...)`, nested `if` ladders up to 7 deep mapping status to label/emoji/score, and `link(file.path, title)`.
- Bare property names dominate: `order` entries 317 bare, 201 `formula.`, 73 `file.`; none use `note.`. Sort entries: 71 views, 1-2 keys each, ids bare/`formula.`/`file.mtime`.
- 51 views use `groupBy` (31 ASC, 20 DESC), including grouping by a formula and by a list property (`tags`).
- 76 views use `summaries`, nearly all `file.name: Count` (75). Row limits: 6 views. Column widths: 19 views. One `rowHeight`, two `cardSize`.
- Display names: 245 `properties.*.displayName`, no other property setting.
- Quality issues present in real files (must be handled gracefully): a formula refers to `creation_date` while the property is `creation date`; `len(...)`/`length(...)` calls; formulas that reference list-valued properties as scalars; a `date(date)` call where a property is named `date` (shadowing a function name is legal because properties are a separate namespace).

### 3.3 Frontmatter (2,285 notes, 243 distinct property names)

| Aspect                              | Finding                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Properties per note                 | mean 6.7, median 6, max 27                                                                                                                                                      |
| Value types (count of values)       | text 6,395; date 3,064; list 2,970; list-of-wikilinks 1,087; single wikilink 690; number 660; null 231; checkbox 172; nested object 45; datetime 13                             |
| Dates                               | almost all unquoted `YYYY-MM-DD` (parsed as dates by YAML); a handful of quoted strings and `T`-datetimes; some date-like properties are text in some notes and dates in others |
| Names with mixed types across notes | 46 of 243 (so typed per-property columns are unusable; types are per value)                                                                                                     |
| Tags                                | in `tags`: 1,024 arrays, 348 comma/space strings, 10 null; 751 arrays use nested `a/b` tags; 3 arrays with `#` prefix                                                           |
| Aliases                             | 47 notes                                                                                                                                                                        |
| Property names with spaces          | present (e.g. a two-word date property)                                                                                                                                         |
| Link-valued properties              | 306 notes with a single wikilink owner-like property; lists of wikilinks common (`related`, `collaborators`, `sources`)                                                         |

Consequences: the index must store the value type per value; the evaluator needs the same coercion tables Obsidian applies (strings that look like dates, comma-separated tags, scalars where lists are expected); link detection inside lists matters; `.obsidian/types.json` is a hint for the editor (cell type) and for coercion [U19].

## 4. Architecture proposal

### 4.1 Vault index (Rust, SQLite)

#### 4.1.1 Why

The current in-memory `Vec<IndexedFile>` (`state.rs`: `path`, `relative_path`, `name`, `modified_at`) built by `index_workspace_impl` (`commands/search.rs`, only `.md`) serves fuzzy file search. Bases needs content-derived data (properties, tags, links), reverse lookups (backlinks) and sort/filter over thousands of rows without reparsing. Tags already planned in [tags-spec.md](./tags-spec.md) ("Index tags per file in the existing workspace index"): this index subsumes it.

#### 4.1.2 Storage choice: SQLite via `rusqlite` (feature `bundled`), hybrid property model

Decision: **EAV-with-typed-shadow-columns plus a JSON document per file**, not one JSON column only and not typed columns per property.

- Per-property typed columns are impossible: property names are an open set (243 in this vault) and 46 of them carry mixed types.
- JSON1-only (`json_extract` on a blob) has no useful index for "all notes where `status != 'done'` sorted by `due`" and needs a table scan per query. At 10k notes a scan with `json_extract` is tens of ms, acceptable, but it gives no key-level index and no cheap `file.hasLink`/`tags` joins.
- EAV rows `(file_id, key, type, v_text, v_num, v_date)` indexed on `(key, v_num)`, `(key, v_text)`, `(key, v_date)` give exact pushdown for common filters and sorts; the raw JSON per file (`fm_json`) keeps full fidelity for the evaluator and for `file.properties`.

Both are written in the same transaction from one parse of the frontmatter.

#### 4.1.3 Schema sketch (schema_version = 1)

```sql
meta(key TEXT PRIMARY KEY, value TEXT);           -- schema_version, workspace_root, built_at
files(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE,        -- relative, forward slashes
  name TEXT, basename TEXT, ext TEXT, folder TEXT,
  size INTEGER, ctime INTEGER, mtime INTEGER,
  fm_json TEXT, fm_error TEXT, body_hash INTEGER   -- fm_json NULL for non-markdown
);
CREATE INDEX files_folder ON files(folder); CREATE INDEX files_ext ON files(ext); CREATE INDEX files_base ON files(basename COLLATE NOCASE);
props(                                              -- one row per top-level key per note
  file_id INTEGER, key TEXT, vtype TEXT,            -- text|number|bool|date|datetime|list|object|null|link
  v_text TEXT, v_num REAL, v_date INTEGER,          -- shadow scalar columns; lists use prop_items
  PRIMARY KEY(file_id, key)
);
CREATE INDEX props_text ON props(key, v_text); CREATE INDEX props_num ON props(key, v_num); CREATE INDEX props_date ON props(key, v_date);
prop_items(file_id INTEGER, key TEXT, idx INTEGER, vtype TEXT, v_text TEXT, link_target TEXT);  -- list members
CREATE INDEX prop_items_kv ON prop_items(key, v_text);
tags(file_id INTEGER, tag TEXT, source TEXT);       -- source: body|frontmatter; also stores each ancestor for nested tags
CREATE INDEX tags_tag ON tags(tag);
links(src_id INTEGER, raw TEXT, target_path TEXT NULL, kind TEXT, in_fm INTEGER, display TEXT, subpath TEXT);
CREATE INDEX links_src ON links(src_id); CREATE INDEX links_target ON links(target_path);   -- backlinks = WHERE target_path = ?
tasks(file_id INTEGER, line INTEGER, status TEXT, text TEXT);   -- cheap by-product of the same scan; optional in v1
```

Rules:

- All files in the workspace (not only `.md`) get a `files` row so `file.*` filters work on attachments (H:syntax "file properties available for all file types"); only Markdown is parsed for content. Ignore rules reuse `ignore.rs` (`.gitignore`, `node_modules`, `.git`); the Obsidian config folder stays excluded from `files` (U17 decides whether Obsidian lists it).
- Tags: normalize and also insert ancestors (`a/b` also stores `a`), so `file.hasTag("a")` is an indexed equality. Case handling per U11. Tag extraction rules reuse tags-spec (skip code, frontmatter handled via the `tags` key including comma strings).
- Links: wikilinks and markdown links in body and frontmatter, embeds flagged. `target_path` is resolved after the file set is known and re-resolved when files are created/renamed/deleted (resolution: exact path, else unique basename, else shortest-path/nearest-folder tie-break pending U18). Unresolved links keep `target_path NULL` and resolve lazily.
- Types are coerced at write time with the rules from U9/U12/U19 once known; until then the raw JSON is authoritative and `v_*` columns are only used for conservative pushdown (4.2.2).

#### 4.1.4 Location, versioning, rebuild

- DB file in the app data directory, keyed by a hash of the canonical workspace root: `<app_data_dir>/index/<sha256(root)[0..16]>.sqlite3`. The vault stays clean (no `.writer` folder). Matches the existing use of `app_data_dir` in `updater.rs` and `telemetry.rs`.
- `meta.schema_version` plus a parser version string; on mismatch or corruption the file is deleted and rebuilt. The index is a cache: deleting it is always safe.
- Open uses WAL (`journal_mode=WAL`, `synchronous=NORMAL`).

#### 4.1.5 Incremental updates

- Cold build: reuse the parallel walker from `index_workspace_impl`; results flow to the indexer thread as batches of up to 200 files per transaction. Read file content in the walker threads, parse frontmatter/tags/links there (pure functions), send parsed rows to the writer.
- Warm open: load `(path, mtime, size)` from `files`, diff against the walk, reparse only changed/new, delete missing. Comparison by mtime and size; `body_hash` guards against mtime-only changes.
- Live: the watcher (`watcher.rs`, 300 ms debounce, self-write detection via `record_write`) forwards each debounced event batch to the indexer, which reparses those paths. The existing watcher ignores non-`md`; it must forward all non-ignored file events for `files` rows (4.4).
- The frontend is notified through a Tauri event `index://changed {epoch, paths}`; the workspace `epoch` already used by `FileChangeEvent` guards stale batches from a previous workspace.
- Unsaved editor buffers are not indexed; on save the self-write path triggers a reindex of that file. Queries are therefore consistent with disk.

#### 4.1.6 Concurrency model

One writer thread owns the single write connection (`parking_lot` + channel of index jobs). Read commands use a small pool (2-4) of read-only WAL connections; they never block on the writer. The cancellation token pattern from `index_workspace_impl` (`Arc<AtomicBool>` plus workspace epoch) applies: a workspace switch cancels the walk and drops the connection. IPC commands are async and run queries on `spawn_blocking`.

#### 4.1.7 Backing the plugin host's `MetadataCache`

`src/lib/obsidian-host/api/vault.ts` implements `MetadataCache` in TS (`parseNoteMetadata`, `resolvedLinks`, `unresolvedLinks`, sync `getFileCache`). The d.ts API is synchronous, so SQLite cannot be called per access. Decision: the TS cache stays as the synchronous façade, but is hydrated in bulk from the index (`index_get_metadata(paths | all)` returning frontmatter, tags, links, headings if stored) at host start and updated from `index://changed`. This removes the duplicate parse and gives plugins consistent `resolvedLinks`. Memory: a few KB per note, fine at 100k. Heading/section positions (`CachedMetadata.headings/sections`) are not in v1 of the schema and keep the current TS parse on demand.

#### 4.1.8 Performance targets (to be measured; assumptions stated)

Assumptions: Apple-silicon laptop, notes average 7 KB, 7 properties per note, 12 links per note.

| Scenario                                                                   | Target                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| Cold index, 10k notes (parallel read and parse, batched inserts)           | under 4 s, UI usable immediately (progress event) |
| Cold index, sample vault (2.6k notes)                                      | under 1 s                                         |
| Warm open (diff only) 10k notes                                            | under 400 ms to first query                       |
| Incremental reindex of one saved note                                      | under 10 ms                                       |
| Filter + sort query over 10k notes returning 500 rows (SQL pushdown)       | under 50 ms                                       |
| Same, JS verification of survivors (typical 5 expressions, 10k candidates) | under 150 ms                                      |
| Table render, 10k rows virtualized, scroll                                 | 60 fps; first paint under 100 ms after data       |
| DB size                                                                    | under 30 MB per 10k notes                         |

### 4.2 Parser and evaluator

#### 4.2.1 Location: TypeScript is the semantic reference; Rust does fast-path filtering only

Options:

|                                                         | Rust evaluator                                  | TS evaluator (recommended)                         |
| ------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| Near the data                                           | yes, no row transfer                            | rows cross IPC (small: only referenced properties) |
| Plugin API needs JS `Value`/`BasesEntry` objects        | needs a second JS model anyway                  | single implementation shared with plugin views     |
| Moment-style `format`, regexp literals, lambda closures | must re-implement (regex crate differs from JS) | native `RegExp`, small Moment-token formatter      |
| Testing                                                 | `cargo test`                                    | `vp test`, property-based tests easy               |
| Edit-in-place and `this`/embeds                         | need to round-trip results back                 | already in the UI layer                            |

Decision: the `.base` parser (YAML to typed config with unknown-key preservation, using the `yaml` Document API already in the repo, `yaml ^2.8`), the expression lexer/parser/AST and the interpreter live in TypeScript (`src/lib/bases/`). The Rust side provides: (a) the index, (b) a **filter pushdown compiler** that turns a conservative subset of the AST into SQL, (c) data commands. The AST is serialized as JSON to Rust, so there is one grammar (TS) and Rust never parses expressions.

#### 4.2.2 Query pipeline

1. TS parses the base, builds per-view effective filter = global AND view.
2. TS partitions the filter AST: pushdown-safe conjuncts vs the rest. Pushdown-safe: boolean tree over `file.inFolder/ext/name/basename/path/folder/size/ctime/mtime`, `file.hasTag(const...)`, `file.hasLink(const)`, comparisons of `note.X` against constants (`== != < > <= >=`, `== null`, `!= null`, `.contains(const)` on lists and strings, `startsWith`), `today()`/`now()` arithmetic with constants evaluated in TS and passed as parameters.
3. Rust compiles pushdown conjuncts to a parameterized SQL **superset**: whenever type ambiguity exists (mixed types for a key, U12 coercions), the clause is widened or dropped. Rust returns candidate file ids plus the property bag needed (properties referenced anywhere in the base plus `file.*` columns).
4. TS verifies **every** candidate with the full interpreter against the complete filter. Correctness never depends on SQL; SQL only prunes. A differential test (6.2) asserts `interpret(all rows) == interpret(SQL candidates)`.
5. TS evaluates formulas for the shown properties (lazy per visible row for formulas not used in filter/sort/group; eager for those used), sorts, groups, applies `limit`, computes summaries.
6. `file.backlinks`, `file.links`, `file.embeds`, `file.properties`, `file.tags` are fetched on demand per candidate set via `index_links(file_ids)`. `file.backlinks` is only fetched when an expression references it (H marks it slow; the index makes it a lookup on `links(target_path)`).

#### 4.2.3 Error model

Errors are values, not exceptions: `ErrorValue {kind, message, span}` propagates through arithmetic and calls; `if` does not swallow them. Kinds: `Syntax` (at load; with column span), `UnknownIdentifier` (property namespaces are open, so a missing property is `null`, not an error), `UnknownFunction`/`UnknownMethod`, `Type` (e.g. `"a" - 1`), `Circular` (formula cycle, detected before evaluation), `Runtime` (bad regex, `number("x")` per H:functions "invalid numeric string -> error").

Display defaults (to confirm via U4/U20): a cell holding an error shows an error badge with the message in a tooltip; an invalid filter makes the view show a banner "Filter error: ..." and zero rows (fail explicitly per the repo guardrails); an invalid formula only affects its column; an invalid `.base` YAML shows the raw text with the parser error, editable. Real files in the sample vault already contain invalid expressions (`len(...)`), so this path is exercised on day one.

### 4.3 UI

#### 4.3.1 Page kind for a `.base` tab

Add `page-kinds/base.ts` (`kind: "base"`, `{path}` payload, `keepAlive: true`, same `paths/primaryPath/rewritePath/removePath/serialize` shape as `file.ts`) and one entry in the `kinds` array of `page-kinds/index.ts`, and the view in `views.tsx`. Opening routes by extension in `link-navigation.ts` and the file-open entry points (4.4). Session restore works unchanged because `serializeLocation`/`deserializeLocation` are registry-driven.

#### 4.3.2 Table view first

- Virtualized rows (no virtualization library in `package.json` today; add `@tanstack/react-virtual` or a small windowing hook; decision in Phase 1). Fixed row heights for short/medium/tall/extra tall; sticky header; sticky group headers; collapsible groups.
- Columns from `order` (default: `file.name`); widths from `columnSize`; header names from `properties.*.displayName`; summaries row from view `summaries`.
- Renderers per value type: text, number, date (format per user locale; raw preserved), checkbox, list as chips, link (opens note), URL, tags, error badge.
- Toolbar: view switcher, Sort/Group/Filter/Properties menus. Phase 1 ships only the view switcher and a read-only "Edit YAML" action; menus arrive progressively (phase 3/4).

#### 4.3.3 Edit cell, write frontmatter back

Findings: `lib/frontmatter.ts` splits raw text into frontmatter and body (`parseFrontmatter`/`serializeFile`); the existing properties panel uses `yaml-entries.ts`, whose `serializeYamlEntries` re-stringifies the whole object with `stringify(...)`, **which drops comments and rewrites scalar styles**. It must not be used for cell edits.

Decision: a new `patchFrontmatter(raw, key, value)` in `src/lib/` using `yaml`'s `parseDocument` + `doc.set(key, value)` + `String(doc)`, which keeps comments, key order and untouched nodes' styles. Types: use the cell's type (from the existing value, else `.obsidian/types.json`, else inferred) to emit dates as unquoted `YYYY-MM-DD`, lists as block sequences, links as quoted `"[[...]]"`. Edits go through the same save path as the editor (`save.ts`, `record_write` self-write marking) and, if the note is open in a tab, through the open document's buffer, so unsaved edits are never clobbered; if the note has unparsable frontmatter the cell is read-only with a reason. Undo: per-cell edit stack in the view (Cmd+Z per H:table), implemented as inverse patches.

#### 4.3.4 Embeds in the CodeMirror editor

Follow `docs/editor.md` block-widget rules. Shape: **conditional replace ↔ source**. For `![[x.base#View]]` (an inline-looking embed) and ` ```base ` fences, `Decoration.replace` over the node when the selection does not touch it and `Decoration.widget(...).range(node.to)` when it does, as in `fold/image.ts`, driven by `selectionTouchesRange`; enter source-edit via the range-select pattern, not caret placement; handle `posAtDOM` boundaries with `resolveInner` on both sides; every in-widget button gets `mousedown.preventDefault()`; the editor-level drag-selection gate must filter on `.cm-base-embed`; include `view.scrollSnapshot()` on shape switches. The widget mounts a React root (`createRoot`) per widget, keeps `estimatedHeight` truthful (rows x row height, capped), calls `view.requestMeasure()` when data settles, and caps the embedded table at a max height with its own scroll (U16 may refine). `this` = the embedding note. Decorations are built from `renderedRanges(view)` only. Embedded views are read-only in Phase 5, interactive editing follows.

### 4.4 File-type plumbing

What changes so `.base` files appear and open (all currently hardcode `md`):

- `commands/fs.rs`: `read_directory` lists only `.md` (`is_markdown` flag in `DirEntry`, `markdown_file_entry`, `dir_contains_markdown`/`dirs_with_markdown`); introduce a file-kind classification (`markdown | base | other`) and list `.base` as an openable file; folders containing only `.base` files must not be filtered out. Add `kind` alongside `is_markdown` and migrate callers (consolidation rule: one source of truth for "what is openable").
- `commands/search.rs` `index_workspace_impl` and `state.rs` `IndexedFile`: include `.base` in the file index so quick-open finds them; the SQLite index (4.1) covers all files.
- `watcher.rs`: forwards events for `.base` (self-write detection applies when Writer saves one).
- Frontend: sidebar icon and label for `.base`; `link-navigation.ts` resolves `[[x.base]]` and opens the `base` page kind; new-file menu gets "New base" (a template: `views:\n  - type: table\n    name: Table\n`, mirrors the 39-byte default seen in the sample vault); tab title strips `.base` or keeps it (default: strip, like notes); rename/delete flows already operate by path.
- `wiki-links.ts`, `wiki-link-extension.ts`: allow `.base` targets in autocomplete and the embed syntax with `#View` subpath.
- Path containment (`authorize_path`) applies unchanged; the index DB lives outside the workspace and is accessed only by Rust.

### 4.5 Migration and compatibility

- **Round trip**: the `.base` is parsed into a `yaml` `Document`; the typed view of the config is derived from it; edits (view rename, reorder, limit) mutate the Document with `setIn`. Unknown keys at every level (`name`, `columnSize`, plugin view keys) survive because they are never copied into a typed model and back. Comments and key order are preserved by the Document. Writing happens only on an explicit user config change; never on open, scroll, or view switch (success criterion 4). A save with no semantic change is skipped by comparing the serialized output with disk.
- **Unknown view types** (kanban/map/plugin) render a "view not available" placeholder that keeps the YAML untouched and offers raw edit.
- **Import path**: none required; a vault is already the data. Detect `.obsidian/core-plugins.json` (`bases: true`) and `.obsidian/types.json` to seed property types; surface a one-time info banner "Bases found: N files" in the sidebar. No writes to `.obsidian`.
- **Concurrent use with Obsidian**: Writer never writes to `.obsidian`; both apps may edit the same `.base`/notes. The external watcher already reloads changed files; a `.base` open in a tab reloads on external change when clean, and shows the existing external-change notice when dirty.

### 4.6 Plugin API: `registerBasesView`

`src/lib/obsidian-host` currently returns `false` from `registerBasesView` (README note). Target semantics, from D/G:

- Returns `true` when Writer's Bases is enabled (default on) and registers the view type in the same registry that built-in views use (one registry: built-in table/cards/list register through the same function, per [consolidation.md](../docs/consolidation.md)).
- Factory receives a `QueryController` (Writer implementation, opaque to plugins) and a container element; the host creates the `BasesView` instance, calls `onDataUpdated()` after every data/config change (coalesced per animation frame), and replaces `this.data` with a fresh `BasesQueryResult` each time.
- `BasesEntry.getValue(id)` returns `Value` objects; the interpreter's value classes implement the public `Value` shape (`StringValue`, `NumberValue`, `LinkValue`, ...), so plugin code and built-in code share one model.
- Option controls (`dropdown`, `file`, `folder`, `formula`, `multitext`, `property`, `slider`, `text`, `toggle`, `group`) render in Writer's view-settings popover and persist into the view's YAML entry under `key`; `config.getEvaluatedFormula(view, key)` runs through the interpreter with `this` set per 2.2.
- Unregistered `type` in a file shows the placeholder (4.5). Hover link, `openLinkText` and `createFileForView` map onto Writer's existing open/new-note flows.

## 5. Phased plan

Sizes: S = 1-3 days, M = 4-8, L = 9-15 (one engineer, includes tests).

| Phase                     | Scope                                                                                                                                                                                                                                                                                                                                                                               | Size | Depends on                                  | Acceptance tests                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Indexing                | `rusqlite` bundled; schema 4.1.3; cold build, warm diff, watcher feed, `index://changed`; commands `index_status`, `index_query_files`, `index_get_metadata`; tags and links (backlinks via `links`); file-type classification (4.4); rebuild on schema bump                                                                                                                        | L    | plugin-host Phase 0 path containment (done) | `cargo test`: build on fixture vault gives expected row counts; touch/rename/delete reflected within 1 s via the watcher; kill-and-reopen warm path reparses only changed files; corrupt DB triggers rebuild; 10k-note synthetic vault meets the 4.1.8 cold/warm targets; MetadataCache hydrated from index equals the current TS parse on the fixture set |
| 1 Read-only table         | `.base` parser (TS) with Document round-trip; filter/expression parser and interpreter for the Phase-1 subset (comparisons, `if`, `date`, `today`, `.format`, `.days`, string/list basics, `file.*`); pushdown compiler for inFolder/ext/hasTag/comparisons; `base` page kind; virtualized table; groupBy; sort; limit; displayName; columnSize; summaries incl. Count; error model | L    | 0                                           | All 27 sample-shape fixtures open; non-erroring views match black-box CSV exports (section 6.3) for rows and order; invalid expressions show badges; `.base` unchanged byte-for-byte after any viewing action                                                                                                                                              |
| 2 Filters/formulas parity | full documented function set (2.5), regexp, lambdas (`value/index/acc`), linked-note lookups (`asFile().properties`), `file.backlinks`, `this`, durations, Moment `format`, custom summaries (`values`), property-based tests, differential SQL-vs-interpreter test                                                                                                                 | L    | 1; U-items U3,U7,U9,U10,U12,U13 resolved    | Golden suite 100% where ground truth exists; property tests (6.2) pass 10k cases; documented examples from H run verbatim and produce the documented values                                                                                                                                                                                                |
| 3 Edit in place           | `patchFrontmatter`; cell editors per type; checkbox toggle; clear cell (Backspace); copy/paste cells; undo/redo; open-buffer coordination; read-only reasons                                                                                                                                                                                                                        | M    | 1                                           | Diff test: only target key lines change (comments, order, quoting preserved) on 20 fixture notes; edit while note open and dirty does not lose edits; watcher self-write does not loop; undo restores exact bytes                                                                                                                                          |
| 4 Cards, list, config UI  | cards view (cardSize, image property/fit/aspect per U6), list view, view menu (add/rename/reorder/delete views), sort/group/filter/properties menus with "Edit YAML" escape hatch, Results menu (limit, copy, CSV export), `registerBasesView` host + option controls                                                                                                               | L    | 2, U6 resolved                              | Cards/list fixtures match black-box screenshots/exports; plugin sample view from G renders and updates on vault change; saving config preserves unknown keys (golden diff)                                                                                                                                                                                 |
| 5 Embeds                  | CM block widget for `![[x.base]]`, `![[x.base#View]]`, ` ```base ` blocks; `this` = embedding note; height management; read-only first                                                                                                                                                                                                                                              | M    | 1, 2                                        | `docs/editor.md` checklist (selection enter/leave, no scroll jump, drag gate, buttons); embed at doc top/bottom/inside lists; 5 embeds in one note stay responsive; `#View` resolves case-insensitively per U-check; playground reproduction                                                                                                               |
| Later                     | Kanban (needs write-back to grouped property and `file.folder` move), Map, `$`-less formula editor autocomplete, full filter builder, Dataview interop                                                                                                                                                                                                                              | -    | 4                                           | -                                                                                                                                                                                                                                                                                                                                                          |

## 6. Test strategy

### 6.1 Golden-file suite

- Location: `apps/desktop/src/lib/bases/__fixtures__/` (TS) mirrored for Rust index tests.
- Anonymized `.base` files that preserve the structure of real ones (generic names such as `status`, `due`, `owner`), plus a fixture vault of about 150 synthetic notes covering: mixed-type properties, comma tags, nested tags, unquoted/quoted/`T` dates, lists of wikilinks, duplicate basenames in different folders, spaces in property names, null/empty values, nested objects, attachments, notes with unparsable frontmatter.
- Each fixture has `expected.csv`/`expected.json` (rows, order, groups, summaries) generated from real Obsidian by the black-box procedure (6.3), plus a "clock" file fixing `now()`.
- The evaluator takes an injected clock; all `today()`/`now()` tests use it.
- Runner: parse, query, compare; also asserts `.base` bytes unchanged and no writes.

### 6.2 Property-based and differential tests

`fast-check` (new dev dependency) for the interpreter: (1) parser round trip (`parse(print(ast)) == ast`); (2) no throw on arbitrary strings, only `Syntax` errors; (3) algebraic laws on documented operators (`a == a`, `!!x` truthiness, `list.reverse().reverse()`, `x.slice` bounds, `unique` idempotent); (4) date arithmetic invariants (`(d + "1d") - d == duration 1d`); (5) differential: `interpret(filter, allRows) == interpret(filter, sqlCandidates)` over random filter trees from the pushdown subset and random mixed-type property bags; (6) YAML patch: `patchFrontmatter` then reparse equals original object with only the key changed, and a second identical patch is a no-op.

### 6.3 Black-box ground truth from real Obsidian (user procedure)

No code reading; only use the app as a user.

1. Create a scratch vault (File > Open another vault > Create new), enable Bases (Settings > Core plugins).
2. Copy in the fixture vault notes from the repo fixtures folder (plain `.md` files).
3. Copy in one fixture `.base` at a time (or paste into a new base via the advanced editor), open it, and for each view: results menu (the table toolbar button "Results") > **Export CSV** (documented in H:views), save as `<fixture>__<view>.csv`. Also use **Copy to clipboard** and paste into a text file for a second check.
4. For summaries, groups and error cells, take a screenshot and note the values (CSV may omit them); record in `expected.md` next to the fixture.
5. For the U-list (2.9), use the dedicated "probe" fixtures: one `.base` per question, each with a column per variant (for example, one column per `date.format` token, one per coercion pair), so a single export answers a whole row of the table.
6. For `today()`/`now()`, avoid relying on today: use comparisons with dates far in the past/future, and record the export date so the clock file can be set.
7. Commit the CSVs; tests treat them as truth. When Obsidian updates and behavior changes, rerun the probes and diff.

## 7. Risks and open questions

Recommended defaults are in bold. Items needing a user decision are marked (Q).

1. **Unknown semantics (U1-U20).** Risk: wrong coercion or ordering vs Obsidian. Mitigation: probe fixtures (6.3) before Phase 2; until then follow the docs literally.
2. (Q) Scope of the first release. **Default: Phases 0-3 behind a "Bases (beta)" toggle, embeds after.**
3. (Q) Index scope: index all files or only `.md`+`.base`? **Default: all non-ignored files get a `files` row (needed for `file.*` filters and attachments), content parsed only for Markdown.**
4. (Q) Does the index replace the in-memory `Vec<IndexedFile>` used by quick-open? **Default: yes, in a follow-up after Phase 0 proves stable; keep both until then.**
5. (Q) Where an expression error appears in a filter, Obsidian's behavior is unknown. **Default: banner + zero rows for that view (fail explicitly), revisit after U4.**
6. (Q) Property edit scope: should editing a cell create a frontmatter block when missing, and which type when `types.json` is silent? **Default: create the block; infer type from the existing column's majority type.**
7. (Q) Dependencies: `rusqlite` (bundled SQLite, about 1 MB binary), a Rust YAML parser (`serde_yaml` is archived; use `yaml-rust2` or `saphyr`; confirm lenient behavior against the sample vault's 4 unparsable notes), a virtualization library, `fast-check`. **Default: approve all four.**
8. **Writer must not write into `.obsidian`.** Plugin settings and Bases never create files there. Confirm this also for the index (it lives in the app data dir).
9. Dataview coexistence: 421 notes in the sample vault use Dataview; users will expect it next. **Default: out of scope; separate spec.**
10. Link resolution differences (U18) affect `file.hasLink`, `file.backlinks`, `link()` equality. **Default: shortest-path rules from public Obsidian link docs, verified via probes.**
11. Date/time zones: frontmatter dates are timezone-less. **Default: interpret as local midnight; `now()` local; export CSV comparison fixes TZ in the clock file.**
12. Performance of `file.backlinks` and linked-note rollups at 10k+ notes. **Default: compute on demand only for visible/summarized rows, cache per index epoch, document as slow like Obsidian does.**
13. Embedded interactive editing inside the note editor (focus races with CM). **Default: read-only embeds in v1; "Open base" button.**
14. Index DB growth and privacy: the DB contains note properties, outside the vault. **Default: store under app data, delete on workspace removal, document in the privacy notes (no telemetry of contents).**
15. Plugin view isolation: third-party `BasesView` code runs in the main webview. **Default: gated by the plugin host's trust model (restricted mode, per-vault trust) from the plugins spec.**

## Files expected to change (when implemented)

Rust: `apps/desktop/src-tauri/Cargo.toml`, new `src/index/` (schema, writer thread, queries, pushdown), `src/state.rs`, `src/watcher.rs`, `src/commands/{fs,search}.rs`, new `src/commands/index.rs`, `src/lib.rs` registration. Frontend: new `src/lib/bases/` (parser, expression, interpreter, patch), `src/components/base-view/`, `src/components/editor-area/page-kinds/{base.ts,index.ts,views.tsx}`, CodeMirror `base-embed-decorations.ts`, `src/lib/obsidian-host/api/{vault.ts,views.ts}`, `link-navigation.ts`, `wiki-link*.ts`, sidebar file list. Docs: `docs/` note for the index and `CHANGELOG.md` per the repo rules.
