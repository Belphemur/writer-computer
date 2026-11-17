// Editor extensions contributed by features. `createEditorExtensions` adds one Compartment
// (`featureEditorExtensions()`); each contribution's `load` thunk is called the first time an
// editor needs it (a dynamic import, so the code is not in the startup chunk), and when the set
// of loaded, applicable contributions changes every live editor is reconfigured. That makes
// enabling and disabling a feature live: unregistering removes its extension from open editors.
import { Compartment, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { logger } from "@/lib/logger";
import { OwnedRegistry } from "@/lib/owned-registry";

export interface EditorExtensionContribution {
  owner: string;
  /** `<feature id>.<name>`. */
  id: string;
  /** Re-evaluated whenever the set is recomputed; omitted means always. */
  when?: () => boolean;
  /** Loads the code; called once per registration, never at registration. */
  load: () => Promise<Extension>;
}

export const editorExtensionContributions = new OwnedRegistry<EditorExtensionContribution>();

const compartment = new Compartment();
const views = new Set<EditorView>();
const loaded = new WeakMap<EditorExtensionContribution, Extension>();
const started = new WeakSet<EditorExtensionContribution>();

const tracker = ViewPlugin.define((view) => {
  views.add(view);
  return { destroy: () => void views.delete(view) };
});

function current(): Extension[] {
  return editorExtensionContributions
    .list()
    .filter((c) => loaded.has(c) && (c.when?.() ?? true))
    .map((c) => loaded.get(c)!);
}

function refresh(): void {
  const value = current();
  for (const view of views) view.dispatch({ effects: compartment.reconfigure(value) });
}

// Nothing loads before an editor exists: the first `featureEditorExtensions()` call is the demand.
let demanded = false;

function startLoads(): void {
  if (!demanded) return;
  for (const c of editorExtensionContributions.list()) {
    if (started.has(c) || (c.when && !c.when())) continue;
    started.add(c);
    c.load().then(
      (ext) => {
        if (editorExtensionContributions.get(c.id) !== c) return; // unregistered while loading
        loaded.set(c, ext);
        refresh();
      },
      (e) => logger.error("app", `editor extension ${c.id} failed to load: ${String(e)}`),
    );
  }
}

editorExtensionContributions.subscribe(() => {
  refresh();
  startLoads();
});

/** The one extension `createEditorExtensions` adds: the loaded contributions, kept current. */
export function featureEditorExtensions(): Extension {
  demanded = true;
  startLoads();
  return [compartment.of(current()), tracker];
}
