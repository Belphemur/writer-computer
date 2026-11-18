// The one way to bring an element into view inside a pane or page. The DOM `scrollIntoView` walks
// every scrollable ancestor, and a box with `overflow: hidden` is still scrollable by script, so it
// can shove the window frame (page body, editor area, app shell) up under the tab strip. This sets
// the `scrollTop` of one scroller only. Rules and the guard test: `docs/design.md` (Scroll ownership).

export type ScrollBlock = "start" | "center" | "nearest";

interface ScrollIntoOptions {
  block?: ScrollBlock;
  behavior?: "auto" | "smooth";
  /** The box to scroll. Default: the nearest ancestor that scrolls by the user (`auto`/`scroll`). */
  scroller?: HTMLElement | null;
}

/** The nearest ancestor the user can scroll vertically; `hidden`/`clip` frames never qualify. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** How far the scroller must move (positive: down) to put `target` where `block` says. */
function offsetFor(target: DOMRect, box: DOMRect, block: ScrollBlock): number {
  if (block === "start") return target.top - box.top;
  if (block === "center") return (target.top + target.bottom) / 2 - (box.top + box.bottom) / 2;
  if (target.top < box.top) return target.top - box.top;
  if (target.bottom > box.bottom) return Math.min(target.bottom - box.bottom, target.top - box.top);
  return 0;
}

/**
 * Scrolls `target` into view inside one scroller, touching no other box. Returns false (and does
 * nothing) when there is no scroller. Vertical only: every caller scrolls a list or a document.
 */
export function scrollIntoScroller(
  target: HTMLElement,
  { block = "nearest", behavior = "auto", scroller }: ScrollIntoOptions = {},
): boolean {
  const box = scroller === undefined ? scrollParent(target) : scroller;
  if (!box) return false;
  const delta = offsetFor(target.getBoundingClientRect(), box.getBoundingClientRect(), block);
  if (delta === 0) return true;
  const top = box.scrollTop + delta;
  if (behavior === "smooth" && typeof box.scrollTo === "function") box.scrollTo({ top, behavior });
  else box.scrollTop = top;
  return true;
}
