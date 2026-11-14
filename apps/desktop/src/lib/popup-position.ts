// Pure placement math for anything that floats over the app (plugin menus, suggestion lists,
// the plugin popup guard). No DOM access: callers measure, this decides.

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = "below" | "above" | "overlay";

export interface PopupPositionInput {
  /** What the popup hangs off, in viewport coordinates. A point is a zero-size rect. */
  anchorRect: Rect;
  /** The popup's natural (unconstrained) size. */
  popupSize: Size;
  viewport: Size;
  preferred?: "below" | "above";
  /** Distance between anchor and popup. */
  gap?: number;
  /** Minimum distance kept from every viewport edge. */
  padding?: number;
  /** Side the popup currently sits on: kept while it still fits, so a list that grows or shrinks
   *  while typing does not jump between sides. */
  previous?: "below" | "above";
}

export interface PopupPosition {
  top: number;
  left: number;
  placement: Placement;
  /** Height cap so a long list scrolls inside the popup instead of leaving the viewport. */
  maxHeight: number;
  /** Width cap for popups wider than the viewport. */
  maxWidth: number;
}

export const DEFAULT_GAP = 4;
export const DEFAULT_PADDING = 8;
/** Below this much room on either side the popup stops hugging the anchor and is pinned inside
 *  the viewport instead (an anchor scrolled mostly offscreen). */
const MIN_USABLE_HEIGHT = 48;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function rectOf(r: { top: number; left: number; right: number; bottom: number }): Rect {
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}

export function pointRect(x: number, y: number): Rect {
  return { top: y, left: x, right: x, bottom: y };
}

/** Whether `rect` lies inside the viewport (shrunk by `padding` on each side). */
export function fitsViewport(rect: Rect, viewport: Size, padding = 0): boolean {
  return (
    rect.top >= padding &&
    rect.left >= padding &&
    rect.bottom <= viewport.height - padding &&
    rect.right <= viewport.width - padding
  );
}

/**
 * Where to put a popup of `popupSize` next to `anchorRect` so it is fully visible.
 *
 * Vertical: the preferred side wins when the whole popup fits there; otherwise the other side when
 * it fits; otherwise the side with more room, with `maxHeight` capped to that room. When neither
 * side has usable room the popup is pinned inside the viewport (`overlay`).
 * Horizontal: aligned to the anchor's left edge, clamped inside the viewport.
 */
export function computePopupPosition(input: PopupPositionInput): PopupPosition {
  const { anchorRect, popupSize, viewport } = input;
  const gap = input.gap ?? DEFAULT_GAP;
  const padding = input.padding ?? DEFAULT_PADDING;
  const preferred = input.preferred ?? "below";

  const maxWidth = Math.max(0, viewport.width - 2 * padding);
  const maxViewportHeight = Math.max(0, viewport.height - 2 * padding);
  const width = Math.min(popupSize.width, maxWidth);
  const left = clamp(anchorRect.left, padding, viewport.width - padding - width);

  const spaceBelow = viewport.height - padding - (anchorRect.bottom + gap);
  const spaceAbove = anchorRect.top - gap - padding;
  const room = { below: spaceBelow, above: spaceAbove };
  const fits = (side: "below" | "above") => popupSize.height <= room[side];

  const other = preferred === "below" ? "above" : "below";
  const order: ("below" | "above")[] =
    input.previous && fits(input.previous) ? [input.previous] : [preferred, other];
  let side = order.find(fits);
  if (!side) side = room[preferred] >= room[other] ? preferred : other;

  if (room[side] < Math.min(MIN_USABLE_HEIGHT, popupSize.height)) {
    const height = Math.min(popupSize.height, maxViewportHeight);
    return {
      top: clamp(anchorRect.bottom + gap, padding, viewport.height - padding - height),
      left,
      placement: "overlay",
      maxHeight: height,
      maxWidth,
    };
  }

  const height = Math.min(popupSize.height, room[side]);
  return {
    top: side === "below" ? anchorRect.bottom + gap : anchorRect.top - gap - height,
    left,
    placement: side,
    maxHeight: height,
    maxWidth,
  };
}

/**
 * Smallest shift that brings `rect` inside the viewport, for popups whose anchor is unknown (a
 * plugin built them). Returns `{dx: 0, dy: 0}` when the rect already fits: a popup that is
 * positioned correctly is never touched. A rect taller/wider than the padded viewport is aligned to the
 * top/left padding edge (`capHeight`/`capWidth` tell the caller to shrink it).
 */
export function clampShift(
  rect: Rect,
  viewport: Size,
  padding = DEFAULT_PADDING,
): { dx: number; dy: number; capHeight: number | null; capWidth: number | null } {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const maxWidth = Math.max(0, viewport.width - 2 * padding);
  const maxHeight = Math.max(0, viewport.height - 2 * padding);
  const axis = (start: number, size: number, extent: number) => {
    if (start >= 0 && start + size <= extent) return 0; // already fits, do not move
    const target = clamp(start, padding, extent - padding - Math.min(size, extent - 2 * padding));
    return target - start;
  };
  const fitsX = rect.left >= 0 && rect.right <= viewport.width;
  const fitsY = rect.top >= 0 && rect.bottom <= viewport.height;
  return {
    dx: axis(rect.left, width, viewport.width),
    dy: axis(rect.top, height, viewport.height),
    // Only a popup that sticks out is shrunk: a full-window element that fits stays untouched.
    capHeight: !fitsY && height > maxHeight ? maxHeight : null,
    capWidth: !fitsX && width > maxWidth ? maxWidth : null,
  };
}
