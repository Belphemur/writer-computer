// Bridge between the app's CodeMirror editors and the plugin shim.
//
// - Registry of live EditorViews (one per mounted editor pane) so the shim's `Editor` facade can
//   expose the active one as `editor.cm`.
// - One shared Compartment carrying the extensions plugins pass to `registerEditorExtension`.
//   `createEditorExtensions` adds it to every editor; `setPluginEditorExtensions` reconfigures all
//   live views when a plugin is enabled/disabled. A Compartment is a shared key: each view keeps
//   its own value for it, so one instance serves every editor.
import { Compartment, EditorSelection, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EditorBackend, EditorSelectionRange } from "./api/views";

export const pluginExtensionCompartment = new Compartment();

let currentExtensions: Extension[] = [];
const views = new Map<EditorView, () => string>();

/** Register a mounted editor. `getPath` returns the file path it currently shows. */
export function registerEditorView(view: EditorView, getPath: () => string): () => void {
  views.set(view, getPath);
  return () => void views.delete(view);
}

/** Initial value for the compartment of a newly created editor. */
export function getPluginEditorExtensions(): Extension[] {
  return currentExtensions;
}

/**
 * Applies `extensions` to every live editor. A view that rejects them (a plugin handed over an
 * invalid extension) is reset to none so the editor keeps working; the first error is returned.
 */
export function setPluginEditorExtensions(extensions: Extension[]): Error | null {
  currentExtensions = extensions;
  let failure: Error | null = null;
  for (const view of views.keys()) {
    try {
      view.dispatch({ effects: pluginExtensionCompartment.reconfigure(extensions) });
    } catch (e) {
      failure ??= e instanceof Error ? e : new Error(String(e));
      console.error("[plugin] editor extension rejected:", e);
      try {
        view.dispatch({ effects: pluginExtensionCompartment.reconfigure([]) });
      } catch (resetError) {
        console.error("[plugin] could not reset editor extensions:", resetError);
      }
    }
  }
  if (failure) currentExtensions = [];
  return failure;
}

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

/** Offset-based editor backend over a CodeMirror view (what the shim's `Editor` drives). */
export function editorBackendFor(view: EditorView): EditorBackend {
  return {
    cm: view,
    getValue: () => view.state.doc.toString(),
    replaceRange: (from, to, text) => view.dispatch({ changes: { from, to, insert: text } }),
    getSelections: () =>
      view.state.selection.ranges.map((r): EditorSelectionRange => ({
        anchor: r.anchor,
        head: r.head,
      })),
    setSelections: (ranges) => {
      if (ranges.length === 0) return;
      const len = view.state.doc.length;
      const clamp = (n: number) => Math.min(Math.max(n, 0), len);
      view.dispatch({
        selection: EditorSelection.create(
          ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))),
          0,
        ),
      });
    },
    focus: () => view.focus(),
  };
}
