import { Suspense, lazy, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { closeFullscreen, openFullscreen } from "@/lib/fullscreen-overlay";
import { getFileName } from "@/lib/paths";
import { flushLiveView } from "../lib/live-views";

// The canvas is its own chunk, fetched when the first drawing opens full screen.
const DrawingCanvas = lazy(() =>
  import("./drawing-canvas").then((m) => ({ default: m.DrawingCanvas })),
);

/** The name the header shows: the file's, without `.excalidraw` or `.excalidraw.md`. */
export function drawingTitle(path: string): string {
  return getFileName(path).replace(/\.excalidraw(\.md)?$/i, "");
}

// What Excalidraw 0.18.1 renders while one of its popovers (`Popover`: pickers), dropdown menus
// (the main menu, font and shape menus), the context menu or a dialog (`Modal`, `Dialog`) is open;
// Esc closes that first. A dropdown or modal is only in the DOM while open.
const EXCALIDRAW_OPEN_LAYER = ".popover, .dropdown-menu, .context-menu, .Modal, .Dialog";

/** Esc belongs to the canvas, not the full screen: a text box has the focus (Excalidraw leaves it
 *  first) or one of its popovers, menus or dialogs is open. */
export function escapeBelongsToCanvas(overlay: HTMLElement): boolean {
  const box = document.activeElement?.closest("textarea, input, [contenteditable='true']");
  if (box && overlay.contains(box)) return true;
  return overlay.querySelector(EXCALIDRAW_OPEN_LAYER) !== null;
}

/**
 * A drawing full screen (ADR 2026-11-18, the last line): read-only first, so panning, zooming and
 * following links cannot change the file; Edit switches the same canvas to editing over the
 * shared session and save path, Done goes back. Esc, the close button or a backdrop press close
 * it and flush what was drawn. The shell is core's (`@/lib/fullscreen-overlay`).
 */
export function openDrawingFullscreen(path: string, owner?: EditorView): void {
  const title = drawingTitle(path);
  const handle = openFullscreen({
    label: `Drawing ${title}`,
    title,
    className: "writer-drawing-fullscreen",
    owner,
    allowEscape: () => !escapeBelongsToCanvas(handle.overlay),
    onClose: () => {
      // edits are already on their way through the session; this writes what is pending now
      void flushLiveView(path);
      root.unmount();
    },
  });
  handle.body.style.overflow = "clip"; // the canvas fills it and owns the pointer
  const root = createRoot(handle.body);
  root.render(<DrawingFullscreen path={path} actions={handle.actions!} />);
}

function DrawingFullscreen({ path, actions }: { path: string; actions: HTMLElement }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      {createPortal(
        <button
          type="button"
          data-testid="drawing-fullscreen-mode"
          className="writer-fullscreen-action"
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Done" : "Edit"}
        </button>,
        actions,
      )}
      <div data-testid="drawing-fullscreen-stage" data-editing={editing} className="h-full">
        <Suspense
          fallback={
            <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Loading drawing</div>
          }
        >
          <DrawingCanvas
            path={path}
            viewMode={!editing}
            autoFocus
            beforeVaultLink={closeFullscreen}
          />
        </Suspense>
      </div>
    </>
  );
}
