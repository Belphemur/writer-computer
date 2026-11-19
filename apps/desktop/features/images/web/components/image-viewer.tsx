import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageLocation } from "@/components/editor-area/page-kinds/image";
import { ZoomControl } from "@/components/zoom-control";
import { useElementSize } from "@/hooks/use-element-size";
import { useZoomGestures } from "@/hooks/use-zoom-gestures";
import type { PageViewProps } from "@/lib/features/slots";
import { logger } from "@/lib/logger";
import { getFileName } from "@/lib/paths";
import { openAttachmentInDefaultApp, readFile } from "@/lib/tauri";
import { ZOOM_STEP, type Point, type Size } from "@/lib/viewer-zoom";
import { useDiskStore, withVersion } from "../disk-sync";
import { svgIntrinsicSize } from "../lib/svg-size";
import { registerViewer } from "../lib/viewer-controller";
import {
  canPan,
  pageCenter,
  panBy,
  resolveView,
  toggleActualSize,
  zoomBy,
  zoomTo,
  type View,
} from "../lib/view-transform";

const isSvg = (path: string) => path.toLowerCase().endsWith(".svg");

/**
 * The image viewer (page kind `image`, slot `page-view:image`): one `<img>` under the view
 * transform of `../lib/view-transform.ts`, and the footer. It fits the page by default (scaling up
 * as well as down), zooms toward the pointer (pinch, Cmd/Ctrl + wheel), pans (drag, wheel) and
 * toggles Fit and 100% on double-click; Cmd/Ctrl `=`, `-` and `0` reach it through
 * `../lib/viewer-controller.ts`. The size is laid out, never a CSS scale, so an SVG is redrawn
 * as a vector at every zoom and an animated image keeps animating. The page has no scroller: the
 * stage clips and the transform moves the image.
 */
export function ImageViewer({ location, isActive }: PageViewProps<ImageLocation>) {
  const path = location.path;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const page = useElementSize(stageRef);
  const [view, setView] = useState<View>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [svg, setSvg] = useState<{ size: Size | null; done: boolean }>({ size: null, done: false });
  const [failed, setFailed] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const disk = useDiskStore((s) => s.views[path]);
  const version = disk?.version ?? 0;
  const deleted = disk?.deleted ?? false;
  const vector = isSvg(path);

  useEffect(() => {
    useDiskStore.getState().track(path);
    return () => useDiskStore.getState().forget(path);
  }, [path]);

  // A new path or a new disk version gets a fresh chance to decode.
  useEffect(() => {
    setFailed(false);
    setOpenError(false);
  }, [path, version]);

  // An SVG's size comes from its source (width/height, else viewBox): the webview's own idea of it
  // is 0 or a default for a viewBox-only file.
  useEffect(() => {
    if (!vector) return;
    let live = true;
    setSvg({ size: null, done: false });
    readFile(path)
      .then((file) => live && setSvg({ size: svgIntrinsicSize(file.content), done: true }))
      .catch((error: unknown) => {
        logger.warn("images", `could not read an SVG for its size: ${String(error)}`);
        if (live) setSvg({ size: null, done: true });
      });
    return () => {
      live = false;
    };
  }, [path, version, vector]);

  const content = vector ? (svg.size ?? natural) : natural;
  const ready = content !== null && page.width > 0 && (!vector || svg.done);

  // A different image (or size) starts at Fit; a reload with the same size keeps the view.
  const sizeKey = `${path}:${content?.width}x${content?.height}`;
  useEffect(() => {
    setView(null);
  }, [sizeKey]);

  const latest = useRef({ view, content, page });
  latest.current = { view, content, page };
  const commit = (next: View) => {
    latest.current.view = next;
    setView(next);
  };

  const actions = useMemo(() => {
    const step = (factor: number) => {
      const { view: v, content: c, page: p } = latest.current;
      if (c) commit(zoomBy(v, factor, pageCenter(p), c, p));
    };
    return {
      zoomIn: () => step(ZOOM_STEP),
      zoomOut: () => step(1 / ZOOM_STEP),
      fit: () => commit(null),
    };
  }, []);

  useEffect(() => (isActive ? registerViewer(actions) : undefined), [isActive, actions]);

  // Wheel and pinch (`hooks/use-zoom-gestures.ts`): zoom toward the pointer, pan with the wheel.
  const pinch = useRef<{ view: View; scale: number } | null>(null);
  useZoomGestures(stageRef, {
    zoomBy: (factor, anchor) => {
      const { view: v, content: c, page: p } = latest.current;
      if (c) commit(zoomBy(v, factor, anchor, c, p));
    },
    pinchStart: () => {
      const { view: v, content: c, page: p } = latest.current;
      pinch.current = c ? { view: v, scale: resolveView(v, c, p).scale } : null;
    },
    pinchTo: (scale, anchor) => {
      const { content: c, page: p } = latest.current;
      const start = pinch.current;
      if (start && c) commit(zoomTo(start.view, start.scale * scale, anchor, c, p));
    },
    scroll: (event) => {
      const { view: v, content: c, page: p } = latest.current;
      if (c) commit(panBy(v, -event.deltaX, -event.deltaY, c, p));
    },
  });

  const drag = useRef<Point | null>(null);
  const transform = content && ready ? resolveView(view, content, page) : null;
  const pannable = !!(transform && content && canPan(transform, content, page));

  const src = withVersion(convertFileSrc(path), version);
  const name = getFileName(path);

  return (
    <div
      data-pane
      data-testid="image-viewer"
      className={
        isActive
          ? "relative z-10 flex h-full flex-col"
          : "absolute inset-0 invisible pointer-events-none"
      }
    >
      <div
        ref={stageRef}
        data-testid="image-viewer-stage"
        className="relative min-h-0 flex-1 overflow-clip touch-none"
        style={{ cursor: pannable ? (dragging ? "grabbing" : "grab") : undefined }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !pannable) return;
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const last = drag.current;
          const { view: v, content: c, page: p } = latest.current;
          if (!last || !c) return;
          drag.current = { x: event.clientX, y: event.clientY };
          commit(panBy(v, event.clientX - last.x, event.clientY - last.y, c, p));
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={(event) => {
          const { view: v, content: c, page: p } = latest.current;
          if (!c) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          commit(toggleActualSize(v, anchor, c, p));
        }}
      >
        {deleted ? (
          <Message testId="image-viewer-deleted">This file was deleted</Message>
        ) : failed ? (
          <Message testId="image-viewer-fallback">
            <div>Can't display this image here</div>
            <button
              type="button"
              className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
              onClick={() => {
                setOpenError(false);
                openAttachmentInDefaultApp(path).catch((error: unknown) => {
                  logger.warn("images", `open in default app failed: ${String(error)}`);
                  setOpenError(true);
                });
              }}
            >
              Open in default app
            </button>
            {openError ? <div>Couldn't open it</div> : null}
          </Message>
        ) : (
          <img
            key={src}
            src={src}
            alt={name}
            draggable={false}
            className="absolute left-0 top-0 max-w-none select-none"
            style={
              transform && content
                ? {
                    width: content.width * transform.scale,
                    height: content.height * transform.scale,
                    transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px)`,
                  }
                : { visibility: "hidden" }
            }
            onLoad={(event) => {
              const img = event.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <Footer
        name={name}
        size={content}
        scale={transform?.scale ?? null}
        fitted={view === null}
        onZoomIn={actions.zoomIn}
        onZoomOut={actions.zoomOut}
        onFit={actions.fit}
      />
    </div>
  );
}

function Message({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"
    >
      {children}
    </div>
  );
}

/** File name, pixel size and the zoom control. */
function Footer({
  name,
  size,
  scale,
  fitted,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  name: string;
  size: Size | null;
  scale: number | null;
  /** At Fit the control reads "Fit", not the fitted percent. */
  fitted: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div
      data-testid="image-viewer-footer"
      className="flex h-11 shrink-0 items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)] md:px-8"
    >
      <span>{name}</span>
      {size && size.width > 0 ? (
        <span>
          {Math.round(size.width)} × {Math.round(size.height)} px
        </span>
      ) : null}
      {scale !== null ? (
        <ZoomControl
          scale={scale}
          fitted={fitted}
          testId="image-zoom"
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onFit={onFit}
        />
      ) : null}
    </div>
  );
}
