import type { ReactNode } from "react";
import { ErrorBoundary } from "./error-boundary";
import { WindowControls } from "./window-controls";

/** What stays on screen whatever the app below does: a drag strip along the top edge and, on Linux,
 *  Writer's own window controls. Mounted once here, outside the error boundary, so the window can
 *  still be moved and closed before the app resolves its startup (it renders nothing then) and on
 *  the crash screen. The layouts draw their own, tighter drag regions above this one. */
export function AppRoot({ children }: { children: ReactNode }) {
  return (
    <>
      <div
        data-tauri-drag-region
        className="fixed inset-x-0 top-0 z-0"
        style={{ height: "var(--chrome-bar-height)" }}
      />
      <WindowControls />
      <ErrorBoundary>{children}</ErrorBoundary>
    </>
  );
}
