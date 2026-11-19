// Fullscreen view of a rendered table: the shared full-screen shell (`lib/fullscreen-overlay.ts`:
// backdrop, header, Escape, focus restore, one at a time, closed with the editor) around the same
// in-place cell editing and row/column handles as the inline table, scrolling both ways. It edits
// the note's own document through the editor view, so there is one undo history and the table in
// the note changes underneath.
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { HEADER_ROW, type MarkdownTable } from "./markdown-table";
import {
  buildTableDOM,
  closeTableMenu,
  syncTableDOM,
  type RenderTable,
  type TableHost,
} from "./table-cells";
import { activateLink } from "@/lib/link-activation";
import { closeFullscreen, closeFullscreenOwnedBy, openFullscreen } from "@/lib/fullscreen-overlay";
import { cellLinkAt } from "./table-links";
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
    linkTarget: (el) => {
      const link = cellLinkAt(el, state.view);
      if (!link) return null;
      // A note that opens in this tab or an active new one closes the dialog first, so it is not
      // left covering what you just navigated to. A background tab and a URL in the system
      // browser leave the table open.
      return {
        kind: "custom",
        open: (intent) => {
          if (!link.external && intent !== "new-tab-background") closeTableFullscreen();
          activateLink(link.target, intent);
        },
      };
    },
  };
}

export function closeTableFullscreen(): void {
  if (current) closeFullscreen();
}

export function openTableFullscreen(view: EditorView, from: number): void {
  closeTableFullscreen();
  const ctx = tableContextAtPos(view.state, from);
  if (!ctx) return;

  const state = { view, from: ctx.from };
  const { overlay, body } = openFullscreen({
    label: "Table",
    title: "Esc to close",
    className: "cm-table-fullscreen",
    owner: view,
    // a column menu handles its own Escape first
    allowEscape: () => !document.querySelector(".cm-table-menu"),
    onClose: () => {
      closeTableMenu();
      // Blur first so a cell being edited commits while the overlay is still the table's host.
      const active = document.activeElement;
      if (active instanceof HTMLElement && overlay.contains(active)) active.blur();
      current = null;
    },
  });
  body.classList.add("cm-table-fullscreen-body");

  const host = makeHost(state);
  const wrapper = buildTableDOM(renderTableOf(ctx.table), () => host);
  // The editor's theme rules (`.cm-inline-code`, `.cm-rendered-link`, `.cm-wiki-link`, the
  // `--pm-*` variables) are keyed on the classes of `view.dom` (`.cm-editor` and the generated
  // theme classes, light or dark); the overlay lives in `document.body`, so it carries the same
  // classes on an inner element (not on the overlay, whose layout `.cm-editor` would change).
  const scope = body.appendChild(document.createElement("div"));
  scope.className = [...view.dom.classList].filter((c) => c !== "cm-focused").join(" ");
  scope.classList.add("cm-table-fullscreen-scope");
  scope.appendChild(wrapper);

  current = { view, state, overlay, body, wrapper, host };

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
    closeFullscreenOwnedBy(view);
  },
  isOpenFor: (view) => current?.view === view,
});
