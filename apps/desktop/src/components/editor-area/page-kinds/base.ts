import { getFileName, isBasePath } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * A `.base` file shown as a table. `view` is the selected view name (persisted per tab so the
 * choice survives a restart); `undefined` means the base's first view.
 */
export type BaseLocation = { kind: "base"; path: string; view?: string };

// The path is not a text document: the view queries it through the Bases backend, so the editor
// store never reads it (`loadsDocument: false`). The view (BaseView) is registered in `./views`.
export const baseKind = definePageKind<"base", BaseLocation>({
  kind: "base",
  title: (l) => getFileName(l.path).replace(/\.base$/i, ""),
  description: "Obsidian base",
  keepAlive: true,
  supportsFileContextMenu: true,
  loadsDocument: false,
  // The view is the `bases` feature's; off, a `.base` opens as text (`locationForPath`).
  feature: "bases",
  forPath: (path) => (isBasePath(path) ? { kind: "base", path } : null),
  fromPayload: (data) =>
    typeof data.path === "string"
      ? {
          kind: "base",
          path: data.path,
          ...(typeof data.view === "string" && data.view ? { view: data.view } : {}),
        }
      : null,
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path, ...(l.view ? { view: l.view } : {}) }),
});
