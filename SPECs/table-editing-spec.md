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

- `features/tables/web/table-decorations.ts` folded a GFM `Table` node into a read-only rendered `TableWidget`; when the
  selection touched the table the widget went away and the raw lines showed as a monospace code-like
  block (`cm-table-source-line`). Caret in a table therefore always meant "editing source". (Replaced, see "Rendered tables" below.)
- No cell navigation: Tab indented or did nothing, Enter split the line, pipes were never aligned.
- `insert.table` (Insert menu) inserts a 3 column skeleton.

## Rendered tables (live cells)

User feedback from real use: a wide table was clipped with no scroll bar, and clicking a table
turned it into markdown source. The rendered table is now the editing surface.

- Layout: `.cm-table-scroll` (`overflow-x: auto`, thin themed scrollbar, `max-width: 100%`) wraps the
  table, so a table wider than the column scrolls inside itself (trackpad or Shift+wheel) and the
  last column is never clipped. Columns are at least 7rem and at most 28rem wide, long cells wrap.
  Styles are `web/table-ui.css` (plain CSS, light and dark through the app tokens).
- Never unfolds: a selection or caret in a table does not change its decoration. The markdown shows
  only through the explicit "Edit source" toggle (`</>` button, top right on hover/focus; palette
  "Table: Edit source / Done"), kept per table in the `tableSourceField` state (line start, mapped
  through edits). In source mode the old behaviour (source lines, toolbar with a Done button, keys)
  applies; moving the caret out of the table renders it again. Without that field (an editor that has
  only the editing extension) tables count as source, which keeps the source-mode tests as they were.
- Cells are edited in place (`web/table-cells.ts`): a cell shows its rendered inline markdown, turns
  into its raw markdown text (`contenteditable="plaintext-only"`) when focused, and is written back
  as one transaction (`input.table.cell`) when you leave it. The caret lands at the end of the text
  (not under the click). The editor selection follows into that cell's source so the palette commands
  and the context menu act on it. Keys in a cell: Tab / Shift+Tab (Tab in the last cell appends a
  row), Enter (down; adds a row at the end; on an empty last row removes it and leaves), Shift/Alt+Enter
  (`<br>`), Escape / Cmd+Enter (leave below, adding the blank line GFM needs), ArrowLeft/Right at the
  cell ends and ArrowUp/Down on the first/last visual line move to the neighbour cell (below the last
  row or above the header they leave the table), Cmd+Z / Shift+Cmd+Z / Cmd+Y: undo of unsaved typing
  in the cell, else the editor's history. Paste of tab-separated text, an HTML table or several lines
  fills cells from the edited one; a single line is inserted escaped.
- Arrow keys outside a table that would step into it (Up/Down from the adjacent line, Left/Right at
  the line edge) focus its first cell (going down or right) or last cell (going up or left).
  Whenever the editor itself has the caret in a rendered table (a restored selection, "Done"), it is
  moved into the matching cell.
- Handles: hover shows `+` on the bottom border of every row gutter (insert row below; the header's
  inserts at the top), `+` on the right border of every column header (insert column after), a
  dashed `+` row below and a `+` column after the table (append), a chevron on each column header and
  a grip on each row gutter opening a menu (insert before/after, move, duplicate, delete, align
  left/center/right, sort A to Z / Z to A). Everything runs the same `tableCommands`, so output is the
  canonical `layoutTable` format and each action is one undo step. The menus live in `document.body`.
- Fullscreen (`web/table-fullscreen.ts`, in the shared shell `src/lib/fullscreen-overlay.ts`): the expand button or
  palette "Table: Expand table" open the table in a near-full-window panel over a dimmed backdrop,
  scrolling both ways, with the same cells and handles. It edits the note's document through the same
  view (one undo history) and mirrors every document change. Escape, Close or a backdrop click close
  it and return focus to the note; one at a time; destroying the editor closes it.
- Links in fullscreen: cells render through the same `setCellMarkdownContent` as the inline widget,
  so wiki links, Markdown links and bare URLs carry the same `.cm-wiki-link` / `.cm-rendered-link`
  markup (styled by the editor's own theme: the overlay is outside the editor, so an inner
  `.cm-table-fullscreen-scope` element carries `view.dom`'s classes, `.cm-editor` and the generated
  theme classes, and every theme rule and `--pm-*` variable for links, inline code and the rest
  applies without a second copy). The editor's link extensions do not reach the overlay, so `table-links.ts`
  maps the cell markup onto the same openers they use (`wikiLinkTarget`, `linkTargetFor`) and the
  overlay binds them with `bindLinkActivation` (`claimPress`: a press on a link does not focus the
  cell), per the gesture table of `SPECs/link-activation-spec.md`. A press elsewhere in the cell
  edits it. A note opened in this tab or an active new tab closes the overlay first (it would
  otherwise cover the note you navigated to); a middle or Cmd/Ctrl click (background tab) and a URL
  in the system browser leave it open.
- Events: the widget ignores editor events except on links (so a click on a link still follows it).
  While the Advanced Tables plugin is active the built-in source-mode keys yield; the in-cell keys do
  not (they belong to the rendered DOM).

## Design (source mode and commands)

Source stays the single source of truth. Editing happens in the source lines that already show
while the caret is in a table; commands rewrite only the changed span of the table in one
transaction (one undo step).

- Model and formatting: `features/tables/web/markdown-table.ts` (pure). Cells keep raw markdown; only unescaped
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
- Drag reorder of rows and columns, a sticky first column, the caret under the click when a cell
  starts editing, and selecting a whole cell on Tab (today the caret goes to the end of the cell).
- Multi-cell selection operations, a size-picker for Insert table, CSV export, wrapping a bare
  `[[a|b]]` pipe automatically (type `[[a\|b]]` in tables).
- Real-window verification.
