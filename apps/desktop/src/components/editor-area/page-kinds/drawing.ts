import { drawingsHandledNatively } from "@/lib/drawing-files";
import { getFileName, isDrawingPath } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * An Excalidraw drawing (`.excalidraw.md` in the Obsidian plugin's shape, or plain `.excalidraw`)
 * in the canvas. The path is not a text document (`loadsDocument: false`): the view reads and
 * writes the file through its own codec. The view is the `excalidraw` feature's
 * (`page-view:drawing`); while the feature is off the kind keeps claiming its files
 * (`claimsWhenOff`: raw drawing data is not what a click should open) and the tab shows the
 * "turned off" page with Open as text. With `excalidraw.handle-files` set to the plugin it claims
 * nothing, so the Obsidian plugin's view opens them.
 */
export type DrawingLocation = { kind: "drawing"; path: string };

/** Obsidian's tab title: the file name without `.md` and without `.excalidraw`. */
const titleOf = (path: string): string =>
  getFileName(path)
    .replace(/\.md$/i, "")
    .replace(/\.excalidraw$/i, "");

export const drawingKind = definePageKind<"drawing", DrawingLocation>({
  kind: "drawing",
  title: (l) => titleOf(l.path),
  description: "Drawing",
  keepAlive: true,
  supportsFileContextMenu: true,
  loadsDocument: false,
  feature: "excalidraw",
  claimsWhenOff: true,
  forPath: (path) =>
    isDrawingPath(path) && drawingsHandledNatively() ? { kind: "drawing", path } : null,
  fromPayload: (data) =>
    typeof data.path === "string" ? { kind: "drawing", path: data.path } : null,
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
