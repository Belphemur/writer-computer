// The PDF reader's geometry, pure (no DOM, no React, no pdf.js): where each page sits in the one
// vertical scroller at a given scale, which pages are near the viewport (the only ones that draw a
// canvas and a text layer), which page the reader is "on", and the zoom range. Everything is in CSS
// pixels. Spec: SPECs/pdf-spec.md ("Tab viewer").
import type { Size } from "@/lib/viewer-zoom";

/** Space between pages and around the stack. */
export const PAGE_GAP = 12;
/** Space left and right of the widest page in Fit width. */
export const FIT_MARGIN = 16;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
/** Pages within this many viewport heights of the viewport render (above and below). */
export const RENDER_AHEAD = 1;

export interface Layout {
  /** The scale the layout was made at. */
  scale: number;
  /** The top of each page (index 0 is page 1). */
  tops: number[];
  /** The drawn size of each page. */
  sizes: Size[];
  /** The height of the whole stack, gaps included. */
  height: number;
  /** The width of the widest page. */
  width: number;
}

/** The layout of `pages` (their size at scale 1) at `scale`. */
export function layoutPages(pages: readonly Size[], scale: number): Layout {
  const tops: number[] = [];
  const sizes: Size[] = [];
  let y = PAGE_GAP;
  let width = 0;
  for (const p of pages) {
    const size = { width: p.width * scale, height: p.height * scale };
    tops.push(y);
    sizes.push(size);
    y += size.height + PAGE_GAP;
    width = Math.max(width, size.width);
  }
  return { scale, tops, sizes, height: y, width };
}

/** The scale at which the widest page fills the viewer's width inside the margin. */
export function fitWidthScale(pages: readonly Size[], viewerWidth: number): number {
  const widest = pages.reduce((w, p) => Math.max(w, p.width), 0);
  if (widest <= 0 || viewerWidth <= 0) return 1;
  return clampZoom(Math.max(1, viewerWidth - 2 * FIT_MARGIN) / widest);
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** The 1-based page range (inclusive) that should draw for a viewport at `scrollTop`. Empty
 *  layouts give `null`. */
export function renderRange(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } | null {
  const n = layout.tops.length;
  if (n === 0) return null;
  const from = scrollTop - viewportHeight * RENDER_AHEAD;
  const to = scrollTop + viewportHeight * (1 + RENDER_AHEAD);
  let first = n;
  let last = 1;
  for (let i = 0; i < n; i++) {
    const top = layout.tops[i]!;
    const bottom = top + layout.sizes[i]!.height;
    if (bottom >= from && top <= to) {
      first = Math.min(first, i + 1);
      last = Math.max(last, i + 1);
    }
  }
  if (first > last) {
    // Scrolled past the stack (a resize): the nearest end.
    const edge = scrollTop < layout.tops[0]! ? 1 : n;
    return { first: edge, last: edge };
  }
  return { first, last };
}

/** The page the reader is on: the one under the line a third down the viewport (the last page
 *  once scrolled to the end). */
export function currentPage(layout: Layout, scrollTop: number, viewportHeight: number): number {
  const n = layout.tops.length;
  if (n === 0) return 1;
  if (scrollTop + viewportHeight >= layout.height - 1 && scrollTop > 0) return n;
  const line = scrollTop + viewportHeight / 3;
  let page = 1;
  for (let i = 0; i < n; i++) {
    if (layout.tops[i]! <= line) page = i + 1;
    else break;
  }
  return page;
}

/** The `scrollTop` that puts page `page` (1-based, clamped) at the top of the viewport. */
export function scrollTopOfPage(layout: Layout, page: number): number {
  const n = layout.tops.length;
  if (n === 0) return 0;
  const i = Math.min(n, Math.max(1, Math.round(page))) - 1;
  return Math.max(0, layout.tops[i]! - PAGE_GAP);
}

/** The page asked for by a link or the page box, clamped to the document; null when it is not a
 *  usable number. */
export function clampPage(page: number, pageCount: number): number | null {
  if (!Number.isFinite(page) || pageCount <= 0) return null;
  return Math.min(pageCount, Math.max(1, Math.round(page)));
}

/** The width of the scrolled stack: the viewer's, or the widest page and its margins when that is
 *  wider (then the stack scrolls sideways). Pages are centred in it. */
export function stackWidth(layout: Layout, viewerWidth: number): number {
  return Math.max(viewerWidth, layout.width + 2 * FIT_MARGIN);
}

/** A reading position that survives a change of layout: a page and how far down it (a fraction of
 *  its height, negative in the gap above it). */
export interface Anchor {
  page: number;
  frac: number;
}

/** The anchor of the content at `y` (a `scrollTop`, or a point of the stack). */
export function anchorAt(layout: Layout, y: number): Anchor {
  const n = layout.tops.length;
  if (n === 0) return { page: 1, frac: 0 };
  let page = 1;
  for (let i = 0; i < n; i++) {
    if (layout.tops[i]! <= y + 1) page = i + 1;
    else break;
  }
  const height = layout.sizes[page - 1]!.height;
  return { page, frac: height > 0 ? (y - layout.tops[page - 1]!) / height : 0 };
}

/** The stack position an anchor stands for in `layout`. */
export function yOfAnchor(layout: Layout, anchor: Anchor): number {
  const n = layout.tops.length;
  if (n === 0) return 0;
  const page = Math.min(n, Math.max(1, anchor.page));
  return Math.max(0, layout.tops[page - 1]! + anchor.frac * layout.sizes[page - 1]!.height);
}
