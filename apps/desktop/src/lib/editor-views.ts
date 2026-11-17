// The live CodeMirror editors (one per mounted editor pane) and the note each one shows. Core
// owns it: navigation (`reveal-line.ts`) finds the editor behind a path here, and a feature that
// extends editors (the Obsidian host's `editor.cm`) reads the same registry instead of keeping its
// own. `editorNotePath` hands extensions the note a state belongs to, so a contributed extension
// needs no per-editor argument (`createEditorExtensions` provides it).
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const views = new Map<EditorView, () => string>();

/** The live editors, each with a getter for the file path it currently shows. */
export const liveEditorViews: ReadonlyMap<EditorView, () => string> = views;

/** Register a mounted editor. `getPath` returns the file path it currently shows. */
export function registerEditorView(view: EditorView, getPath: () => string): () => void {
  views.set(view, getPath);
  return () => void views.delete(view);
}

/** The absolute path of the note an editor state shows (`""` outside a real editor). */
export const editorNotePath = Facet.define<() => string, () => string>({
  combine: (getters) => getters[0] ?? (() => ""),
});

function isVisible(view: EditorView): boolean {
  const pane = view.dom.closest<HTMLElement>("[data-pane]");
  return !pane || !pane.classList.contains("invisible");
}

/** The editor showing `path`; a visible pane wins when several panes show the same file. */
export function findEditorView(path: string | null): EditorView | null {
  if (!path) return null;
  let fallback: EditorView | null = null;
  for (const [view, getPath] of views) {
    if (getPath() !== path) continue;
    if (isVisible(view)) return view;
    fallback ??= view;
  }
  return fallback;
}
