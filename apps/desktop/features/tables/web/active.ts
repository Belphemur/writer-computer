// The light half of table editing's state: which editor the palette commands act on, and whether
// its caret is in a table. The table chunk fills it in once it is loaded; before that no editor
// has the table extension, so "no view" is the correct answer. Kept apart from `table-editing.ts`
// so the always-loaded `index.ts` can answer a palette command's `when` without importing it.
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

let activeView: EditorView | null = null;
let contextProbe: ((state: EditorState) => boolean) | null = null;

/** The editor the table commands in the palette act on (the last one that had focus). */
export function getTableEditorView(): EditorView | null {
  return activeView;
}

export function setTableEditorView(view: EditorView | null): void {
  activeView = view;
}

/** Installed by the table chunk: is the caret of `state` in a table? */
export function setTableContextProbe(probe: ((state: EditorState) => boolean) | null): void {
  contextProbe = probe;
}

export function isCaretInTable(): boolean {
  return activeView !== null && (contextProbe?.(activeView.state) ?? false);
}
