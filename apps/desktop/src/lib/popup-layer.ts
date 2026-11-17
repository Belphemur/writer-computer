// The one layer every host-built plugin popup (Menu, EditorSuggest, AbstractInputSuggest) mounts in,
// plus the tracker that keeps such a popup inside the visible window.
//
// Policy: popup placement is a host responsibility. The layer is a body-level, viewport-sized,
// click-through root. It deliberately sets no transform/filter/contain, so `position: fixed`
// children are anchored to the viewport and never clipped by the side pane's `overflow: hidden`.
import {
  computePopupPosition,
  rectOf,
  type Placement,
  type PopupPositionInput,
  type Rect,
} from "@/lib/popup-position";

export const POPUP_LAYER_ID = "writer-popup-layer";
/** Above the app chrome (z-50 modals) and below nothing a plugin shows. */
export const POPUP_LAYER_Z = 10_000;

export function getPopupLayer(doc: Document = document): HTMLElement {
  const existing = doc.getElementById(POPUP_LAYER_ID);
  if (existing) return existing;
  const layer = doc.createElement("div");
  layer.id = POPUP_LAYER_ID;
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: String(POPUP_LAYER_Z),
    pointerEvents: "none",
    overflow: "visible",
  });
  doc.body.appendChild(layer);
  return layer;
}

export interface TrackedPopup {
  /** Re-measure and re-place now (also runs on resize, scroll and size changes). */
  update(): void;
  /** Swap the anchor (e.g. the caret moved) and re-place. */
  setAnchor(anchor: () => Rect): void;
  readonly placement: Placement;
  dispose(): void;
}

export interface TrackPopupOptions extends Pick<
  PopupPositionInput,
  "preferred" | "gap" | "padding"
> {
  /** Window whose size bounds the popup. Defaults to the element's own window. */
  win?: Window;
}

/**
 * Keeps `el` (position: fixed, in the popup layer) next to `anchor()` and inside the window: flips
 * above/below, clamps horizontally, caps `max-height` (the popup scrolls inside), and re-runs on
 * window resize, scroll (capture) and popup size changes. The side only changes when the current
 * one stops fitting, so a list that shrinks or grows while typing does not jump.
 */
export function trackPopup(
  el: HTMLElement,
  anchor: () => Rect,
  options: TrackPopupOptions = {},
): TrackedPopup {
  const win = options.win ?? el.ownerDocument.defaultView ?? window;
  let getAnchor = anchor;
  let placement: Placement = "below";
  let side: "below" | "above" | undefined;
  let disposed = false;

  const update = (): void => {
    if (disposed || !el.isConnected) return;
    // Measure the natural size: the previous cap must not feed back into it.
    el.style.maxHeight = "";
    el.style.maxWidth = "";
    el.style.overflowY = "auto";
    el.style.position = "fixed";
    const natural = el.getBoundingClientRect();
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    const pos = computePopupPosition({
      anchorRect: getAnchor(),
      popupSize: { width: natural.width, height: natural.height },
      viewport,
      preferred: options.preferred,
      gap: options.gap,
      padding: options.padding,
      previous: side,
    });
    placement = pos.placement;
    side = pos.placement === "overlay" ? undefined : pos.placement;
    el.style.maxHeight = `${Math.floor(pos.maxHeight)}px`;
    el.style.maxWidth = `${Math.floor(pos.maxWidth)}px`;
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.style.pointerEvents = "auto";
    el.dataset.popupPlacement = pos.placement;
  };

  // Idempotent: our own max-height write can fire the size observer once, which re-places to the
  // same spot and stops.
  const onChange = (): void => update();
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onChange);
  ro?.observe(el);
  win.addEventListener("resize", onChange);
  // Scrolling the popup's own list must not re-place it.
  const onScroll = (evt: Event): void => {
    if (!(evt.target instanceof Node && el.contains(evt.target))) onChange();
  };
  win.addEventListener("scroll", onScroll, true);
  update();

  return {
    update,
    setAnchor(next) {
      getAnchor = next;
      update();
    },
    get placement() {
      return placement;
    },
    dispose() {
      disposed = true;
      ro?.disconnect();
      win.removeEventListener("resize", onChange);
      win.removeEventListener("scroll", onScroll, true);
    },
  };
}

/** Anchor for a DOM element, measured fresh each time. */
export const anchorOfElement =
  (el: Element): (() => Rect) =>
  () =>
    rectOf(el.getBoundingClientRect());
