// Bridge between the app's CodeMirror editors and the plugin shim.
//
// - Registry of live EditorViews (one per mounted editor pane) so the shim's `Editor` facade can
//   expose the active one as `editor.cm`.
// - One shared Compartment carrying the extensions plugins pass to `registerEditorExtension`.
//   `createEditorExtensions` adds it to every editor; `setPluginEditorExtensions` reconfigures all
//   live views when a plugin is enabled/disabled. A Compartment is a shared key: each view keeps
//   its own value for it, so one instance serves every editor.
import { markdown } from "@codemirror/lang-markdown";
import { language } from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { logger } from "@/lib/logger";
import { liveEditorViews } from "@/lib/editor-views";
import type { EditorBackend, EditorSelectionRange } from "./api/views";

export const pluginExtensionCompartment = new Compartment();

/**
 * What `view.state.field(editorInfoField)` yields (`MarkdownFileInfo`): the note and editor behind a
 * CodeMirror view. Resolved lazily through the host (set by `PluginHost`), so the value stays
 * valid across state updates and is empty when no host is attached.
 */
export interface EditorInfo {
  app: unknown;
  file: unknown;
  editor: unknown;
  hoverPopover: null;
}
export type EditorInfoResolver = (
  view: EditorView,
  absPath: string,
) => Omit<EditorInfo, "hoverPopover">;
let editorInfoResolver: EditorInfoResolver | null = null;
/** Installed by the host on creation (and cleared with `null` on shutdown). */
export function setEditorInfoResolver(resolver: EditorInfoResolver | null): void {
  editorInfoResolver = resolver;
}

function viewOwning(info: EditorInfo): EditorView | null {
  for (const view of views.keys())
    if (view.state.field(editorInfoField, false) === info) return view;
  return null;
}
function resolveInfo(info: EditorInfo, key: "app" | "file" | "editor"): unknown {
  const view = viewOwning(info);
  const path = view ? views.get(view)?.() : null;
  if (!view || !path || !editorInfoResolver) return null;
  return editorInfoResolver(view, path)[key];
}

/** Public `editorInfoField`: a CodeMirror field every Writer editor carries. */
export const editorInfoField: StateField<EditorInfo> = StateField.define<EditorInfo>({
  create() {
    const info = { hoverPopover: null } as EditorInfo;
    for (const key of ["app", "file", "editor"] as const)
      Object.defineProperty(info, key, { get: () => resolveInfo(info, key), enumerable: true });
    return info;
  },
  update: (value) => value,
});
/** Public `editorLivePreviewField`: Writer's editor always renders live (never plain source mode). */
export const editorLivePreviewField: StateField<boolean> = StateField.define<boolean>({
  create: () => true,
  update: (value) => value,
});
/** Public `editorEditorField`: the owning EditorView of this state. */
export const editorEditorField: StateField<EditorView | null> =
  StateField.define<EditorView | null>({
    create: () => null,
    update: (value, tr) => {
      for (const view of views.keys()) if (view.state === tr.startState) return view;
      return value;
    },
  });
/** Public `editorViewField`: the file info (same value as `editorInfoField`). */
export const editorViewField = editorInfoField;
/** Public `livePreviewState`: kept as an inert extension. */
export const livePreviewState: Extension = [];

const hostFields: Extension = [editorInfoField, editorLivePreviewField];

let currentExtensions: Extension[] = [];
const views = liveEditorViews;

/** Initial value for the plugin compartment of a newly created editor (host fields + plugin extensions). */
export function getPluginCompartmentValue(): Extension {
  return [hostFields, ...currentExtensions];
}

/** The plugins' own extensions (what `registerEditorExtension` recorded). */
export function getPluginEditorExtensions(): Extension[] {
  return currentExtensions;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Builds `extension` into a throwaway state AND a detached view (with the host fields and a
 * markdown tree, like a live editor), then runs one edit through it. A field that throws on
 * create, a facet provider that throws or returns junk, a view plugin that cannot be built, or a
 * value from a mismatched `@codemirror/state` instance all show up here instead of in the user's
 * editor. Returns the failure, or null when the extension is safe to add.
 */
export function validatePluginExtension(extension: Extension): Error | null {
  let view: EditorView | null = null;
  try {
    const doc = "# Heading\n\nText with **bold** and a [[link]].\n";
    const md = markdown();
    const base = EditorState.create({ doc, extensions: [md, hostFields] });
    const state = EditorState.create({ doc, extensions: [md, hostFields, extension] });
    // Writer's markdown language must stay the document's language: an extension that supplies
    // another one (at a higher precedence) empties the markdown syntax tree, and every
    // tree-driven decoration (hidden markup, headings, emphasis, callouts) goes raw.
    if (state.facet(language) !== base.facet(language))
      throw new Error("the extension replaces the editor's language (markdown)");
    view = new EditorView({ state, parent: document.createElement("div") });
    view.dispatch({ changes: { from: doc.length, insert: "x" } });
    view.dispatch({ selection: { anchor: 0 } });
    return null;
  } catch (e) {
    return toError(e);
  } finally {
    try {
      view?.destroy();
    } catch {
      /* the throwaway view is gone either way */
    }
  }
}

const appendVerdicts = new WeakMap<object, Error | null>();

/**
 * Transaction filter for every Writer editor. Plugins reach the view through `editor.cm` and may
 * dispatch top-level `StateEffect.reconfigure` (replaces the WHOLE configuration: the markdown
 * language, Prosemark and every Writer extension are gone) or `appendConfig` (can add a language
 * that wins over markdown). Writer never uses either, so the first is dropped and the second is
 * only kept when the extension passes `validatePluginExtension`; the rest of the transaction
 * (changes, selection, other effects) goes through untouched.
 */
export const pluginConfigGuard: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.effects.some((e) => e.is(StateEffect.reconfigure) || e.is(StateEffect.appendConfig)))
    return tr;
  let dropped = null as string | null;
  const effects = tr.effects.filter((e) => {
    if (e.is(StateEffect.reconfigure)) {
      dropped = "a top-level editor reconfigure";
      return false;
    }
    if (e.is(StateEffect.appendConfig)) {
      const value = e.value as Extension;
      let verdict: Error | null | undefined =
        typeof value === "object" && value ? appendVerdicts.get(value) : undefined;
      if (verdict === undefined) {
        verdict = validatePluginExtension(value);
        if (typeof value === "object" && value) appendVerdicts.set(value, verdict);
        if (verdict) logger.warn("plugin", `editor appendConfig rejected: ${verdict.message}`);
      }
      if (verdict) {
        dropped = `an editor extension (${verdict.message})`;
        return false;
      }
    }
    return true;
  });
  if (dropped === null) return tr;
  return {
    changes: tr.changes,
    selection: tr.selection,
    effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
    annotations: [
      Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) ?? true),
      Transaction.remote.of(tr.annotation(Transaction.remote) ?? false),
    ],
    filter: false,
  };
});

/**
 * Applies `extensions` to every live editor. Each extension is validated in isolation first
 * (`owners[i]` names the plugin that registered `extensions[i]`, for the log); a rejected one is
 * dropped and logged while the rest still apply, so a broken plugin extension can never take
 * Writer's own editor extensions (live preview, hiding, decorations) down with it. The first
 * rejection is returned.
 */
export function setPluginEditorExtensions(
  extensions: Extension[],
  owners: readonly string[] = [],
): Error | null {
  let failure: Error | null = null;
  const accepted: Extension[] = [];
  extensions.forEach((extension, i) => {
    const error = validatePluginExtension(extension);
    if (!error) {
      accepted.push(extension);
      return;
    }
    failure ??= error;
    const plugin = owners[i];
    logger.warn("plugin", `editor extension rejected and skipped: ${error.message}`, {
      plugin,
      phase: "editor-extension",
      stack: error.stack,
    });
    console.warn(`[plugin] editor extension from ${plugin ?? "unknown"} rejected:`, error);
  });
  currentExtensions = accepted;
  for (const view of views.keys()) {
    try {
      view.dispatch({
        effects: pluginExtensionCompartment.reconfigure([hostFields, ...accepted]),
      });
    } catch (e) {
      failure ??= toError(e);
      logger.warn("plugin", `editor extensions rejected by a live editor: ${toError(e).message}`, {
        phase: "editor-extension",
        stack: toError(e).stack,
      });
      try {
        view.dispatch({ effects: pluginExtensionCompartment.reconfigure([hostFields]) });
      } catch (resetError) {
        console.error("[plugin] could not reset editor extensions:", resetError);
      }
    }
  }
  return failure;
}

/** Re-dispatches the current plugin extensions to every live editor (`Workspace.updateOptions`). */
export function reapplyPluginEditorExtensions(): void {
  setPluginEditorExtensions(currentExtensions);
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
