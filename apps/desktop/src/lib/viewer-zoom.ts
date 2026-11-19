// What every zoomable viewer shares (the image viewer, the PDF reader): the geometry types, one
// step of the zoom keys and buttons, the factor of a wheel notch or a pinch, and how a scale is
// shown as a percent. Pure. The viewer-specific parts (the image's 2D view transform, the PDF's
// fit-width scale) live in their features; the gestures are `hooks/use-zoom-gestures.ts` and the
// footer control `components/zoom-control.tsx`.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One step of the zoom keys and buttons. */
export const ZOOM_STEP = 1.25;

/** The factor of a Cmd/Ctrl + wheel notch or a trackpad pinch (`deltaY` < 0 zooms in). */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-Math.min(50, Math.max(-50, deltaY)) * 0.01);
}

export const percent = (scale: number): number => Math.round(scale * 100);
