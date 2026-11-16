---
name: writer-bases
description: Read, query, create and edit Obsidian Bases (`.base` files, database-like views over notes and their properties) in a Writer vault. Use when the user mentions a .base file or "base", wants a table, list or cards view of notes filtered by properties, tags or folders, or asks to run a base view from the command line. Covers the `writer` base commands, the `.base` YAML structure and the formula and filter expression language.
---

# Bases in Writer

A base is a YAML file ending in `.base`. It defines a filtered, sorted, optionally grouped view of the vault's files (usually notes) as rows, with properties as columns. Writer runs bases with the same engine in the app and in the CLI. See the `writer-cli` skill for the general grammar.

## Commands

```
writer bases                                          # list .base files
writer base:views file=Tasks                          # view names, one per line
writer base:query file=Tasks view="Open tasks"        # run a view (json by default)
writer base:query path=Projects/Tasks.base format=md  # json, csv, tsv, md or paths
writer base:create file=Tasks view="Open tasks" name="New task"
```

- `file=Tasks` also finds `Tasks.base`; `path=` is the exact path and must end in `.base`.
- Without `view=` the first view runs. An unknown view, a filter error or invalid YAML is exit 1 with the message.
- `format=json` gives an array of objects keyed by column id with plain values (dates as ISO strings, links as paths). `csv`, `tsv` and `md` carry a header of display names and the cells as displayed. `paths` lists only the row files, which is the handy form for follow-up commands. Grouped views are flattened in group order.
- `base:create` creates a note in the folder of the view's `file.inFolder("...")` filter and sets `prop == literal` conditions as properties (and a single `file.hasTag("x")` as `tags`). Other filters are not satisfied by construction, so check the result with `base:query`.
- The CLI cannot create or overwrite a `.base` file (`create` always makes Markdown). Write `.base` files with normal file edits.

## Editing `.base` files

`.base` files are hand-editable YAML. Rules:

- **Preserve comments and key order.** Edit the text surgically (change the lines you need); never parse and re-serialize the whole file, which drops comments. Keep keys you do not understand: top-level `name`, view options such as `columnSize`, `rowHeight`, `cardSize`, `groupOrder`, and anything plugins added.
- Formula strings are always YAML strings; quote them (`'...'`) because they contain `:`, `"` and `#`.
- After an edit run `writer base:views` (parses the file) and `writer base:query` for the affected view to verify it.
- Changing a property's value in a note is done on the note (`writer property:set`), not in the base.

## File structure

```yaml
filters: # applied to every view, ANDed with each view's filters
  and:
    - file.inFolder("Projects")
    - file.ext == "md"
    - 'status != "done"'
formulas: # name -> expression, referenced as formula.<name>
  age_days: "(today() - date(created)).days"
properties: # per-column options, keyed by property id
  status:
    displayName: Status
  formula.age_days:
    displayName: Age (days)
summaries: # optional custom summaries over `values`
  avg2: "values.mean().round(2)"
views:
  - type: table # table, cards, list ... (table and cards are the common ones)
    name: Open tasks
    filters:
      and:
        - 'status != "done"'
    order: [file.name, status, formula.age_days]
    sort:
      - { property: due, direction: ASC }
    groupBy: { property: status, direction: ASC }
    limit: 50
    summaries:
      file.name: Count
```

- `filters` is a string expression, or `and:` / `or:` / `not:` with a list of filters (strings or nested groups). `not: [a, b]` means none of them hold. A base without filters lists every file in the vault, including non-Markdown files; add `file.ext == "md"` or `file.inFolder(...)` to narrow.
- Property ids: `note.x` or bare `x` is a frontmatter property; `file.x` is file metadata; `formula.x` is a formula of this base. Names with spaces or hyphens use `note["due date"]` inside expressions (a bare `a-b` is a subtraction). Property names are case-sensitive and a missing property is `null`.
- `order` lists the visible columns in order; `sort` is a list in priority order; `groupBy` takes one property; `limit` caps rows after grouping.
- Built-in summaries: `Count`, `Sum`, `Average`, `Min`, `Max`, `Range`, `Median`, `Stddev`, `Earliest`, `Latest`, `Checked`, `Unchecked`, `Empty`, `Filled`, `Unique`. A custom name from top-level `summaries` can be used the same way.
- Row source: every file in the vault index (Markdown and others), so filter by `file.ext` when you only want notes.

## Expression essentials

Filters and formulas share one language. Operators: `+ - * / %`, `== != > < >= <=`, `! && ||`, parentheses, `.` member access, `[ ]` indexing (lists are 0-based).

- File fields: `file.name`, `file.basename`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.tags`, `file.links`, `file.embeds`, `file.backlinks` (slow), `file.properties`.
- File functions: `file.inFolder("Projects")`, `file.hasTag("a", "b")` (any of; nested tags match their parent, a leading `#` is ignored), `file.hasLink(other)`, `file.hasProperty("x")`, `file.asLink()`.
- Globals: `if(cond, then, else?)`, `date(str)`, `now()`, `today()`, `duration(str)`, `link(path, display?)`, `list(x)`, `number(x)`, `min(...)`, `max(...)`, `file(path)`, `image(...)`, `icon(...)`, `html(...)`, `random()`.
- Strings: `contains`, `startsWith`, `endsWith`, `lower`, `title`, `trim`, `replace`, `slice`, `split`, `repeat`, `reverse`, `isEmpty`, `.length`. Lists: `contains`, `containsAll`, `containsAny`, `filter`, `map`, `reduce`, `join`, `sort`, `unique`, `flat`, `slice`, `reverse`, `.length`, plus `sum`, `mean`, `median`, `min`, `max`, `stddev`. Numbers: `abs`, `ceil`, `floor`, `round(digits)`, `toFixed(n)`. Dates: `.year .month .day .hour .minute .second`, `format("YYYY-MM-DD")`, `relative()`, `date()`, `time()`. Any value: `isTruthy()`, `isType()`, `toString()`.
- Inside `filter`, `map`, `reduce` the element is `value`, its position `index`, and `reduce`'s accumulator `acc`: `tags.filter(value.startsWith("a"))`.
- Dates: `date + "1M"`, `now() - "2h"` (units y, M, d, w, h, m, s); date minus date is a duration whose `.days`, `.hours`, ... are fractional numbers: `(today() - date(due)).days`. Bare dates are local midnight.
- Types do not coerce: `"1" == 1` is false, ordering a `null` or mixed types is false, `x / 0` is an error, and `+` with a string on either side concatenates. Unknown functions (for example `len()`) and bad types are errors: a filter error fails the whole view, a formula error shows in its own column only.
- Sorting puts `null` first ascending and last descending; strings compare case-insensitively.

More detail and the full function list: [references/expressions.md](references/expressions.md). Common recipes: [references/recipes.md](references/recipes.md).
