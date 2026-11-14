// Safety net for popups a plugin builds itself (position: fixed/absolute elements appended to
// <body>: Copilot's @-mention typeahead, Radix portals, tooltips). The host does not know their
// anchor, so it only guarantees the result is visible: a floating element that sticks out of the
// window is shifted back in (via the independent `translate` property, which composes with the
// plugin's own `transform`/`top`/`bottom` and never rewrites them) and capped to the window height
// with an internal scroll. An element that already fits is NEVER touched, so plugins that position
// correctly keep full control. Opt out per element with `data-writer-no-clamp`.
//
// Cost: one childList observer on <body> (direct children only), and per tracked popup one
// ResizeObserver plus a `style` attribute observer; all re-checks are batched into one frame.
import { clampShift, rectOf, type Size } from "@/lib/popup-position";
import { POPUP_LAYER_ID } from "./popup-layer";

export const NO_CLAMP_ATTR = "data-writer-no-clamp";

/** Body children that are the app's own, never plugin popups. */
const IGNORED = "script, style, link, #root, .cm-tooltip, [data-writer-popup-ignore]";
const FLOATING_ROLES = new Set(["listbox", "menu", "dialog", "tooltip", "combobox"]);

interface Tracked {
  dx: number;
  dy: number;
  capped: boolean;
  /** Inline max-height/overflow-y the plugin had before we capped it. */
  prior: { maxHeight: string; overflowY: string } | null;
}

export interface PopupGuardOptions {
  doc?: Document;
  /** Schedules the batched re-check; defaults to a 16 ms timer. */
  schedule?: (cb: () => void) => void;
}

type Win = Window & typeof globalThis;

function isCandidate(el: Element, win: Win): el is HTMLElement {
  if (!(el instanceof win.HTMLElement)) return false;
  if (el.id === POPUP_LAYER_ID || el.hasAttribute(NO_CLAMP_ATTR) || el.matches(IGNORED)) {
    return false;
  }
  const role = el.getAttribute("role");
  if (role && FLOATING_ROLES.has(role)) return true;
  const position = win.getComputedStyle(el).position;
  return position === "fixed" || position === "absolute";
}

/** Starts the guard; the returned function stops it and undoes every shift it applied. */
export function installPopupGuard(options: PopupGuardOptions = {}): () => void {
  const doc = options.doc ?? document;
  const win = doc.defaultView as Win | null;
  if (!win || !doc.body) return () => {};
  // A timer, not requestAnimationFrame: WebKit pauses rAF for a window that is not frontmost, and
  // the check must still run (the popup would stay clipped).
  const schedule = options.schedule ?? ((cb: () => void) => void setTimeout(cb, 16));

  const tracked = new Map<HTMLElement, Tracked>();
  let pending = false;
  let stopped = false;

  const request = (): void => {
    if (pending || stopped) return;
    pending = true;
    schedule(() => {
      pending = false;
      if (!stopped) check();
    });
  };

  const resizes = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(request) : null;
  // Plugins re-position by rewriting `style`; our own writes are dropped via takeRecords().
  const styles = new win.MutationObserver(request);

  const uncap = (el: HTMLElement, t: Tracked): void => {
    if (t.prior) {
      el.style.maxHeight = t.prior.maxHeight;
      el.style.overflowY = t.prior.overflowY;
    }
  };
  const reset = (el: HTMLElement, t: Tracked): void => {
    el.style.removeProperty("translate");
    if (t.capped) uncap(el, t);
  };

  const forget = (el: HTMLElement): void => {
    tracked.delete(el);
    resizes?.unobserve(el);
  };

  function check(): void {
    const viewport: Size = { width: win!.innerWidth, height: win!.innerHeight };
    for (const [el, t] of tracked) {
      if (!el.isConnected) {
        forget(el);
        continue;
      }
      if (t.capped) uncap(el, t); // measure the size the plugin gave it, not our cap
      const rect = rectOf(el.getBoundingClientRect());
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      if (width === 0 && height === 0) continue; // hidden (display: none) or not laid out yet
      // The rect without our own shift: where the plugin put it.
      const natural = {
        top: rect.top - t.dy,
        bottom: rect.bottom - t.dy,
        left: rect.left - t.dx,
        right: rect.right - t.dx,
      };
      let shift = clampShift(natural, viewport);
      if (shift.capHeight !== null) {
        t.prior ??= { maxHeight: el.style.maxHeight, overflowY: el.style.overflowY };
        t.capped = true;
        el.style.maxHeight = `${Math.floor(shift.capHeight)}px`;
        el.style.overflowY = "auto";
        // Capping moves a bottom-anchored popup's top edge: measure again before shifting.
        const capped = rectOf(el.getBoundingClientRect());
        shift = clampShift(
          {
            top: capped.top - t.dy,
            bottom: capped.bottom - t.dy,
            left: capped.left - t.dx,
            right: capped.right - t.dx,
          },
          viewport,
        );
      } else {
        t.capped = false; // already uncapped above
        t.prior = null;
      }
      const dx = Math.round(shift.dx);
      const dy = Math.round(shift.dy);
      if (dx !== t.dx || dy !== t.dy) {
        if (dx === 0 && dy === 0) el.style.removeProperty("translate");
        else el.style.setProperty("translate", `${dx}px ${dy}px`);
        t.dx = dx;
        t.dy = dy;
      }
    }
    styles.takeRecords(); // drop the mutations we just made
  }

  const track = (el: Element): void => {
    if (tracked.has(el as HTMLElement) || !isCandidate(el, win)) return;
    tracked.set(el, { dx: 0, dy: 0, capped: false, prior: null });
    resizes?.observe(el);
    styles.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  };

  const bodyObserver = new win.MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof win.Element) track(node);
      });
    }
    request();
  });
  bodyObserver.observe(doc.body, { childList: true });
  // WebKit can report the old window size when `resize` fires: check again once it has settled.
  const onResize = (): void => {
    request();
    setTimeout(request, 250);
  };
  win.addEventListener("resize", onResize);
  win.addEventListener("scroll", request, true);
  // `resize` can fire before `innerHeight` settles in WebKit; the root element's size cannot.
  resizes?.observe(doc.documentElement);

  return () => {
    stopped = true;
    bodyObserver.disconnect();
    styles.disconnect();
    resizes?.disconnect();
    win.removeEventListener("resize", onResize);
    win.removeEventListener("scroll", request, true);
    for (const [el, t] of tracked) reset(el, t);
    tracked.clear();
  };
}
