import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { isImportableImageName } from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import { clearImageDropPreview, dropImagesAt, previewImageDropAt } from "./editor-image-insert";

/** Image paths among a drop's paths, in order. */
function imagePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => isImportableImageName(getFileName(path)));
}

/**
 * Route Tauri's OS drag-and-drop (Finder files: the webview gets no HTML5 events for them while
 * the window's drag-drop is on) to the editor under the pointer. Positions arrive in physical
 * pixels. The returned handler remembers across the gesture whether the drag carries images.
 */
export function createOsImageDropHandler(pixelRatio: () => number = () => window.devicePixelRatio) {
  let hasImages = false;
  return (event: DragDropEvent) => {
    if (event.type === "leave") {
      hasImages = false;
      clearImageDropPreview();
      return;
    }
    const ratio = pixelRatio() || 1;
    const x = event.position.x / ratio;
    const y = event.position.y / ratio;
    if (event.type === "enter") hasImages = imagePaths(event.paths).length > 0;
    if (event.type === "enter" || event.type === "over") {
      if (hasImages) previewImageDropAt(x, y);
      return;
    }
    hasImages = false;
    const paths = imagePaths(event.paths);
    if (paths.length === 0) {
      clearImageDropPreview();
      return;
    }
    dropImagesAt(
      x,
      y,
      paths.map((path) => ({ kind: "path", path })),
    );
  };
}

/** Mount once for the editor area: images dropped from Finder land at the drop point. */
export function useOsImageDrop(): void {
  useEffect(() => {
    const handle = createOsImageDropHandler();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => handle(event.payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No webview (tests, browser playground): nothing to route.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
