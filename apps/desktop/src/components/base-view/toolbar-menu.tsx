import { useEffect, useId, useRef, useState } from "react";

interface Props {
  label: string;
  /** Short extra text on the button (a count). */
  badge?: string | number | null;
  title?: string;
  /** Alignment of the panel under its button. */
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}

const BUTTON =
  "flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary";

/** A toolbar button with a popover panel (outside click and Escape close it). */
export function ToolbarMenu({ label, badge, title, align = "right", children }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0" data-toolbar-menu={label}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={title ?? label}
        onClick={() => setOpen((o) => !o)}
        className={BUTTON}
      >
        <span>{label}</span>
        {badge ? <span className="text-[10px] text-text-secondary">{badge}</span> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-50 mt-1 max-h-[70vh] w-80 overflow-auto rounded-lg border border-border bg-surface-primary p-3 text-[13px] text-text-primary shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export const FIELD =
  "min-w-0 rounded-md border border-border bg-surface-primary px-1.5 py-1 text-[12px] text-text-primary";
export const SMALL_BUTTON =
  "cursor-pointer rounded-md border border-border bg-transparent px-2 py-0.5 text-[12px] text-text-primary hover:bg-[var(--item-hover-bg)] disabled:cursor-default disabled:opacity-40";
