import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const MARGIN = 8;

interface PlacementOptions {
  /** Preferred width (px); shrinks to fit the container. */
  width: number;
  /** Upper bound for the height (px); shrinks to the room available on the open side. */
  maxHeight?: number;
  /** Which side of the anchor the popover opens on (`top` = above it). */
  side?: "top" | "bottom";
  /** The element whose bounds the popover must stay inside; default: the nearest agent pane,
   *  else the window. */
  boundary?: string;
}

/** Pure placement maths, so it is testable without a DOM: given the anchor and boundary rects and
 *  the window height, the left offset (relative to the anchor), the width and the max height that
 *  keep the popover inside the boundary and the window. */
export function computePlacement(
  anchor: { left: number; top: number; bottom: number },
  boundary: { left: number; right: number },
  viewportHeight: number,
  { width, maxHeight = 320, side = "top" }: PlacementOptions,
): { left: number; width: number; maxHeight: number } {
  const room = Math.max(0, boundary.right - boundary.left - 2 * MARGIN);
  const w = Math.min(width, room);
  const rightEdge = boundary.right - MARGIN;
  const leftEdge = boundary.left + MARGIN;
  // Start aligned with the anchor, then slide left to stay inside, then right to not cross the edge.
  let left = anchor.left;
  if (left + w > rightEdge) left = rightEdge - w;
  if (left < leftEdge) left = leftEdge;
  const available =
    side === "top" ? anchor.top - 2 * MARGIN : viewportHeight - anchor.bottom - 2 * MARGIN;
  return {
    left: left - anchor.left,
    width: w,
    maxHeight: Math.max(120, Math.min(maxHeight, available)),
  };
}

/** Inline style for an absolutely positioned popover that must not be cut off by the window or
 *  the pane: measured when it opens and whenever the window resizes. */
export function usePopoverPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: PlacementOptions,
): CSSProperties {
  const { width, maxHeight, side, boundary = "[data-agent-pane]" } = options;
  const [style, setStyle] = useState<CSSProperties>({ width });

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const b = (anchor.closest(boundary) ?? document.documentElement).getBoundingClientRect();
      const bounds =
        b.width > 0 ? { left: b.left, right: b.right } : { left: 0, right: window.innerWidth };
      const p = computePlacement(a, bounds, window.innerHeight, { width, maxHeight, side });
      setStyle({ left: p.left, width: p.width, maxHeight: p.maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorRef, open, width, maxHeight, side, boundary]);

  return style;
}
