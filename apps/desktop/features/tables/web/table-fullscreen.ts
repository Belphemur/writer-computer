// Fullscreen view of a rendered table: a near-full-window panel over a dimmed backdrop, the same
// in-place cell editing and row/column handles as the inline table, scrolling both ways. It edits
// the note's own document through the editor view, so there is one undo history and the table in
// the note changes underneath. Escape, the close button or a click on the backdrop closes it and
// returns focus to the note. Pattern: `mermaid-fullscreen.ts`. One at a time; the editing plugin
// closes it when the editor goes away (the note or tab closes).
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { HEADER_ROW, type MarkdownTable } from "./markdown-table";
import {
  buildTableDOM,
  closeTableMenu,
  syncTableDOM,
  type RenderTable,
  type TableHost,
} from "./table-cells";
import { cellTextElement, setFullscreenHooks } from "./table-state";
import { tableContextAtPos } from "./table-editing";

export function renderTableOf(table: MarkdownTable): RenderTable {
  return {
    headers: table.header,
    alignments: table.align.map((a) => a ?? undefined),
    rows: table.rows,
  };
}

interface OpenFullscreen {
  view: EditorView;
  state: { view: EditorView; from: number };
  overlay: HTMLElement;
  body: HTMLElement;
  wrapper: HTMLElement;
  host: TableHost;
  restoreFocus: HTMLElement | null;
  onKey: (e: KeyboardEvent) => void;
}

let current: OpenFullscreen | null = null;

export function isTableFullscreenOpen(): boolean {
  return current !== null;
}

function makeHost(state: { view: EditorView; from: number }): TableHost {
  return {
    view: state.view,
    from: () => state.from,
    findCell: (_from, row, col) =>
      current?.wrapper.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`) ?? null,
    fullscreen: true,
  };
}

export function closeTableFullscreen(): void {
  const open = current;
  if (!open) return;
  closeTableMenu();
  // Blur first so a cell being edited commits while the overlay is still the table's host.
  const active = document.activeElement;
  if (active instanceof HTMLElement && open.overlay.contains(active)) active.blur();
  current = null;
  document.removeEventListener("keydown", open.onKey, true);
  open.overlay.remove();
  if (open.restoreFocus?.isConnected) open.restoreFocus.focus({ preventScroll: true });
  else if (open.view.dom.isConnected) open.view.focus();
}

export function openTableFullscreen(view: EditorView, from: number): void {
  closeTableFullscreen();
  const ctx = tableContextAtPos(view.state, from);
  if (!ctx) return;

  const state = { view, from: ctx.from };
  const overlay = document.createElement("div");
  overlay.className = "cm-table-fullscreen";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Table");

  const panel = overlay.appendChild(document.createElement("div"));
  panel.className = "cm-table-fullscreen-panel";
  const bar = panel.appendChild(document.createElement("div"));
  bar.className = "cm-table-fullscreen-bar";
  bar.appendChild(document.createElement("span")).textContent = "Esc to close";
  const close = bar.appendChild(document.createElement("button"));
  close.type = "button";
  close.className = "cm-table-fullscreen-close";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close fullscreen table");
  close.addEventListener("click", closeTableFullscreen);
  const body = panel.appendChild(document.createElement("div"));
  body.className = "cm-table-fullscreen-body";

  const host = makeHost(state);
  const wrapper = buildTableDOM(renderTableOf(ctx.table), () => host);
  body.appendChild(wrapper);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || document.querySelector(".cm-table-menu")) return;
    e.preventDefault();
    e.stopPropagation();
    closeTableFullscreen();
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeTableFullscreen();
  });

  current = {
    view,
    state,
    overlay,
    body,
    wrapper,
    host,
    restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    onKey,
  };
  document.body.appendChild(overlay);
  if (typeof requestAnimationFrame === "function")
    requestAnimationFrame(() => overlay.classList.add("is-open"));
  else overlay.classList.add("is-open");

  // Start in the first cell unless the note's caret was already in this table.
  const caret = tableContextAtPos(view.state, view.state.selection.main.head);
  const start =
    caret && caret.from === ctx.from && caret.cursor.row >= HEADER_ROW
      ? caret.cursor
      : { row: HEADER_ROW, col: 0 };
  const cell = wrapper.querySelector<HTMLElement>(
    `[data-row="${start.row}"][data-col="${start.col}"]`,
  );
  (cell ? cellTextElement(cell) : null)?.focus();
}

/** Called by the editing plugin on every editor update: keep the overlay's table in step. */
function onUpdate(update: ViewUpdate): void {
  const open = current;
  if (!open || update.view !== open.view || !update.docChanged) return;
  open.state.from = update.changes.mapPos(open.state.from, -1);
  const ctx = tableContextAtPos(update.state, open.state.from);
  if (!ctx) {
    queueMicrotask(closeTableFullscreen);
    return;
  }
  open.state.from = ctx.from;
  const render = renderTableOf(ctx.table);
  if (syncTableDOM(open.wrapper, render)) return;
  const next = buildTableDOM(render, () => open.host);
  open.wrapper.replaceWith(next);
  open.wrapper = next;
}

setFullscreenHooks({
  update: onUpdate,
  close: (view) => {
    if (current?.view === view) closeTableFullscreen();
  },
  isOpenFor: (view) => current?.view === view,
});
