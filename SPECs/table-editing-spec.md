# Table editing spec

## Why

The user asked for the Obsidian "Advanced Tables" plugin's behaviour built in, with the best UX for
editing tables. The app must not depend on that plugin.

## Research

Advanced Tables (tgrosinger/advanced-tables-obsidian, MIT; read from its public README only, its
code is not used here). Public feature list: spreadsheet-like Tab / Shift+Tab / Enter navigation,
automatic formatting of markdown tables, column alignment (left, center, right), add / remove /
move rows and columns, sort by column, export to CSV, spreadsheet formulas, a table controls sidebar
(Ctrl+Shift+D) and many palette commands under "Advanced Tables". It warns that it is experimental
and may lose data. The README says nothing about pipes, wiki links or CSV paste; Writer decides
those below.

## Existing editor behaviour (before this change)

- `table-decorations.ts` folds a GFM `Table` node into a read-only rendered `TableWidget`; when the
  selection touches the table the widget goes away and the raw lines show as a monospace code-like
  block (`cm-table-source-line`). Caret in a table therefore always means "editing source".
- No cell navigation: Tab indented or did nothing, Enter split the line, pipes were never aligned.
- `insert.table` (Insert menu) inserts a 3 column skeleton.

## Design

Source stays the single source of truth. Editing happens in the source lines that already show
while the caret is in a table; commands rewrite only the changed span of the table in one
transaction (one undo step).

- Model and formatting: `src/lib/markdown-table.ts` (pure). Cells keep raw markdown; only unescaped
  `|` splits cells (GFM). Column width uses display width (CJK and emoji 2, combining marks 0),
  minimum 3. Uneven rows are padded, never truncated. Prefixes (indent, `>` quotes, a list marker on
  the first line) are kept.
- Detection: a table is a header row, a delimiter row with the same cell count and the pipe lines
  after it, and the lezer tree must agree (`Table` ancestor, not inside code).
- Keys (`Prec.high`, only when the selection is in a table, never in code): Tab, Shift+Tab, Enter,
  Shift+Enter / Alt+Enter (`<br>`), Escape / Cmd+Enter (format + exit below, adding the blank line
  GFM needs), Alt+ArrowUp/Down (move row), Cmd+Alt+ArrowLeft/Right (move column), Cmd+Alt+Enter
  (row below), Cmd+Alt+F (format). The caret lands at the end of the target cell's content.
  Enter on a completely empty last row deletes it and exits (like an empty bullet).
- Auto-format: when moving between cells, on exit, and when the caret leaves a table that was edited
  during the visit (a separate undo step; untouched tables are never rewritten).
- Commands (palette "Table: ...", right-click "Table" submenu, toolbar): add row above/below, add
  column left/right, delete row/column, move row/column, duplicate row, sort A-Z / Z-A (numeric
  aware, empties last, markup ignored), align left/center/right/none, transpose, format, clear
  cell, delete table; Insert table, Convert selection (CSV/TSV/pipe lines), Paste clipboard as table.
- Paste: TSV or an HTML `<table>` becomes a table outside tables; inside, multi-cell data fills from
  the caret and grows the table; a single paste with pipes or newlines is escaped (`\|`, `<br>`).
- Toolbar: a small floating bar above the table while the editor is focused and the caret is in a
  table; buttons keep focus in the editor.
- Plugin coexistence: if plugin id `table-editor-obsidian` is enabled in the plugin host the
  built-in keymap, paste handler and auto-format yield (`isAdvancedTablesPluginActive`); the palette
  commands and toolbar remain.

## Keybinding notes

Alt+ArrowUp/Down (CodeMirror "move line") and Cmd+Enter ("insert line below") are overridden
inside a table only. Alt+ArrowLeft/Right stays word navigation; column moves use Cmd+Alt+Arrow.
Tab stops indenting inside a table (also in a list item).

## Deferred

- Formulas (`<!-- TBLFM -->`): later phase, not built.
- Row / column grips, drag reorder and edge "+" affordances (would need a live-preview grid;
  the source-as-truth model makes it a larger change). Selecting a whole cell on Tab (today the
  caret goes to the end of the cell).
- Multi-cell selection operations, a size-picker for Insert table, CSV export, wrapping a bare
  `[[a|b]]` pipe automatically (type `[[a\|b]]` in tables).
- Real-window verification.
