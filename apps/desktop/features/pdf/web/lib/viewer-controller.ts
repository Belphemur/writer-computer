// The one handle the keybinding commands have on the reader of the active PDF tab. The viewer
// registers itself while its tab is active; the commands (`../index.ts`) call it. Tiny and
// import-free: it is part of the startup chunk.
export interface ViewerController {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  find: () => void;
}

let current: ViewerController | null = null;

/** Make `controller` the target of the PDF commands until the returned function is called. */
export function registerViewer(controller: ViewerController): () => void {
  current = controller;
  return () => {
    if (current === controller) current = null;
  };
}

export const activeViewer = (): ViewerController | null => current;
