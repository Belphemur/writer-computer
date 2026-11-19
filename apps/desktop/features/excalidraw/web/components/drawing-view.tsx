import { useCallback, useEffect } from "react";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import type { DrawingLocation } from "@/components/editor-area/page-kinds/drawing";
import type { PageViewProps } from "@/lib/features/slots";
import { logger } from "@/lib/logger";
import { getFileName } from "@/lib/paths";
import { useDiskStore } from "../disk-sync";
import { exportSvgFile, svgPathOf } from "../lib/export-svg";
import { offerTakeover } from "../lib/takeover";
import { DrawingCanvas } from "./drawing-canvas";

/**
 * The drawing tab (page kind `drawing`, slot `page-view:drawing`): the shared canvas over one
 * file, plus the tab's own pieces: the deleted notice and the SVG export button (docs/design.md:
 * it mounts in `PageBody`, owns no scroller of its own, and a kept-alive tab hides when
 * inactive). The session, its saves and the reload from outside are `lib/sessions.ts`'s.
 */
export function DrawingView({ location, isActive }: PageViewProps<DrawingLocation>) {
  const path = location.path;
  const deleted = useDiskStore((s) => s.views[path]?.deleted ?? false);

  useEffect(() => {
    useDiskStore.getState().track(path);
    return () => useDiskStore.getState().forget(path);
  }, [path]);

  useEffect(() => {
    void offerTakeover();
  }, []);

  const exportSvg = useCallback(async () => {
    try {
      const svg = await exportSvgFile(path);
      showEditorNotice(`Saved ${getFileName(svg)}`);
    } catch (e) {
      logger.warn("excalidraw", `SVG export failed: ${String(e)}`);
      showEditorNotice("Could not export the drawing as SVG");
    }
  }, [path]);

  return (
    <div
      data-pane
      data-testid="drawing-view"
      className={
        isActive
          ? "relative z-10 flex h-full flex-col"
          : "absolute inset-0 invisible pointer-events-none"
      }
    >
      {deleted ? (
        <div
          data-testid="drawing-deleted"
          className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"
        >
          This drawing was deleted.
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <DrawingCanvas
            path={path}
            topRight={() => (
              <button
                type="button"
                data-testid="drawing-export-svg"
                title={`Write ${getFileName(svgPathOf(path))}`}
                onClick={() => void exportSvg()}
                className="rounded-md px-2 py-1 text-[12px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
              >
                Export SVG
              </button>
            )}
          />
        </div>
      )}
    </div>
  );
}
