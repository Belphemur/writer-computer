// The small shared state of the rendered tables: which tables are shown as markdown source (the
// opt-in "Edit source" view), how to find a rendered cell in the editor DOM, and the hooks the
// fullscreen overlay registers so the editing plugin can keep it in sync. Kept free of imports
// from the rest of the feature so `table-editing.ts`, `table-cells.ts` and `table-fullscreen.ts`
// can all use it without a cycle.
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";

/** Toggles the source view of the table whose first line starts at this position. */
export const toggleTableSource = StateEffect.define<number>();

/** Line starts of the tables currently shown as markdown source. Absent field = legacy source-only. */
export const tableSourceField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.length > 0) next = next.map((pos) => tr.changes.mapPos(pos, -1));
    for (const effect of tr.effects) {
      if (!effect.is(toggleTableSource)) continue;
      next = next.includes(effect.value)
        ? next.filter((pos) => pos !== effect.value)
        : [...next, effect.value];
    }
    return next;
  },
});

/**
 * Is the table starting at line start `from` shown as source? Without the field (an editor that has
 * the editing extension but not the rendering one) tables are always source, as before.
 */
export function isTableSource(state: EditorState, from: number): boolean {
  const field = state.field(tableSourceField, false);
  return field === undefined ? true : field.includes(from);
}

export const CELL_TEXT_CLASS = "cm-table-cell-text";

/** The content element of a rendered cell (`td`/`th`). */
export function cellTextElement(cell: Element): HTMLElement | null {
  return cell.querySelector<HTMLElement>(`.${CELL_TEXT_CLASS}`);
}

/** The rendered cell of the table whose first line starts at `from`, in the editor's own DOM. */
export function findInlineCell(
  view: EditorView,
  from: number,
  row: number,
  col: number,
): HTMLElement | null {
  for (const widget of view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget")) {
    let pos: number;
    try {
      pos = view.posAtDOM(widget);
    } catch {
      continue;
    }
    if (view.state.doc.lineAt(pos).from !== from) continue;
    return widget.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  }
  return null;
}

/** Puts the DOM focus (and so the typing) in a rendered cell. Returns false when it is not rendered. */
export function focusInlineCell(view: EditorView, from: number, row: number, col: number): boolean {
  const cell = findInlineCell(view, from, row, col);
  const text = cell ? cellTextElement(cell) : null;
  if (!text) return false;
  text.focus();
  return true;
}

export interface FullscreenHooks {
  update(update: ViewUpdate): void;
  close(view: EditorView): void;
  isOpenFor(view: EditorView): boolean;
}

let fullscreenHooks: FullscreenHooks | null = null;
export function setFullscreenHooks(hooks: FullscreenHooks | null): void {
  fullscreenHooks = hooks;
}
export function getFullscreenHooks(): FullscreenHooks | null {
  return fullscreenHooks;
}
