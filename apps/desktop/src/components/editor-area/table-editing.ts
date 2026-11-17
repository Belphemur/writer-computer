// Keyboard, commands, paste and a floating toolbar for editing GFM tables in the source the editor
// already shows while the caret is inside a table (the rendered widget only exists when it is not).
// The markdown stays the single source of truth: every command is one transaction that replaces
// only the changed span of the table, so each is one undo step. Parsing/formatting is
// `src/lib/markdown-table.ts`; spec: `SPECs/table-editing-spec.md`.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  Prec,
  type EditorState,
  type Extension,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import {
  DELIMITER_ROW,
  HEADER_ROW,
  cellAtOffset,
  columnCount,
  deleteColumn,
  deleteRow,
  duplicateRow,
  emptyTable,
  escapeCell,
  findTableBounds,
  insertColumn,
  insertRow,
  layoutTable,
  moveColumn,
  moveRow,
  parseDelimited,
  parseLooseTable,
  parseTable,
  rowsFromHtmlTable,
  setAlignment,
  setCell,
  sortRows,
  splitPrefix,
  tableFromDelimited,
  tableFromGrid,
  transpose,
  type Align,
  type MarkdownTable,
  type TableCursor,
} from "@/lib/markdown-table";
import { usePluginsStore } from "@/stores/plugins-store";

// ---------------------------------------------------------------------------
// Yielding to the Obsidian Advanced Tables plugin
// ---------------------------------------------------------------------------

/** Plugin id of Advanced Tables in the Obsidian community catalog. */
export const ADVANCED_TABLES_PLUGIN_ID = "table-editor-obsidian";

/**
 * True while the user runs Advanced Tables through the plugin host. The built-in keymap, paste
 * handler and auto-format then stand down so a key is never handled twice; commands, the toolbar
 * and the palette entries stay available.
 */
export function isAdvancedTablesPluginActive(): boolean {
  return (
    usePluginsStore.getState().snapshot?.status[ADVANCED_TABLES_PLUGIN_ID]?.state === "enabled"
  );
}

let yieldProbe: () => boolean = isAdvancedTablesPluginActive;
/** Test seam: replaces the check that decides whether the built-in keymap yields. */
export function setTableYieldProbe(probe: (() => boolean) | null): void {
  yieldProbe = probe ?? isAdvancedTablesPluginActive;
}

// ---------------------------------------------------------------------------
// Table at a position
// ---------------------------------------------------------------------------

export interface TableContext {
  table: MarkdownTable;
  /** Document range of the table's lines (start of first line to end of last line). */
  from: number;
  to: number;
  cursor: TableCursor;
  /** Caret offset inside the cell's trimmed content (head of the selection). */
  offsetInCell: number;
}

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CommentBlock", "HTMLBlock", "CodeText"]);

function ancestorNames(state: EditorState, pos: number, side: -1 | 1): Set<string> {
  const tree =
    ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 25) ?? syntaxTree(state);
  const names = new Set<string>();
  for (let node: { name: string; parent: unknown } | null = tree.resolveInner(pos, side); node;) {
    names.add(node.name);
    node = node.parent as typeof node;
  }
  return names;
}

/** Is `pos` inside a fenced or indented code block (where paste and keys must stay untouched)? */
export function isInCode(state: EditorState, pos: number): boolean {
  for (const name of ancestorNames(state, pos, -1)) if (CODE_NODES.has(name)) return true;
  return false;
}

/** The table around `pos` (any position inside its lines), or null. */
export function tableContextAtPos(state: EditorState, pos: number): TableContext | null {
  const { doc } = state;
  const line = doc.lineAt(pos);
  if (!line.text.includes("|")) return null;
  const bounds = findTableBounds((i) => doc.line(i + 1).text, doc.lines, line.number - 1);
  if (!bounds) return null;

  // The syntax tree must agree this is a table (not a code block or HTML that contains pipes).
  const probe = line.from + line.text.indexOf("|");
  const names = ancestorNames(state, probe, 1);
  if (!names.has("Table") || [...names].some((n) => CODE_NODES.has(n))) return null;

  const lines: string[] = [];
  for (let i = bounds.startLine; i <= bounds.endLine; i++) lines.push(doc.line(i + 1).text);
  const table = parseTable(lines);
  if (!table) return null;

  const rel = line.number - 1 - bounds.startLine;
  const row = rel === 0 ? HEADER_ROW : rel === 1 ? DELIMITER_ROW : rel - 2;
  const prefixLength = rel === 0 ? table.firstPrefix.length : splitPrefix(line.text).length;
  const { col, offsetInCell } = cellAtOffset(line.text, prefixLength, pos - line.from);
  return {
    table,
    from: doc.line(bounds.startLine + 1).from,
    to: doc.line(bounds.endLine + 1).to,
    cursor: { row, col: Math.min(col, columnCount(table) - 1) },
    offsetInCell,
  };
}

/** The table the main selection is in (anchor and head both inside it), or null. */
export function tableContextAt(state: EditorState): TableContext | null {
  const { anchor, head } = state.selection.main;
  const ctx = tableContextAtPos(state, head);
  if (!ctx || anchor < ctx.from || anchor > ctx.to) return null;
  return ctx;
}

// ---------------------------------------------------------------------------
// Building transactions
// ---------------------------------------------------------------------------

type Place = number | "end";

function replaceTable(
  state: EditorState,
  ctx: TableContext,
  next: MarkdownTable,
  cursor: TableCursor,
  place: Place = "end",
  userEvent = "format.table",
): TransactionSpec {
  const layout = layoutTable(next);
  const text = layout.lines.join("\n");
  const old = state.sliceDoc(ctx.from, ctx.to);
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  let s = 0;
  while (
    s < old.length - p &&
    s < text.length - p &&
    old[old.length - 1 - s] === text[text.length - 1 - s]
  )
    s++;
  const range = layout.cellRange(cursor.row, cursor.col);
  const caret = ctx.from + (place === "end" ? range.to : Math.min(range.from + place, range.to));
  return {
    changes:
      old === text
        ? undefined
        : { from: ctx.from + p, to: ctx.to - s, insert: text.slice(p, text.length - s) },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent,
  };
}

/** A command on the table under the caret: `plan` returns the new table and caret, or null. */
function tableCommand(
  plan: (ctx: TableContext) => { table: MarkdownTable; cursor: TableCursor; place?: Place } | null,
  userEvent = "format.table",
): StateCommand {
  return ({ state, dispatch }) => {
    const ctx = tableContextAt(state);
    if (!ctx) return false;
    const result = plan(ctx);
    if (!result) return true; // in a table but nothing to do (an edge): swallow, no change
    dispatch(
      state.update(replaceTable(state, ctx, result.table, result.cursor, result.place, userEvent)),
    );
    return true;
  };
}

const effectiveRow = (ctx: TableContext): number =>
  ctx.cursor.row === DELIMITER_ROW ? HEADER_ROW : ctx.cursor.row;

const here = (ctx: TableContext): { cursor: TableCursor; place: Place } => {
  const row = effectiveRow(ctx);
  return {
    cursor: { row, col: ctx.cursor.col },
    place: ctx.cursor.row === DELIMITER_ROW ? "end" : ctx.offsetInCell,
  };
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const formatTableCommand = tableCommand((ctx) => ({ table: ctx.table, ...here(ctx) }));

const addRowAt = (below: boolean) =>
  tableCommand((ctx) => {
    const row = effectiveRow(ctx);
    const at = below ? row + 1 : Math.max(row, 0);
    return {
      table: insertRow(ctx.table, at),
      cursor: { row: at, col: ctx.cursor.col },
    };
  }, "input.table.row");

const addColumnAt = (right: boolean) =>
  tableCommand((ctx) => {
    const at = ctx.cursor.col + (right ? 1 : 0);
    return {
      table: insertColumn(ctx.table, at),
      cursor: { row: effectiveRow(ctx), col: at },
    };
  }, "input.table.column");

const deleteRowCommand = tableCommand((ctx) => {
  const row = effectiveRow(ctx);
  const table = deleteRow(ctx.table, row);
  if (!table) return null;
  return {
    table,
    cursor: {
      row: table.rows.length === 0 ? HEADER_ROW : Math.min(row, table.rows.length - 1),
      col: ctx.cursor.col,
    },
  };
}, "delete.table.row");

const deleteColumnCommand = tableCommand((ctx) => {
  const table = deleteColumn(ctx.table, ctx.cursor.col);
  if (!table) return null;
  return {
    table,
    cursor: { row: effectiveRow(ctx), col: Math.min(ctx.cursor.col, columnCount(table) - 1) },
  };
}, "delete.table.column");

const moveRowCommand = (delta: -1 | 1) =>
  tableCommand((ctx) => {
    const table = moveRow(ctx.table, ctx.cursor.row, delta);
    if (!table) return null;
    return {
      table,
      cursor: { row: ctx.cursor.row + delta, col: ctx.cursor.col },
      place: ctx.offsetInCell,
    };
  }, "move.table.row");

const moveColumnCommand = (delta: -1 | 1) =>
  tableCommand((ctx) => {
    const table = moveColumn(ctx.table, ctx.cursor.col, delta);
    if (!table) return null;
    return {
      table,
      cursor: { row: effectiveRow(ctx), col: ctx.cursor.col + delta },
      place: ctx.offsetInCell,
    };
  }, "move.table.column");

const duplicateRowCommand = tableCommand((ctx) => {
  const table = duplicateRow(ctx.table, ctx.cursor.row);
  if (!table) return null;
  return { table, cursor: { row: ctx.cursor.row + 1, col: ctx.cursor.col } };
}, "input.table.row");

const sortCommand = (dir: "asc" | "desc") =>
  tableCommand((ctx) => {
    const table = sortRows(ctx.table, ctx.cursor.col, dir);
    return table ? { table, ...here(ctx) } : null;
  }, "sort.table");

const alignCommand = (align: Align) =>
  tableCommand((ctx) => {
    const table = setAlignment(ctx.table, ctx.cursor.col, align);
    return table ? { table, ...here(ctx) } : null;
  }, "format.table.align");

const transposeCommand = tableCommand(
  (ctx) => ({
    table: transpose(ctx.table),
    cursor: { row: HEADER_ROW, col: 0 },
  }),
  "format.table.transpose",
);

const clearCellCommand = tableCommand((ctx) => {
  if (ctx.cursor.row === DELIMITER_ROW) return null;
  return {
    table: setCell(ctx.table, ctx.cursor.row, ctx.cursor.col, ""),
    cursor: ctx.cursor,
  };
}, "delete.table.cell");

const deleteTableCommand: StateCommand = ({ state, dispatch }) => {
  const ctx = tableContextAt(state);
  if (!ctx) return false;
  const { doc } = state;
  // Take the blank line that separated the table from what follows, if any.
  const to = ctx.to < doc.length ? ctx.to + 1 : ctx.to;
  dispatch(
    state.update({
      changes: { from: ctx.from, to },
      selection: EditorSelection.cursor(ctx.from),
      userEvent: "delete.table",
    }),
  );
  return true;
};

// -- Navigation --------------------------------------------------------------

function nextCursor(ctx: TableContext, dir: 1 | -1): { cursor: TableCursor; grow: boolean } {
  const n = columnCount(ctx.table);
  const { row, col } = ctx.cursor;
  const last = ctx.table.rows.length - 1;
  if (dir === 1) {
    if (row === DELIMITER_ROW)
      return last >= 0
        ? { cursor: { row: 0, col: 0 }, grow: false }
        : { cursor: { row: 0, col: 0 }, grow: true };
    if (col < n - 1) return { cursor: { row, col: col + 1 }, grow: false };
    if (row === HEADER_ROW) return { cursor: { row: 0, col: 0 }, grow: last < 0 };
    if (row < last) return { cursor: { row: row + 1, col: 0 }, grow: false };
    return { cursor: { row: last + 1, col: 0 }, grow: true };
  }
  if (row === DELIMITER_ROW) return { cursor: { row: HEADER_ROW, col: n - 1 }, grow: false };
  if (col > 0) return { cursor: { row, col: col - 1 }, grow: false };
  if (row === HEADER_ROW) return { cursor: { row: HEADER_ROW, col: 0 }, grow: false };
  if (row === 0) return { cursor: { row: HEADER_ROW, col: n - 1 }, grow: false };
  return { cursor: { row: row - 1, col: n - 1 }, grow: false };
}

/** Tab / Shift-Tab: next / previous cell; Tab in the last cell appends a row. */
export const nextCell = (dir: 1 | -1): StateCommand =>
  tableCommand((ctx) => {
    const { cursor, grow } = nextCursor(ctx, dir);
    return { table: grow ? insertRow(ctx.table, ctx.table.rows.length) : ctx.table, cursor };
  }, "select.table.cell");

const isBlankRow = (cells: readonly string[]) => cells.every((c) => c === "");

/** Where the caret goes to leave a table that ends at `end`, and the text it takes to get there. */
function exitBelow(
  state: EditorState,
  end: number,
): { changes?: { from: number; insert: string }; caret: number } {
  const { doc } = state;
  const last = doc.lineAt(end);
  if (last.number === doc.lines) return { changes: { from: end, insert: "\n\n" }, caret: end + 2 };
  const l1 = doc.line(last.number + 1);
  if (l1.text.trim() !== "") return { changes: { from: end, insert: "\n\n" }, caret: end + 2 };
  if (l1.number === doc.lines) return { changes: { from: l1.to, insert: "\n" }, caret: l1.to + 1 };
  const l2 = doc.line(l1.number + 1);
  if (l2.text.trim() === "") return { caret: l2.to };
  return { changes: { from: l1.to, insert: "\n" }, caret: l1.to + 1 };
}

function exitTable(state: EditorState, ctx: TableContext, table: MarkdownTable): TransactionSpec {
  const text = layoutTable(table).lines.join("\n");
  const old = state.sliceDoc(ctx.from, ctx.to);
  // Format, then step out below. Build one change list against the old document.
  const exit = exitBelow(state, ctx.to);
  const changes = [];
  if (old !== text) changes.push({ from: ctx.from, to: ctx.to, insert: text });
  if (exit.changes) changes.push(exit.changes);
  const delta = text.length - old.length;
  return {
    changes,
    selection: EditorSelection.cursor(exit.caret + delta),
    scrollIntoView: true,
    userEvent: "select.table.exit",
  };
}

/** Escape / Mod-Enter: format the table and put the caret on an empty line below it. */
export const exitTableCommand: StateCommand = ({ state, dispatch }) => {
  const ctx = tableContextAt(state);
  if (!ctx) return false;
  dispatch(state.update(exitTable(state, ctx, ctx.table)));
  return true;
};

/**
 * Enter: the same column one row down; on the last row it appends a row, except on a completely
 * empty last row, which is removed and the caret leaves the table (like Enter on an empty bullet).
 */
export const enterCommand: StateCommand = ({ state, dispatch }) => {
  const ctx = tableContextAt(state);
  if (!ctx) return false;
  const { row, col } = ctx.cursor;
  const last = ctx.table.rows.length - 1;
  if (row >= 0 && row === last && isBlankRow(ctx.table.rows[row])) {
    const table = deleteRow(ctx.table, row);
    if (table) {
      dispatch(state.update(exitTable(state, ctx, table)));
      return true;
    }
  }
  const target = row === HEADER_ROW || row === DELIMITER_ROW ? 0 : row + 1;
  const grow = target > last;
  dispatch(
    state.update(
      replaceTable(
        state,
        ctx,
        grow ? insertRow(ctx.table, ctx.table.rows.length) : ctx.table,
        { row: target, col },
        "end",
        "select.table.cell",
      ),
    ),
  );
  return true;
};

/** Shift-Enter / Alt-Enter: a `<br>` line break inside the cell (replaces a selection in it). */
export const lineBreakCommand: StateCommand = ({ state, dispatch }) => {
  const ctx = tableContextAt(state);
  if (!ctx) return false;
  if (ctx.cursor.row === DELIMITER_ROW) return true;
  const { doc, selection } = state;
  const { from, to } = selection.main;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);
  const inCell = (pos: number, line: typeof fromLine) => {
    const prefix =
      line.from === ctx.from ? ctx.table.firstPrefix.length : splitPrefix(line.text).length;
    return cellAtOffset(line.text, prefix, pos - line.from);
  };
  const a = inCell(from, fromLine);
  const b = inCell(to, toLine);
  if (fromLine.number !== toLine.number || a.col !== b.col) return true; // multi-cell: do nothing
  const cell =
    ctx.cursor.row === HEADER_ROW ? ctx.table.header[a.col] : ctx.table.rows[ctx.cursor.row][a.col];
  const next = `${cell.slice(0, a.offsetInCell)}<br>${cell.slice(b.offsetInCell)}`;
  dispatch(
    state.update(
      replaceTable(
        state,
        ctx,
        setCell(ctx.table, ctx.cursor.row, a.col, next),
        { row: ctx.cursor.row, col: a.col },
        a.offsetInCell + 4,
        "input.table.break",
      ),
    ),
  );
  return true;
};

// -- Insert / convert ---------------------------------------------------------

function blockInsert(
  state: EditorState,
  from: number,
  to: number,
  table: MarkdownTable,
  cursor: TableCursor | "end",
): TransactionSpec {
  const { doc } = state;
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  const layout = layoutTable(table);
  let lead = "";
  if (startLine.text.slice(0, from - startLine.from).trim() !== "") lead = "\n\n";
  else if (startLine.number > 1 && doc.line(startLine.number - 1).text.trim() !== "") lead = "\n";
  let trail = "";
  if (endLine.text.slice(to - endLine.from).trim() !== "") trail = "\n\n";
  else if (endLine.number < doc.lines && doc.line(endLine.number + 1).text.trim() !== "")
    trail = "\n";
  const body = layout.lines.join("\n");
  const base = from + lead.length;
  let caret: number;
  if (cursor === "end") caret = base + body.length;
  else caret = base + layout.cellRange(cursor.row, cursor.col).to;
  return {
    changes: { from, to, insert: lead + body + trail },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: "input.table",
  };
}

/** Inserts an empty table (blank lines around it as needed) with the caret in the first header cell. */
export const insertTableCommand =
  (columns = 3, bodyRows = 2): StateCommand =>
  ({ state, dispatch }) => {
    const { from, to } = state.selection.main;
    const header = emptyTable(columns, bodyRows);
    header.header = header.header.map((_h, i) => `Column ${i + 1}`);
    dispatch(state.update(blockInsert(state, from, to, header, { row: HEADER_ROW, col: 0 })));
    return true;
  };

/** Replaces a selection (whole lines) of CSV/TSV or pipe-separated text by a table. */
export const convertSelectionToTable: StateCommand = ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  if (from === to) return false;
  const a = state.doc.lineAt(from);
  const b = state.doc.lineAt(to);
  const text = state.sliceDoc(a.from, b.to);
  const table = tableFromDelimited(text) ?? parseLooseTable(text.split("\n")) ?? null;
  if (!table) return false;
  dispatch(state.update(blockInsert(state, a.from, b.to, table, "end")));
  return true;
};

/** Inserts text as a table at the selection: CSV/TSV text, or pipe lines (palette "paste as table"). */
export function insertTableFromText(state: EditorState, text: string): TransactionSpec | null {
  const table = tableFromDelimited(text) ?? parseLooseTable(text.split("\n"));
  if (!table) return null;
  const { from, to } = state.selection.main;
  return blockInsert(state, from, to, table, "end");
}

// ---------------------------------------------------------------------------
// Command registry (palette, context menu, toolbar and keymap read from this)
// ---------------------------------------------------------------------------

export interface TableCommandDef {
  label: string;
  run: StateCommand;
  /** CodeMirror key name; the menu derives its accelerator from it. */
  chord?: string;
}

export const tableCommands = {
  "table.format": { label: "Format table", run: formatTableCommand, chord: "Mod-Alt-f" },
  "table.addRowAbove": { label: "Add row above", run: addRowAt(false) },
  "table.addRowBelow": { label: "Add row below", run: addRowAt(true), chord: "Mod-Alt-Enter" },
  "table.addColumnLeft": { label: "Add column left", run: addColumnAt(false) },
  "table.addColumnRight": { label: "Add column right", run: addColumnAt(true) },
  "table.deleteRow": { label: "Delete row", run: deleteRowCommand },
  "table.deleteColumn": { label: "Delete column", run: deleteColumnCommand },
  "table.moveRowUp": { label: "Move row up", run: moveRowCommand(-1), chord: "Alt-ArrowUp" },
  "table.moveRowDown": { label: "Move row down", run: moveRowCommand(1), chord: "Alt-ArrowDown" },
  "table.moveColumnLeft": {
    label: "Move column left",
    run: moveColumnCommand(-1),
    chord: "Mod-Alt-ArrowLeft",
  },
  "table.moveColumnRight": {
    label: "Move column right",
    run: moveColumnCommand(1),
    chord: "Mod-Alt-ArrowRight",
  },
  "table.duplicateRow": { label: "Duplicate row", run: duplicateRowCommand },
  "table.sortAscending": { label: "Sort by column A to Z", run: sortCommand("asc") },
  "table.sortDescending": { label: "Sort by column Z to A", run: sortCommand("desc") },
  "table.alignLeft": { label: "Align column left", run: alignCommand("left") },
  "table.alignCenter": { label: "Align column center", run: alignCommand("center") },
  "table.alignRight": { label: "Align column right", run: alignCommand("right") },
  "table.alignNone": { label: "Clear column alignment", run: alignCommand(null) },
  "table.transpose": { label: "Transpose table", run: transposeCommand },
  "table.clearCell": { label: "Clear cell", run: clearCellCommand },
  "table.delete": { label: "Delete table", run: deleteTableCommand },
} as const satisfies Record<string, TableCommandDef>;

export type TableCommandId = keyof typeof tableCommands;

/** Order and grouping of the "Table" context submenu (`"---"` is a separator). */
export const TABLE_MENU_LAYOUT: ReadonlyArray<"---" | TableCommandId> = [
  "table.addRowAbove",
  "table.addRowBelow",
  "table.addColumnLeft",
  "table.addColumnRight",
  "---",
  "table.moveRowUp",
  "table.moveRowDown",
  "table.moveColumnLeft",
  "table.moveColumnRight",
  "table.duplicateRow",
  "---",
  "table.deleteRow",
  "table.deleteColumn",
  "table.clearCell",
  "---",
  "table.alignLeft",
  "table.alignCenter",
  "table.alignRight",
  "table.alignNone",
  "---",
  "table.sortAscending",
  "table.sortDescending",
  "table.transpose",
  "---",
  "table.format",
  "table.delete",
];

export function runTableCommand(view: EditorView, id: TableCommandId): boolean {
  return tableCommands[id].run({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
}

// ---------------------------------------------------------------------------
// Keymap
// ---------------------------------------------------------------------------

function guarded(run: StateCommand): (view: EditorView) => boolean {
  return (view) => {
    if (yieldProbe()) return false;
    return run({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
  };
}

const tableKeymap: KeyBinding[] = [
  { key: "Tab", run: guarded(nextCell(1)) },
  { key: "Shift-Tab", run: guarded(nextCell(-1)) },
  { key: "Enter", run: guarded(enterCommand) },
  { key: "Shift-Enter", run: guarded(lineBreakCommand) },
  { key: "Alt-Enter", run: guarded(lineBreakCommand) },
  { key: "Escape", run: guarded(exitTableCommand) },
  { key: "Mod-Enter", run: guarded(exitTableCommand) },
  ...Object.values(tableCommands).flatMap((c): KeyBinding[] =>
    "chord" in c ? [{ key: c.chord, run: guarded(c.run) }] : [],
  ),
];

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

function gridFromClipboard(data: DataTransfer | null): string[][] | null {
  if (!data) return null;
  const html = data.getData("text/html");
  const fromHtml = html ? rowsFromHtmlTable(html) : null;
  if (fromHtml) return fromHtml;
  const text = data.getData("text/plain");
  if (!text.includes("\t")) return null;
  const rows = parseDelimited(text, "\t").filter((r) => !(r.length === 1 && r[0] === ""));
  return rows.length > 0 ? rows : null;
}

const isMultiCell = (grid: string[][]) => grid.length > 1 || grid[0].length > 1;

function pasteIntoTable(state: EditorState, ctx: TableContext, grid: string[][]): TransactionSpec {
  let table = ctx.table;
  const startRow =
    ctx.cursor.row === HEADER_ROW ? 0 : ctx.cursor.row === DELIMITER_ROW ? 1 : ctx.cursor.row + 1;
  const width = Math.max(...grid.map((r) => r.length));
  while (columnCount(table) < ctx.cursor.col + width)
    table = insertColumn(table, columnCount(table));
  while (table.rows.length < startRow + grid.length - 1)
    table = insertRow(table, table.rows.length);
  grid.forEach((cells, i) => {
    cells.forEach((cell, j) => {
      const r = startRow + i - 1; // 0 -> header (-1)
      table = setCell(table, r, ctx.cursor.col + j, escapeCell(cell));
    });
  });
  const lastRow = startRow + grid.length - 2;
  return replaceTable(
    state,
    ctx,
    table,
    { row: lastRow, col: ctx.cursor.col + width - 1 },
    "end",
    "input.paste.table",
  );
}

const pasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    if (yieldProbe()) return false;
    const { state } = view;
    const ctx = tableContextAt(state);
    const grid = gridFromClipboard(event.clipboardData);
    if (ctx) {
      if (grid && isMultiCell(grid)) {
        event.preventDefault();
        view.dispatch(state.update(pasteIntoTable(state, ctx, grid)));
        return true;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (ctx.cursor.row === DELIMITER_ROW || !/[|\n\r]/.test(text)) return false;
      // Pipes and newlines would split the cell: escape them and keep the table aligned.
      const { from, to } = state.selection.main;
      const line = state.doc.lineAt(from);
      if (line.number !== state.doc.lineAt(to).number) return false;
      const prefix =
        line.from === ctx.from ? ctx.table.firstPrefix.length : splitPrefix(line.text).length;
      const a = cellAtOffset(line.text, prefix, from - line.from);
      const b = cellAtOffset(line.text, prefix, to - line.from);
      if (a.col !== b.col) return false;
      const cell =
        ctx.cursor.row === HEADER_ROW
          ? ctx.table.header[a.col]
          : ctx.table.rows[ctx.cursor.row][a.col];
      const insert = escapeCell(text);
      event.preventDefault();
      view.dispatch(
        state.update(
          replaceTable(
            state,
            ctx,
            setCell(
              ctx.table,
              ctx.cursor.row,
              a.col,
              cell.slice(0, a.offsetInCell) + insert + cell.slice(b.offsetInCell),
            ),
            { row: ctx.cursor.row, col: a.col },
            a.offsetInCell + insert.length,
            "input.paste",
          ),
        ),
      );
      return true;
    }
    if (!grid || !isMultiCell(grid) || isInCode(state, state.selection.main.head)) return false;
    event.preventDefault();
    const { from, to } = state.selection.main;
    view.dispatch(state.update(blockInsert(state, from, to, tableFromGrid(grid), "end")));
    return true;
  },
});

// ---------------------------------------------------------------------------
// View plugin: active view, format on leave, floating toolbar
// ---------------------------------------------------------------------------

let lastView: EditorView | null = null;
/** The editor the table commands in the palette act on (the last one that had focus). */
export function getTableEditorView(): EditorView | null {
  return lastView;
}

const TOOLBAR: ReadonlyArray<readonly [TableCommandId, string, string] | "---"> = [
  ["table.addRowBelow", "+ Row", "Add row below"],
  ["table.addColumnRight", "+ Col", "Add column right"],
  "---",
  ["table.moveRowUp", "▲", "Move row up"],
  ["table.moveRowDown", "▼", "Move row down"],
  ["table.moveColumnLeft", "◀", "Move column left"],
  ["table.moveColumnRight", "▶", "Move column right"],
  "---",
  ["table.alignLeft", "L", "Align column left"],
  ["table.alignCenter", "C", "Align column center"],
  ["table.alignRight", "R", "Align column right"],
  "---",
  ["table.sortAscending", "A→Z", "Sort by column A to Z"],
  ["table.sortDescending", "Z→A", "Sort by column Z to A"],
  "---",
  ["table.deleteRow", "− Row", "Delete row"],
  ["table.deleteColumn", "− Col", "Delete column"],
  ["table.format", "Format", "Format table"],
];

class TableEditingPlugin {
  private toolbar: HTMLElement;
  /** The table the caret was last in, and whether it was edited during the visit. */
  private visit: { from: number; to: number; edited: boolean } | null = null;
  private pending: number | null = null;

  constructor(private view: EditorView) {
    this.toolbar = document.createElement("div");
    this.toolbar.className = "cm-table-toolbar";
    this.toolbar.setAttribute("role", "toolbar");
    this.toolbar.setAttribute("aria-label", "Table");
    this.toolbar.hidden = true;
    for (const entry of TOOLBAR) {
      if (entry === "---") {
        const sep = this.toolbar.appendChild(document.createElement("span"));
        sep.className = "cm-table-toolbar-sep";
        continue;
      }
      const [id, text, title] = entry;
      const button = this.toolbar.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.dataset.command = id;
      // Keep the editor focused: a button that takes focus would blur the caret out of the table.
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => {
        runTableCommand(this.view, id);
        this.view.focus();
      });
    }
    view.dom.appendChild(this.toolbar);
    view.dom.addEventListener("focusin", this.onFocus);
    if (view.hasFocus) lastView = view;
    this.refresh(tableContextAt(view.state));
  }

  private onFocus = () => {
    lastView = this.view;
  };

  update(u: ViewUpdate) {
    if (u.focusChanged && u.view.hasFocus) lastView = u.view;
    if (this.pending !== null && u.docChanged) this.pending = u.changes.mapPos(this.pending, -1);
    const relevant =
      u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged || u.viewportChanged;
    if (!relevant) return;
    const ctx = tableContextAt(u.state);
    if (this.visit) {
      if (u.docChanged) {
        if (u.changes.touchesRange(this.visit.from, this.visit.to) !== false)
          this.visit.edited = true;
        this.visit.from = u.changes.mapPos(this.visit.from, -1);
        this.visit.to = u.changes.mapPos(this.visit.to, 1);
      }
    }
    if (u.selectionSet || u.docChanged) {
      if (this.visit && !(ctx && ctx.from === this.visit.from)) {
        if (this.visit.edited && !yieldProbe()) this.scheduleFormat(this.visit.from);
        this.visit = null;
      }
      if (ctx) {
        if (this.visit) this.visit.to = ctx.to;
        else this.visit = { from: ctx.from, to: ctx.to, edited: false };
      }
    }
    this.refresh(ctx);
  }

  /** After the caret leaves an edited table: align its pipes (a separate, undoable step). */
  private scheduleFormat(pos: number) {
    this.pending = pos;
    queueMicrotask(() => {
      const at = this.pending;
      this.pending = null;
      if (at === null || !this.view.dom.isConnected) return;
      const state = this.view.state;
      if (at > state.doc.length) return;
      const ctx = tableContextAtPos(state, at);
      if (!ctx) return;
      const { head } = state.selection.main;
      if (head >= ctx.from && head <= ctx.to) return; // came back: leave it for the next exit
      const text = layoutTable(ctx.table).lines.join("\n");
      if (state.sliceDoc(ctx.from, ctx.to) === text) return;
      this.view.dispatch({
        changes: { from: ctx.from, to: ctx.to, insert: text },
        userEvent: "format.table.auto",
      });
    });
  }

  private refresh(ctx: TableContext | null) {
    const show = ctx !== null && this.view.hasFocus;
    this.toolbar.hidden = !show;
    if (!show || !ctx) return;
    const { view, toolbar } = this;
    view.requestMeasure({
      key: this,
      read: () => {
        const top = view.coordsAtPos(ctx.from);
        const bottom = view.coordsAtPos(ctx.to);
        return { top, bottom, box: view.dom.getBoundingClientRect(), height: toolbar.offsetHeight };
      },
      write: ({ top, bottom, box, height }) => {
        if (!top || !bottom) return;
        let y = top.top - box.top - height - 4;
        if (y < 0) y = bottom.bottom - box.top + 4;
        toolbar.style.top = `${Math.round(y)}px`;
      },
    });
  }

  destroy() {
    this.view.dom.removeEventListener("focusin", this.onFocus);
    this.toolbar.remove();
    if (lastView === this.view) lastView = null;
  }
}

const tablePlugin = ViewPlugin.fromClass(TableEditingPlugin);

const toolbarTheme = EditorView.baseTheme({
  ".cm-table-toolbar": {
    position: "absolute",
    left: "0",
    zIndex: "5",
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "3px",
    borderRadius: "8px",
    border: "1px solid var(--border-color, #3e3e42)",
    backgroundColor: "var(--surface-subtle, var(--code-bg, #2d2d2d))",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.18)",
    fontSize: "12px",
    lineHeight: "1",
    maxWidth: "100%",
    flexWrap: "wrap",
  },
  ".cm-table-toolbar[hidden]": { display: "none" },
  ".cm-table-toolbar button": {
    all: "unset",
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: "5px",
    color: "inherit",
    fontFamily: "system-ui, sans-serif",
    whiteSpace: "nowrap",
  },
  ".cm-table-toolbar button:hover": { backgroundColor: "rgba(127, 127, 127, 0.22)" },
  ".cm-table-toolbar-sep": {
    width: "1px",
    alignSelf: "stretch",
    margin: "2px 3px",
    backgroundColor: "var(--border-color, #3e3e42)",
  },
});

// ---------------------------------------------------------------------------
// Context menu support
// ---------------------------------------------------------------------------

/**
 * Called by the editor's right-click handler. When the click is on a table (rendered or source) it
 * puts the caret in the clicked cell and returns true, so the menu can offer the Table submenu.
 */
export function prepareTableContextMenu(view: EditorView, event: MouseEvent): boolean {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return false;
  const ctx = tableContextAtPos(view.state, pos);
  if (!ctx) return false;

  const target = event.target instanceof Element ? event.target.closest("td, th") : null;
  if (target) {
    // Rendered widget: pick the cell from the DOM and move the caret into its source.
    const tr = target.closest("tr");
    const bodyRows = target.closest("table")?.querySelectorAll("tbody tr");
    const row =
      target.tagName === "TH"
        ? HEADER_ROW
        : bodyRows
          ? Array.from(bodyRows).indexOf(tr as Element)
          : 0;
    const col = Math.min((target as HTMLTableCellElement).cellIndex, columnCount(ctx.table) - 1);
    const range = layoutTable(ctx.table).cellRange(Math.max(row, HEADER_ROW), col);
    view.dispatch({ selection: EditorSelection.cursor(ctx.from + range.to) });
    return true;
  }
  const current = tableContextAt(view.state);
  if (!current || current.from !== ctx.from || view.state.selection.main.empty) {
    view.dispatch({ selection: EditorSelection.cursor(pos) });
  }
  return true;
}

// ---------------------------------------------------------------------------

/** Everything the editor needs for table editing; add once to `createEditorExtensions`. */
export function tableEditing(): Extension {
  return [Prec.high(keymap.of(tableKeymap)), Prec.high(pasteHandler), tablePlugin, toolbarTheme];
}
