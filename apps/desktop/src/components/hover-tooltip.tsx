import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { getPopupLayer } from "@/lib/popup-layer";
import { computePopupPosition } from "@/lib/popup-position";

/** Pointer rest before a tooltip shows. */
export const TOOLTIP_DELAY_MS = 500;
/** After one closes, the next opens at once for this long (moving along a row of tabs). */
export const TOOLTIP_WARM_MS = 300;

export interface TooltipContent {
  title: string;
  /** Muted second line (a folder, a project). */
  detail?: string;
  /** Extra line in the warning colour (a save error). */
  alert?: string;
}

// One tooltip is open at a time, so the "warm" state is shared by every user of the hook.
let warmUntil = 0;

interface Options {
  /** The element whose text can be ellipsed; measured when the tooltip is about to show. */
  labelRef: RefObject<HTMLElement | null>;
  content: TooltipContent;
  /** Show even when the label is not truncated (a narrow pinned tab, a save error). */
  always?: boolean;
}

/**
 * A tooltip for an ellipsed label: spread `triggerProps` on the hovered element and render
 * `tooltip` next to it. Truncation is measured at hover time, never on render. The tooltip is
 * portalled to the popup layer, so a strip's `overflow: clip` never cuts it. State is local to
 * the hovered element: no other tab re-renders.
 */
export function useHoverTooltip({ labelRef, content, always = false }: Options) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const latest = useRef({ always });
  latest.current = { always };

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen((was) => {
      if (was) warmUntil = Date.now() + TOOLTIP_WARM_MS;
      return false;
    });
  }, []);

  const schedule = useCallback(
    (immediate: boolean) => {
      clearTimeout(timer.current);
      const show = () => {
        const label = labelRef.current;
        const truncated = !!label && label.scrollWidth > label.clientWidth;
        if (truncated || latest.current.always) setOpen(true);
      };
      if (immediate || Date.now() < warmUntil) show();
      else timer.current = setTimeout(show, TOOLTIP_DELAY_MS);
    },
    [labelRef],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    // Scroll events do not bubble: capture catches the tab strip's own scroller.
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, hide]);

  const triggerProps = {
    ref: anchorRef as RefObject<never>,
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === "touch") return;
      schedule(false);
    },
    onPointerLeave: hide,
    // A press (and so a drag, which starts on pointerdown) ends the tooltip.
    onPointerDown: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      let visible = false;
      try {
        visible = e.currentTarget.matches(":focus-visible");
      } catch {
        // Engines without :focus-visible keep the pointer path only.
      }
      if (visible) schedule(true);
    },
    onBlur: hide,
    "aria-describedby": open ? id : undefined,
  };

  const tooltip = open ? <TooltipBubble id={id} anchorRef={anchorRef} content={content} /> : null;
  return { triggerProps, tooltip };
}

function TooltipBubble({
  id,
  anchorRef,
  content,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  content: TooltipContent;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const size = el.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const pos = computePopupPosition({
      anchorRect: a,
      popupSize: { width: size.width, height: size.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 6,
    });
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.style.visibility = "visible";
  }, [anchorRef, content]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-hover-tooltip
      style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
      className="hover-tooltip pointer-events-none max-w-[360px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-base)] px-2.5 py-1.5 text-[12px] leading-[1.35] text-[var(--text-primary)] shadow-md [overflow-wrap:anywhere]"
    >
      <TooltipLines content={content} />
    </div>,
    getPopupLayer(),
  );
}

function TooltipLines({ content }: { content: TooltipContent }): ReactNode {
  return (
    <>
      <div className="font-medium">{content.title}</div>
      {content.detail ? (
        <div className="whitespace-pre-line text-[var(--text-muted)]">{content.detail}</div>
      ) : null}
      {content.alert ? <div className="text-[var(--text-error)]">{content.alert}</div> : null}
    </>
  );
}
