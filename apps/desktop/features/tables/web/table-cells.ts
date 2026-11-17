// The live rendered table: the DOM of a table whose cells are edited in place, with hover handles
// to insert rows and columns and a menu on every row and column header. One builder serves the
// inline widget and the fullscreen overlay; each passes a small `TableHost` that says which table
// (by document position) the DOM stands for. The markdown stays the single source of truth: a cell
// shows its rendered inline markdown, turns into its raw text while it is edited, and is written
// back as one transaction (one undo step) when you leave it. Spec: SPECs/table-editing-spec.md.
import { redo, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { bindLinkActivation, type LinkTarget } from "@/lib/link-activation";
import "./table-ui.css";
import {
  HEADER_ROW,
  columnCount,
  deleteRow,
  escapeCell,
  insertRow,
  layoutTable,
  parseDelimited,
  setCell,
  type TableCursor,
} from "./markdown-table";
import { setCellMarkdownContent } from "./table-inline";
import {
  CELL_TEXT_CLASS,
  cellTextElement,
  findInlineCell,
  focusInlineCell,
  getFullscreenHooks,
} from "./table-state";
import {
  applyTableEdit,
  exitTable,
  gridFromClipboard,
  isBlankRow,
  isMultiCell,
  nextCursor,
  pasteIntoTable,
  runTableCommand,
  tableContextAtPos,
  toggleTableSourceAt,
  type TableCommandId,
  type TableContext,
} from "./table-editing";

export type Alignment = "left" | "center" | "right";

/** What the DOM shows: raw cell markdown per cell. */
export interface RenderTable {
  headers: string[];
  alignments: (Alignment | undefined)[];
  rows: string[][];
}

export interface TableHost {
  view: EditorView;
  /** Start of the table's first line, or null when the DOM no longer stands for a table. */
  from(): number | null;
  findCell(from: number, row: number, col: number): HTMLElement | null;
  fullscreen: boolean;
  /** Opens the fullscreen overlay (the inline widget only). */
  expand?(): void;
  /** Maps a clicked element to a link to open. Set where the editor's own link handlers do not
   *  reach the cells (the fullscreen overlay); the inline widget leaves it to them. */
  linkTarget?(el: Element): LinkTarget | null;
}

/** The host of a table rendered inside the editor's own content. */
export function inlineTableHost(
  view: EditorView,
  wrapper: HTMLElement,
  expand: (from: number) => void,
): TableHost {
  const from = (): number | null => {
    try {
      return view.state.doc.lineAt(view.posAtDOM(wrapper)).from;
    } catch {
      return null;
    }
  };
  return {
    view,
    from,
    findCell: (at, row, col) => findInlineCell(view, at, row, col),
    fullscreen: false,
    expand: () => {
      const at = from();
      if (at !== null) expand(at);
    },
  };
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, action: string, text: string, title: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.tabIndex = -1;
  b.dataset.action = action;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

function makeCell(
  tag: "th" | "td",
  row: number,
  col: number,
  raw: string,
  align: Alignment | undefined,
): HTMLElement {
  const cell = el(tag);
  cell.dataset.row = String(row);
  cell.dataset.col = String(col);
  cell.dataset.raw = raw;
  if (align) cell.style.textAlign = align;
  const text = cell.appendChild(el("div", CELL_TEXT_CLASS));
  text.contentEditable = "plaintext-only";
  text.tabIndex = 0;
  text.spellcheck = false;
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", row === HEADER_ROW ? "Header cell" : "Table cell");
  text.setAttribute("aria-multiline", "false");
  setCellMarkdownContent(text, raw);
  return cell;
}

function fillTable(tableEl: HTMLTableElement, table: RenderTable) {
  const { headers, alignments, rows } = table;
  const n = headers.length;

  const thead = tableEl.appendChild(el("thead"));
  const headerRow = thead.appendChild(el("tr"));
  const headGutter = headerRow.appendChild(el("th", "cm-table-gutter"));
  headGutter.dataset.row = String(HEADER_ROW);
  headGutter.appendChild(
    button("cm-table-handle cm-table-row-add", "row-add", "+", "Insert row below"),
  );
  for (let c = 0; c < n; c++) {
    const th = makeCell("th", HEADER_ROW, c, headers[c], alignments[c]);
    th.classList.add("cm-table-head");
    if (c === n - 1) th.dataset.last = "col";
    th.appendChild(button("cm-table-handle cm-table-col-grip", "col-menu", "▾", "Column options"));
    th.appendChild(
      button("cm-table-handle cm-table-col-add", "col-add", "+", "Insert column after"),
    );
    headerRow.appendChild(th);
  }
  const addCol = headerRow.appendChild(el("th", "cm-table-addcol"));
  addCol.appendChild(button("cm-table-handle cm-table-end-add", "end-col", "+", "Add column"));

  const tbody = tableEl.appendChild(el("tbody"));
  rows.forEach((cells, r) => {
    const tr = tbody.appendChild(el("tr"));
    const gutter = tr.appendChild(el("td", "cm-table-gutter"));
    gutter.dataset.row = String(r);
    gutter.appendChild(button("cm-table-handle cm-table-row-grip", "row-menu", "⋮", "Row options"));
    gutter.appendChild(
      button("cm-table-handle cm-table-row-add", "row-add", "+", "Insert row below"),
    );
    for (let c = 0; c < n; c++) {
      const td = makeCell("td", r, c, cells[c] ?? "", alignments[c]);
      if (c === n - 1) td.dataset.last = "col";
      if (r === rows.length - 1) td.dataset.lastRow = "1";
      tr.appendChild(td);
    }
    tr.appendChild(el("td", "cm-table-spacer"));
  });

  const tfoot = tableEl.appendChild(el("tfoot"));
  const footRow = tfoot.appendChild(el("tr", "cm-table-addrow"));
  const footCell = footRow.appendChild(el("td"));
  footCell.colSpan = n + 2;
  footCell.appendChild(button("cm-table-handle cm-table-end-add", "end-row", "+", "Add row"));
}

export function buildTableDOM(
  table: RenderTable,
  makeHost: (wrapper: HTMLElement) => TableHost,
): HTMLElement {
  const wrapper = el("div", "cm-table-widget");
  const host = makeHost(wrapper);
  if (host.fullscreen) wrapper.dataset.fullscreen = "1";
  const scroll = wrapper.appendChild(el("div", "cm-table-scroll"));
  fillTable(scroll.appendChild(el("table")), table);

  if (!host.fullscreen) {
    const actions = wrapper.appendChild(el("div", "cm-table-actions"));
    actions.appendChild(button("cm-table-action", "expand", "⤢", "Expand table"));
    actions.appendChild(button("cm-table-action", "source", "</>", "Edit source"));
  }

  wrapper.addEventListener("focusin", (e) => onFocusIn(host, e));
  wrapper.addEventListener("focusout", (e) => onFocusOut(host, e));
  wrapper.addEventListener("keydown", (e) => onKeyDown(host, e));
  wrapper.addEventListener("paste", (e) => onPaste(host, e));
  wrapper.addEventListener("drop", (e) => e.preventDefault());
  wrapper.addEventListener("mousedown", (e) => {
    // Handles never take the focus: a cell being edited keeps it until the action commits it.
    if (e.target instanceof Element && e.target.closest("button")) e.preventDefault();
  });
  wrapper.addEventListener("click", (e) => onClick(host, e));
  // Claim the press: a left press on a link would focus the cell and swap the link for its source.
  if (host.linkTarget) bindLinkActivation(wrapper, host.linkTarget, { claimPress: true });
  return wrapper;
}

/** Updates a table DOM in place; false when the shape changed and it has to be rebuilt. */
export function syncTableDOM(wrapper: HTMLElement, table: RenderTable): boolean {
  const { headers, alignments, rows } = table;
  if (
    wrapper.querySelectorAll("thead th[data-col]").length !== headers.length ||
    wrapper.querySelectorAll("tbody tr").length !== rows.length
  )
    return false;
  wrapper.querySelectorAll<HTMLElement>("[data-row][data-col]").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const raw = row === HEADER_ROW ? headers[col] : (rows[row]?.[col] ?? "");
    cell.style.textAlign = alignments[col] ?? "";
    const text = cellTextElement(cell);
    if (!text) return;
    if (cell.dataset.editing === "1") {
      // A cell being edited keeps what you typed, unless you have not typed anything yet.
      if (readCellText(text) !== (cell.dataset.raw ?? "")) return;
      cell.dataset.raw = raw;
      text.textContent = raw;
      placeCaretAtEnd(text);
      return;
    }
    cell.dataset.raw = raw;
    setCellMarkdownContent(text, raw);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Cell editing
// ---------------------------------------------------------------------------

const cellOf = (node: EventTarget | null): HTMLElement | null =>
  node instanceof Element ? node.closest<HTMLElement>("[data-row][data-col]") : null;

const cursorOf = (cell: HTMLElement): TableCursor => ({
  row: Number(cell.dataset.row),
  col: Number(cell.dataset.col),
});

/** What the user typed, as one markdown cell (pipes escaped, newlines as `<br>`). */
function readCellText(text: HTMLElement): string {
  return escapeCell((text.textContent ?? "").replace(/ /g, " "));
}

function placeCaretAtEnd(text: HTMLElement) {
  const sel = text.ownerDocument.getSelection();
  if (!sel) return;
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function resolve(host: TableHost): TableContext | null {
  const from = host.from();
  return from === null ? null : tableContextAtPos(host.view.state, from);
}

function focusCell(host: TableHost, from: number, row: number, col: number): boolean {
  const cell = host.findCell(from, row, col);
  const text = cell ? cellTextElement(cell) : null;
  if (!text) return false;
  text.focus();
  return true;
}

/** Puts the editor's selection in the source of a cell, so palette commands act on it. */
function selectCellSource(host: TableHost, ctx: TableContext, row: number, col: number) {
  const range = layoutTable(ctx.table).cellRange(row, col);
  const head = ctx.from + range.to;
  const sel = host.view.state.selection.main;
  if (sel.head === head && sel.anchor === head) return;
  host.view.dispatch({ selection: EditorSelection.cursor(head) });
}

function onFocusIn(host: TableHost, e: FocusEvent) {
  const cell = cellOf(e.target);
  const text = cell ? cellTextElement(cell) : null;
  if (!cell || !text || e.target !== text || cell.dataset.editing === "1") return;
  cell.dataset.editing = "1";
  text.textContent = cell.dataset.raw ?? "";
  placeCaretAtEnd(text);
  const ctx = resolve(host);
  if (ctx) {
    try {
      const { row, col } = cursorOf(cell);
      selectCellSource(host, ctx, row, col);
    } catch {
      /* the editor is updating; the caret sync is only a convenience for palette commands */
    }
  }
}

function onFocusOut(host: TableHost, e: FocusEvent) {
  const cell = cellOf(e.target);
  if (!cell || cell.dataset.editing !== "1") return;
  try {
    commitCell(host, cell);
  } catch {
    /* the editor was mid-update (the cell is being removed); nothing left to commit */
  }
}

/** Leaves edit mode and writes the cell back when it changed. Returns whether the document changed. */
export function commitCell(host: TableHost, cell: HTMLElement): boolean {
  if (cell.dataset.editing !== "1") return false;
  const text = cellTextElement(cell);
  if (!text) return false;
  const raw = cell.dataset.raw ?? "";
  const next = readCellText(text);
  delete cell.dataset.editing;
  setCellMarkdownContent(text, raw);
  if (next === raw || !cell.isConnected) return false;
  const ctx = resolve(host);
  if (!ctx) return false;
  const { row, col } = cursorOf(cell);
  applyTableEdit(
    host.view,
    ctx,
    setCell(ctx.table, row, col, next),
    { row, col },
    "input.table.cell",
  );
  return true;
}

/** Commits whichever cell of this table is being edited. */
function commitActive(host: TableHost, wrapper: Element | null) {
  const active = wrapper?.querySelector<HTMLElement>('[data-editing="1"]');
  if (active) commitCell(host, active);
}

function caretOffset(text: HTMLElement): number | null {
  const sel = text.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!text.contains(range.endContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(text);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString().length;
}

/** Is the caret on the first (`up`) or last (`down`) visual line of the cell? Unknown geometry counts as yes. */
function caretOnEdgeLine(text: HTMLElement, dir: "up" | "down"): boolean {
  const sel = text.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  const box = text.getBoundingClientRect();
  if (!rect || rect.height === 0 || box.height === 0) return true;
  return dir === "up"
    ? rect.top - box.top < rect.height * 0.9
    : box.bottom - rect.bottom < rect.height * 0.9;
}

function insertAtCaret(text: HTMLElement, value: string) {
  const doc = text.ownerDocument;
  if (typeof doc.execCommand === "function" && doc.execCommand("insertText", false, value)) return;
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) {
    text.append(value);
    placeCaretAtEnd(text);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = doc.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

type Leave = "exit" | "below" | "above";

/** Gets the caret out of the table into the note (inline widget only; fullscreen closes with Escape). */
function leaveTable(host: TableHost, cell: HTMLElement, how: Leave) {
  if (host.fullscreen) return;
  commitCell(host, cell);
  const ctx = resolve(host);
  if (!ctx) return;
  const { view } = host;
  const { doc } = view.state;
  if (how === "exit" || (how === "below" && ctx.to >= doc.length)) {
    view.dispatch(view.state.update(exitTable(view.state, ctx, ctx.table)));
  } else if (how === "below") {
    view.dispatch({ selection: EditorSelection.cursor(ctx.to + 1), scrollIntoView: true });
  } else if (ctx.from > 0) {
    view.dispatch({ selection: EditorSelection.cursor(ctx.from - 1), scrollIntoView: true });
  } else {
    return;
  }
  view.focus();
}

/** Tab / Shift-Tab / arrows at an edge: next cell (`grow` appends a row after the last one). */
function moveByStep(host: TableHost, cell: HTMLElement, dir: 1 | -1, grow: boolean) {
  const cur = cursorOf(cell);
  const before = resolve(host);
  if (!before) return;
  const step = nextCursor({ table: before.table, cursor: cur }, dir);
  if (step.grow && !grow) return;
  commitCell(host, cell);
  const ctx = resolve(host);
  if (!ctx) return;
  if (step.grow) {
    applyTableEdit(
      host.view,
      ctx,
      insertRow(ctx.table, ctx.table.rows.length),
      step.cursor,
      "input.table.row",
    );
  }
  focusCell(host, ctx.from, step.cursor.row, step.cursor.col);
}

function moveVertical(host: TableHost, cell: HTMLElement, dir: 1 | -1) {
  const cur = cursorOf(cell);
  const ctx = resolve(host);
  if (!ctx) return;
  const last = ctx.table.rows.length - 1;
  const target = cur.row + dir;
  if (target < HEADER_ROW) return leaveTable(host, cell, "above");
  if (target > last) return leaveTable(host, cell, "below");
  commitCell(host, cell);
  const fresh = resolve(host);
  if (fresh) focusCell(host, fresh.from, target, cur.col);
}

function enterKey(host: TableHost, cell: HTMLElement) {
  const cur = cursorOf(cell);
  commitCell(host, cell);
  const ctx = resolve(host);
  if (!ctx) return;
  const last = ctx.table.rows.length - 1;
  if (cur.row >= 0 && cur.row === last && isBlankRow(ctx.table.rows[cur.row])) {
    const trimmed = deleteRow(ctx.table, cur.row);
    if (trimmed && !host.fullscreen) {
      host.view.dispatch(host.view.state.update(exitTable(host.view.state, ctx, trimmed)));
      host.view.focus();
      return;
    }
  }
  const target = cur.row === HEADER_ROW ? 0 : cur.row + 1;
  if (target > last) {
    applyTableEdit(
      host.view,
      ctx,
      insertRow(ctx.table, ctx.table.rows.length),
      { row: target, col: cur.col },
      "input.table.row",
    );
  }
  focusCell(host, ctx.from, target, cur.col);
}

function onKeyDown(host: TableHost, e: KeyboardEvent) {
  const text = e.target;
  if (!(text instanceof HTMLElement) || !text.classList.contains(CELL_TEXT_CLASS)) return;
  const cell = cellOf(text);
  if (!cell || e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey;
  const plain = !mod && !e.altKey && !e.shiftKey;
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  switch (e.key) {
    case "Tab":
      if (mod || e.altKey) return;
      stop();
      return moveByStep(host, cell, e.shiftKey ? -1 : 1, true);
    case "Enter":
      stop();
      if (mod) return leaveTable(host, cell, "exit");
      if (e.shiftKey || e.altKey) return insertAtCaret(text, "<br>");
      return enterKey(host, cell);
    case "Escape":
      if (host.fullscreen) return; // the overlay closes itself
      stop();
      return leaveTable(host, cell, "exit");
    case "ArrowRight":
    case "ArrowLeft": {
      if (!plain) return;
      const offset = caretOffset(text);
      const length = (text.textContent ?? "").length;
      const right = e.key === "ArrowRight";
      if (offset === null || offset !== (right ? length : 0)) return;
      stop();
      return moveByStep(host, cell, right ? 1 : -1, false);
    }
    case "ArrowDown":
    case "ArrowUp": {
      if (!plain) return;
      const down = e.key === "ArrowDown";
      if (!caretOnEdgeLine(text, down ? "down" : "up")) return;
      stop();
      return moveVertical(host, cell, down ? 1 : -1);
    }
    case "z":
    case "Z":
    case "y":
    case "Y": {
      if (!mod || e.altKey) return;
      stop();
      const redoKey = e.key.toLowerCase() === "y" || e.shiftKey;
      const dirty = readCellText(text) !== (cell.dataset.raw ?? "");
      if (dirty && !redoKey) {
        // Typed but not committed yet: undo means back to what the cell was.
        text.textContent = cell.dataset.raw ?? "";
        placeCaretAtEnd(text);
        return;
      }
      commitCell(host, cell);
      (redoKey ? redo : undo)(host.view);
      return;
    }
    default:
  }
}

function onPaste(host: TableHost, e: ClipboardEvent) {
  const text = e.target;
  if (!(text instanceof HTMLElement) || !text.classList.contains(CELL_TEXT_CLASS)) return;
  const cell = cellOf(text);
  if (!cell) return;
  e.preventDefault();
  e.stopPropagation();
  const data = e.clipboardData;
  const plain = data?.getData("text/plain") ?? "";
  let grid = gridFromClipboard(data);
  if (!grid && /\r|\n/.test(plain.replace(/(\r\n?|\n)$/, ""))) {
    grid = parseDelimited(plain, "\t").filter((r) => !(r.length === 1 && r[0] === ""));
  }
  if (grid && isMultiCell(grid)) {
    const cur = cursorOf(cell);
    commitCell(host, cell);
    const ctx = resolve(host);
    if (!ctx) return;
    host.view.dispatch(
      host.view.state.update(pasteIntoTable(host.view.state, { ...ctx, cursor: cur }, grid)),
    );
    return;
  }
  if (plain) insertAtCaret(text, escapeCell(plain));
}

// ---------------------------------------------------------------------------
// Handles and menus
// ---------------------------------------------------------------------------

/** Moves the caret into a cell's source, then runs a table command on it. Returns the table start. */
function runAt(
  host: TableHost,
  wrapper: Element | null,
  row: number,
  col: number,
  command: TableCommandId,
): number | null {
  commitActive(host, wrapper);
  const ctx = resolve(host);
  if (!ctx) return null;
  selectCellSource(host, ctx, row, col);
  runTableCommand(host.view, command);
  return ctx.from;
}

const ROW_MENU: ReadonlyArray<readonly [TableCommandId, string]> = [
  ["table.addRowAbove", "Insert row above"],
  ["table.addRowBelow", "Insert row below"],
  ["table.moveRowUp", "Move row up"],
  ["table.moveRowDown", "Move row down"],
  ["table.duplicateRow", "Duplicate row"],
  ["table.deleteRow", "Delete row"],
];

const COLUMN_MENU: ReadonlyArray<readonly [TableCommandId, string]> = [
  ["table.addColumnLeft", "Insert column left"],
  ["table.addColumnRight", "Insert column right"],
  ["table.moveColumnLeft", "Move column left"],
  ["table.moveColumnRight", "Move column right"],
  ["table.alignLeft", "Align left"],
  ["table.alignCenter", "Align center"],
  ["table.alignRight", "Align right"],
  ["table.sortAscending", "Sort A → Z"],
  ["table.sortDescending", "Sort Z → A"],
  ["table.deleteColumn", "Delete column"],
];

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeTableMenu(): void {
  openMenu?.close();
}

function showMenu(
  anchor: HTMLElement,
  items: ReadonlyArray<readonly [TableCommandId, string]>,
  run: (command: TableCommandId) => void,
) {
  closeTableMenu();
  const menu = el("div", "cm-table-menu");
  menu.setAttribute("role", "menu");
  for (const [command, label] of items) {
    const item = menu.appendChild(el("button", "cm-table-menu-item", label));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.dataset.command = command;
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => {
      close();
      run(command);
    });
  }
  const onOutside = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !menu.contains(e.target)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  function close() {
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    menu.remove();
    if (openMenu?.el === menu) openMenu = null;
  }
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top =
    rect.bottom + 4 + height > window.innerHeight
      ? Math.max(8, rect.top - height - 4)
      : rect.bottom + 4;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  openMenu = { el: menu, close };
}

function onClick(host: TableHost, e: MouseEvent) {
  const target =
    e.target instanceof Element ? e.target.closest<HTMLElement>("[data-action]") : null;
  if (!target) return;
  const wrapper = target.closest(".cm-table-widget");
  const cell = target.closest<HTMLElement>("[data-row]");
  const row = cell ? Number(cell.dataset.row) : HEADER_ROW;
  const col = cell?.dataset.col !== undefined ? Number(cell.dataset.col) : 0;
  const action = target.dataset.action;
  e.preventDefault();
  e.stopPropagation();

  const focusAfter = (from: number | null, r: number, c: number) => {
    if (from !== null) focusCell(host, from, r, c);
  };

  switch (action) {
    case "expand":
      commitActive(host, wrapper);
      return host.expand?.();
    case "source": {
      commitActive(host, wrapper);
      const from = host.from();
      if (from !== null) toggleTableSourceAt(host.view, from);
      return;
    }
    case "row-add":
      return focusAfter(runAt(host, wrapper, row, 0, "table.addRowBelow"), row + 1, 0);
    case "col-add":
      return focusAfter(
        runAt(host, wrapper, HEADER_ROW, col, "table.addColumnRight"),
        HEADER_ROW,
        col + 1,
      );
    case "end-row": {
      const ctx = resolve(host);
      if (!ctx) return;
      const last = ctx.table.rows.length - 1;
      return focusAfter(runAt(host, wrapper, last, 0, "table.addRowBelow"), last + 1, 0);
    }
    case "end-col": {
      const ctx = resolve(host);
      if (!ctx) return;
      const lastCol = columnCount(ctx.table) - 1;
      return focusAfter(
        runAt(host, wrapper, HEADER_ROW, lastCol, "table.addColumnRight"),
        HEADER_ROW,
        lastCol + 1,
      );
    }
    case "row-menu":
      return showMenu(target, ROW_MENU, (command) => void runAt(host, wrapper, row, 0, command));
    case "col-menu":
      return showMenu(
        target,
        COLUMN_MENU,
        (command) => void runAt(host, wrapper, HEADER_ROW, col, command),
      );
    default:
  }
}

export { focusInlineCell, getFullscreenHooks };
