/**
 * Zoom of the image viewer (page kind `image`). 1 is "fit to width": the image at the width of
 * the pane, never enlarged beyond its own size. Cmd+= / Cmd+- step by a quarter, a trackpad pinch
 * scales continuously; both clamp to the same range.
 */
export const IMAGE_ZOOM_MIN = 0.1;
export const IMAGE_ZOOM_MAX = 8;
export const IMAGE_ZOOM_FIT = 1;
const STEP = 1.25;

export function clampImageZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return IMAGE_ZOOM_FIT;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, Math.round(zoom * 1000) / 1000));
}

export const zoomImageIn = (zoom: number) => clampImageZoom(zoom * STEP);
export const zoomImageOut = (zoom: number) => clampImageZoom(zoom / STEP);

/** A pinch (`scale` is relative to the start of the gesture, `1` unchanged). */
export const pinchImageZoom = (zoom: number, scale: number) => clampImageZoom(zoom * scale);

/** A ctrl+wheel (what a pinch sends in Chromium-like webviews): `deltaY` < 0 zooms in. */
export const wheelImageZoom = (zoom: number, deltaY: number) =>
  clampImageZoom(zoom * Math.exp(-deltaY * 0.01));
