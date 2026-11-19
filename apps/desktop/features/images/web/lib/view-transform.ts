// The image viewer's view model, pure (no DOM, no React): where the image sits in the page and how
// big it is drawn. Spec: docs/decisions/2026-11-18-make-images-a-built-in-feature-with-a-rebuilt-
// zoomable-viewer.md. Everything is in page pixels.
//
// A view is either `null` (Fit: the image fills the page, scaled up as well as down, and follows a
// resize) or a `Transform` (a scale and the position of the image's top-left corner). Every
// operation returns a view that already respects the bounds, so the component never clamps.

import type { Point, Size } from "@/lib/viewer-zoom";

export interface Transform {
  /** Drawn size over intrinsic size (1 is 100%). */
  scale: number;
  /** The image's top-left corner in the page. */
  x: number;
  y: number;
}

/** Fit, or a free transform. */
export type View = Transform | null;

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 32;
/** The space left around the image in Fit. */
export const FIT_MARGIN = 16;
/** A zoom that lands this close to Fit becomes Fit (so a resize keeps following the page). */
const FIT_SNAP = 0.005;

/** The scale at which the image fills the page inside the margin, up as well as down. */
export function fitScale(content: Size, page: Size, margin = FIT_MARGIN): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const w = Math.max(1, page.width - 2 * margin);
  const h = Math.max(1, page.height - 2 * margin);
  return Math.min(w / content.width, h / content.height);
}

/** Keep a scale in 5%..3200%; an image so large that Fit is below 5% may go down to Fit. */
export function clampScale(scale: number, fit: number): number {
  if (!Number.isFinite(scale)) return fit;
  return Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, fit), scale));
}

function bound(offset: number, drawn: number, page: number): number {
  if (drawn <= page) return (page - drawn) / 2; // smaller than the page: centred
  return Math.min(0, Math.max(page - drawn, offset)); // larger: the edge cannot leave the page
}

/** `t` moved so the image stays centred or covers the page, never drifting away from it. */
export function constrain(t: Transform, content: Size, page: Size): Transform {
  return {
    scale: t.scale,
    x: bound(t.x, content.width * t.scale, page.width),
    y: bound(t.y, content.height * t.scale, page.height),
  };
}

function centered(content: Size, page: Size, scale: number): Transform {
  return constrain({ scale, x: 0, y: 0 }, content, page);
}

/** The transform a view stands for in this page. */
export function resolveView(view: View, content: Size, page: Size): Transform {
  if (!view) return centered(content, page, fitScale(content, page));
  return constrain(view, content, page);
}

/** Does the drawn image overflow the page on some axis (so dragging pans)? */
export function canPan(t: Transform, content: Size, page: Size): boolean {
  return content.width * t.scale > page.width || content.height * t.scale > page.height;
}

function viewAt(t: Transform, fit: number): View {
  return Math.abs(t.scale / fit - 1) < FIT_SNAP ? null : t;
}

/** Zoom to `scale` keeping the image point under `anchor` where it is. */
export function zoomTo(view: View, scale: number, anchor: Point, content: Size, page: Size): View {
  const current = resolveView(view, content, page);
  const fit = fitScale(content, page);
  const next = clampScale(scale, fit);
  const k = next / current.scale;
  return viewAt(
    constrain(
      {
        scale: next,
        x: anchor.x - (anchor.x - current.x) * k,
        y: anchor.y - (anchor.y - current.y) * k,
      },
      content,
      page,
    ),
    fit,
  );
}

/** Zoom by a factor about `anchor`. */
export function zoomBy(view: View, factor: number, anchor: Point, content: Size, page: Size): View {
  const current = resolveView(view, content, page);
  return zoomTo(view, current.scale * factor, anchor, content, page);
}

/** Move the image by (`dx`, `dy`) page pixels, within bounds. Fit stays Fit when nothing overflows. */
export function panBy(view: View, dx: number, dy: number, content: Size, page: Size): View {
  const current = resolveView(view, content, page);
  if (!canPan(current, content, page)) return view;
  return constrain({ ...current, x: current.x + dx, y: current.y + dy }, content, page);
}

/** Fit to 100% about `anchor`, or back to Fit when already at 100%. */
export function toggleActualSize(view: View, anchor: Point, content: Size, page: Size): View {
  const current = resolveView(view, content, page);
  if (Math.abs(current.scale - 1) < 0.001) return null;
  return zoomTo(view, 1, anchor, content, page);
}

export const pageCenter = (page: Size): Point => ({ x: page.width / 2, y: page.height / 2 });
