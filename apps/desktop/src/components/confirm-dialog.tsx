import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const BUTTON =
  "h-8 rounded-lg px-3 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-50";
const CONFIRM = "h-8 rounded-lg px-3 text-[13px] font-medium text-white disabled:opacity-50";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * The generic confirmation modal: a title, a body, Cancel and one confirm button. The confirm
 * runs `onConfirm` (async): the button shows a spinner while it is pending, the dialog closes
 * (`onClose`) when it resolves, and stays open with the error message inside it when it rejects.
 * Focus starts on the confirm button (so Enter confirms), Tab stays inside the card, Escape and a
 * click on the backdrop cancel (both ignored while pending), and focus returns to where it was.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const headingId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  async function confirm() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onCloseRef.current();
    } catch (e) {
      if (!mounted.current) return;
      setError(describe(e));
      pendingRef.current = false;
      setPending(false);
    }
  }
  const confirmRun = useRef(confirm);
  confirmRun.current = confirm;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        event.stopPropagation();
        void confirmRun.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!card.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, []);

  // Focus returns to the confirm button once a failed attempt is over (a disabled button blurs).
  useEffect(() => {
    if (!pending) confirmRef.current?.focus();
  }, [pending]);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pendingRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="relative w-full max-w-[420px] rounded-xl border border-[var(--border-color)] bg-[var(--surface-card)] px-5 pb-4 pt-5 outline-none"
      >
        <h2 id={headingId} className="text-[15px] font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        <div className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {children}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-[12px] text-[var(--agent-error)]">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className={BUTTON} disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`${CONFIRM} ${destructive ? "bg-[var(--agent-error)]" : "bg-[var(--accent)]"}`}
            disabled={pending}
            aria-busy={pending}
            onClick={() => void confirm()}
          >
            {pending ? (
              <span
                aria-hidden="true"
                className="mr-1.5 inline-block size-3 animate-spin rounded-full border-2 border-white/40 border-t-white align-[-2px]"
              />
            ) : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
