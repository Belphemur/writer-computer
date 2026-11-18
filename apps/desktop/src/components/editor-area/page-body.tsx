import type { ReactNode } from "react";

/**
 * The one container every page kind's body mounts in. The window chrome (tab strip, back and
 * forward) floats over the top `--chrome-bar-height` of the editor area, so the body starts below
 * it: a view never reserves the chrome's height itself. It is the positioned ancestor and clips
 * its content, which confines `absolute`/`inset-0` children (the keep-alive panes hidden with
 * `invisible`, canvases) to the body. A view that must draw outside it (menus, popovers) portals
 * to `document.body` on purpose; `tests/page-body-contract.test.tsx` lists those.
 */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="page-body"
      className="absolute inset-x-0 bottom-0 min-h-0 overflow-clip"
      style={{ top: "var(--chrome-bar-height)" }}
    >
      {children}
    </div>
  );
}
