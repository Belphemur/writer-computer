import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The common look of a modal card. A modal with its own surface passes its own `className`. */
export const MODAL_PANEL =
  "rounded-xl border border-[var(--border-color)] bg-[var(--surface-card)]";

interface ModalBehavior {
  /** Escape. Always swallowed (the app's shortcuts never see it); this decides what it does. */
  onEscape: () => void;
  /** Skip Escape for this event, e.g. a nested popup that closes itself first. */
  ignoreEscape?: (event: KeyboardEvent) => boolean;
  /** Focus on open: this element, else the card; `false` leaves focus alone. */
  initialFocus?: RefObject<HTMLElement | null> | false;
  /** Runs for every other key but Tab, after Escape, in the same capture listener. */
  onKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * The one modal keyboard model: initial focus, Escape, a Tab trap inside the card, and focus
 * returned to where it was on unmount. One capture listener on `document`, so it runs before the
 * window-level shortcut handler (the backdrop only blocks the pointer). Options are read through a
 * ref, so a new callback identity never re-runs the effect (which would re-focus and re-restore).
 */
function useModalFocus(cardRef: RefObject<HTMLElement | null>, behavior: ModalBehavior) {
  const latest = useRef(behavior);
  latest.current = behavior;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { initialFocus } = latest.current;
    if (initialFocus !== false) (initialFocus?.current ?? cardRef.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const { onEscape, ignoreEscape, onKeyDown: custom } = latest.current;
      if (event.key === "Escape") {
        if (ignoreEscape?.(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key !== "Tab") {
        custom?.(event);
        return;
      }
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && card.contains(active);
      if (!inside || (event.shiftKey && (active === first || active === card))) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [cardRef]);
}

/**
 * The one modal: a dimmed backdrop plus a card with `role="dialog"` and `aria-modal`, driven by
 * `useModalFocus`. Mount it while the modal is open. Escape calls `onClose`; a press on the
 * backdrop does too unless `dismissOnBackdrop` is false. A modal that must not close (a pending
 * request) gates inside its `onClose`. Every modal in the app renders through this
 * (`tests/modal-inventory.test.ts`).
 */
export function ModalShell({
  onClose,
  dismissOnBackdrop = true,
  ignoreEscape,
  initialFocus,
  onKeyDown,
  role = "dialog",
  labelledBy,
  describedBy,
  className,
  children,
}: {
  onClose: () => void;
  dismissOnBackdrop?: boolean;
  ignoreEscape?: ModalBehavior["ignoreEscape"];
  initialFocus?: ModalBehavior["initialFocus"];
  onKeyDown?: ModalBehavior["onKeyDown"];
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  /** The card's own classes (size, surface); `relative` and `outline-none` are added. */
  className: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useModalFocus(cardRef, { onEscape: onClose, ignoreEscape, initialFocus, onKeyDown });
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`relative outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
