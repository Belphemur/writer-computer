import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageLocation } from "@/components/editor-area/page-kinds/image";
import {
  IMAGE_ZOOM_FIT,
  pinchImageZoom,
  wheelImageZoom,
  zoomImageIn,
  zoomImageOut,
} from "@/lib/image-zoom";
import { getFileName } from "@/lib/paths";
import { setZoomTarget, type ZoomAction } from "@/lib/zoom-target";
import { useImageViewerStore } from "@/stores/image-viewer-store";
import "./image-viewer.css";

/** WebKit's pinch events (WKWebView sends these instead of a ctrl+wheel). */
interface GestureEvent extends Event {
  scale: number;
}

/**
 * Read-only image viewer (page kind `image`): fit to width, zoom with Cmd+= / Cmd+- / Cmd+0 (via
 * `lib/zoom-target`) and pinch, transparency on a checkerboard. The size and zoom go to the
 * store for the footer.
 */
export function ImageViewer({
  location,
  isActive,
}: {
  location: ImageLocation;
  isActive: boolean;
}) {
  const path = location.path;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const view = useImageViewerStore((s) => s.views[path]);
  const setSize = useImageViewerStore((s) => s.setSize);
  const setZoom = useImageViewerStore((s) => s.setZoom);
  const zoom = view?.zoom ?? IMAGE_ZOOM_FIT;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    setFailed(false);
    return () => useImageViewerStore.getState().forget(path);
  }, [path]);

  // Cmd+= / Cmd+- / Cmd+0 zoom this image while its tab is the active one.
  useEffect(() => {
    if (!isActive) return;
    return setZoomTarget((action: ZoomAction) => {
      const current = zoomRef.current;
      setZoom(
        path,
        action === "in"
          ? zoomImageIn(current)
          : action === "out"
            ? zoomImageOut(current)
            : IMAGE_ZOOM_FIT,
      );
    });
  }, [isActive, path, setZoom]);

  // Pinch: ctrl+wheel (Chromium-style) and WebKit gesture events. Non-passive so the page itself
  // does not zoom.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(path, wheelImageZoom(zoomRef.current, event.deltaY));
    };
    let gestureStart = IMAGE_ZOOM_FIT;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStart = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      setZoom(path, pinchImageZoom(gestureStart, (event as GestureEvent).scale));
    };
    pane.addEventListener("wheel", onWheel, { passive: false });
    pane.addEventListener("gesturestart", onGestureStart);
    pane.addEventListener("gesturechange", onGestureChange);
    return () => {
      pane.removeEventListener("wheel", onWheel);
      pane.removeEventListener("gesturestart", onGestureStart);
      pane.removeEventListener("gesturechange", onGestureChange);
    };
  }, [path, setZoom]);

  if (failed) {
    return <div className="writer-image-viewer__error">Can't show this image</div>;
  }

  // At 1 the image is as wide as the pane but never larger than itself; an image with no
  // intrinsic size (some SVGs) simply fills the pane.
  const natural = view?.width ?? 0;
  const width = natural > 0 ? `calc(min(100%, ${natural}px) * ${zoom})` : `${zoom * 100}%`;

  return (
    <div ref={paneRef} className="writer-image-viewer" data-testid="image-viewer">
      <img
        className="writer-image-viewer__image"
        src={convertFileSrc(path)}
        alt={getFileName(path)}
        draggable={false}
        style={{ width }}
        onLoad={(event) => {
          const img = event.currentTarget;
          setSize(path, img.naturalWidth, img.naturalHeight);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/** Footer chrome of an image tab: file name, pixel size and zoom. */
export function ImageViewerFooter({ path }: { path: string }) {
  const view = useImageViewerStore((s) => s.views[path]);
  const size = view && view.width > 0 ? `${view.width} × ${view.height} px` : null;
  const zoom = view && view.zoom !== IMAGE_ZOOM_FIT ? `${Math.round(view.zoom * 100)}%` : null;
  return (
    <div
      data-document-footer
      data-testid="image-viewer-footer"
      className="flex absolute bottom-0 w-full z-10 h-11 shrink-0 items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)] md:px-8"
    >
      <span>{getFileName(path)}</span>
      {size ? <span>{size}</span> : null}
      {zoom ? <span>{zoom}</span> : null}
    </div>
  );
}
