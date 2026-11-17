import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";

interface AnchoredPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  /** Preferred width (px); shrinks to fit the window. */
  width: number;
  onDismiss: () => void;
  role: string;
  label: string;
  children: ReactNode;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

/** A popover under its anchor, portalled to the body with fixed positioning so the panel's
 *  scroll container cannot clip it: kept inside the window (`usePopoverPlacement`) and closed on
 *  click-outside, Esc, resize or wheel (`usePopoverDismiss`). */
export function AnchoredPopover({
  anchorRef,
  width,
  onDismiss,
  role,
  label,
  children,
  onKeyDown,
}: AnchoredPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const place = usePopoverPlacement(anchorRef, true, { width, maxHeight: 280, side: "bottom" });
  const [origin, setOrigin] = useState({ left: 0, top: 0 });
  usePopoverDismiss(ref, anchorRef, onDismiss);

  useLayoutEffect(() => {
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setOrigin({ left: r.left, top: r.bottom + 4 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorRef]);

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: origin.top,
        left: origin.left + (typeof place.left === "number" ? place.left : 0),
        width: place.width,
        maxHeight: place.maxHeight,
      }}
      className="z-50 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--surface-primary)] p-1 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}
