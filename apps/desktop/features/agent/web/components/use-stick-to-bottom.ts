import { useEffect, useRef } from "react";

/** Within this many px of the bottom counts as "at the bottom" (sub-pixel rounding, not intent). */
const BOTTOM_SLACK = 4;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** Scrollers this hook owns: a wheel inside a nested one is not the outer one's user intent. */
const followers = new WeakSet<Element>();

/** The one follower of a growing transcript (spec 3.5). It keeps a scroller pinned to its bottom
 *  until the user scrolls up, and pins again whenever the content changes size, so growth that
 *  lands after React committed (a markdown pass, an image, a font) is followed in the same frame,
 *  before paint. `stuck` changes only on user intent (wheel up, keys, touch or scrollbar drag
 *  that leaves the bottom) and back when the user reaches the bottom, never because our own
 *  scroll or a layout shift moved `scrollTop`. Browser scroll anchoring is off while stuck, since
 *  it would fight the pin. Attach `scrollRef` to the scroller and `contentRef` to the one element
 *  inside it that holds everything that grows. */
export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    followers.add(el);
    let stuck = true;
    let pointerHeld = false;
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    const setStuck = (value: boolean) => {
      stuck = value;
      el.style.overflowAnchor = value ? "none" : "";
    };
    const pin = () => {
      if (stuck) el.scrollTop = el.scrollHeight;
    };
    const ownsEvent = (target: EventTarget | null) => {
      for (let n = target as Element | null; n && n !== el; n = n.parentElement) {
        if (followers.has(n)) return false;
      }
      return true;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollTop > 0 && ownsEvent(e.target)) setStuck(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (UP_KEYS.has(e.key) && ownsEvent(e.target)) setStuck(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      // a press on the scroller itself (not its content) is the scrollbar
      if (e.target === el) pointerHeld = true;
    };
    const onPointerUp = () => {
      pointerHeld = false;
    };
    const onScroll = () => {
      if (atBottom()) setStuck(true);
      else if (pointerHeld || touching) setStuck(false);
    };
    let touching = false;
    const onTouchStart = () => {
      touching = true;
    };
    const onTouchEnd = () => {
      touching = false;
    };

    setStuck(true);
    pin();
    // absent only where there is no layout (jsdom); the pin then runs on mount alone
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pin);
    observer?.observe(el);
    if (contentRef.current) observer?.observe(contentRef.current);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      followers.delete(el);
      observer?.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  return { scrollRef, contentRef };
}
