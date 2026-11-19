import { useEffect, useRef, type RefObject } from "react";
import { wheelFactor, type Point } from "@/lib/viewer-zoom";

/** WebKit's pinch events (WKWebView sends these instead of a ctrl+wheel). */
interface GestureEvent extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

export interface ZoomGestureHandlers {
  /** A Cmd/Ctrl + wheel notch or a trackpad pinch that arrives as ctrl+wheel: zoom by `factor`
   *  about `anchor` (a point of the element, in its own pixels). */
  zoomBy(factor: number, anchor: Point): void;
  /** A WebKit pinch starts: remember the current scale. */
  pinchStart(): void;
  /** The pinch is at `scale` times its start, about `anchor`. */
  pinchTo(scale: number, anchor: Point): void;
  /** A wheel that is not a zoom. Given: the wheel is claimed (`preventDefault`) and handed over
   *  (the image viewer pans); absent: it scrolls natively (the PDF reader's scroller). */
  scroll?(event: WheelEvent): void;
}

/**
 * Cmd/Ctrl + wheel and pinch zoom on `ref`, one implementation for every zoomable viewer.
 * Listeners are non-passive so the webview itself never zooms the page; the handlers are read
 * through a ref, so they may change every render without re-subscribing. `enabled` false leaves
 * the wheel and the pinch to the webview (an embedded viewer that does not zoom).
 */
export function useZoomGestures(
  ref: RefObject<HTMLElement | null>,
  handlers: ZoomGestureHandlers,
  enabled = true,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const anchorOf = (clientX: number, clientY: number): Point => {
      const rect = el.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        latest.current.zoomBy(wheelFactor(event.deltaY), anchorOf(event.clientX, event.clientY));
      } else if (latest.current.scroll) {
        event.preventDefault();
        latest.current.scroll(event);
      }
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      latest.current.pinchStart();
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const g = event as GestureEvent;
      latest.current.pinchTo(g.scale, anchorOf(g.clientX, g.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [ref, enabled]);
}
