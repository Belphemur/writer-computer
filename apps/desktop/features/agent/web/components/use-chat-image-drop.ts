import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { dropOnChatComposer, isOverChatComposer } from "@features/agent/web/lib/chat-image-target";
import { isImportableImageName } from "@/lib/attachments";
import { getFileName } from "@/lib/paths";

/**
 * Finder files dropped on the agent composer. Tauri's OS drag-drop reports them (the webview gets
 * no HTML5 events for files while the window's drag-drop is on) with a position in physical pixels;
 * the composer is found by `chat-image-target`, so the editor's own drop hook (which only accepts
 * an insert-target editor under the pointer) and this one never both act. Returns whether an image
 * drag is over the composer, for the drop highlight.
 */
export function useChatImageOsDrop(enabled: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let hasImages = false;
    // `getCurrentWebview()` throws without a webview; inside a promise that is the same ignored
    // rejection as a failed listen.
    Promise.resolve()
      .then(() => getCurrentWebview())
      .then((webview) =>
        webview.onDragDropEvent(({ payload }) => {
          if (payload.type === "leave") {
            hasImages = false;
            setOver(false);
            return;
          }
          const ratio = window.devicePixelRatio || 1;
          const x = payload.position.x / ratio;
          const y = payload.position.y / ratio;
          const paths =
            payload.type === "enter" || payload.type === "drop"
              ? payload.paths.filter((p) => isImportableImageName(getFileName(p)))
              : [];
          if (payload.type === "enter") hasImages = paths.length > 0;
          if (payload.type !== "drop") {
            setOver(hasImages && isOverChatComposer(x, y));
            return;
          }
          hasImages = false;
          setOver(false);
          // every dropped image (including a type the model cannot read: attaching says so)
          if (paths.length > 0)
            dropOnChatComposer(
              x,
              y,
              paths.map((path) => ({ kind: "path" as const, path })),
            );
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No webview (tests, the browser playground): nothing to route.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
  return over;
}
