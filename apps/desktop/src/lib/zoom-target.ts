/**
 * Cmd+= / Cmd+- / Cmd+0 zoom the editor text, except while a page that zooms something else is
 * active (the image viewer). That page registers a handler while it is the active tab; `hooks/
 * zoom-api` asks here first, so the chords, the command palette and the menus share one rule.
 */
export type ZoomAction = "in" | "out" | "reset";

let handler: ((action: ZoomAction) => void) | null = null;

/** Make `fn` receive the zoom actions until the returned function is called. */
export function setZoomTarget(fn: (action: ZoomAction) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Run the registered zoom target. False when none is active (zoom the editor text). */
export function runZoomTarget(action: ZoomAction): boolean {
  if (!handler) return false;
  handler(action);
  return true;
}
