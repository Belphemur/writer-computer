// Shared look of the property value cells: the inline field, the chip and its remove button.
import { HugeiconsIcon } from "@hugeicons/react";
import { PinIcon } from "@hugeicons/core-free-icons";

export const FIELD =
  "min-w-0 flex-1 rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70 focus-visible:bg-[var(--surface-subtle)]";
export const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] leading-[1.3] text-[var(--text-primary)]";

export function ChipRemove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRemove}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[var(--text-icon-muted)] hover:text-[var(--text-primary)]"
    >
      <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** The disclosure arrow of a collapsible block (the panel, an object property). */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path
        d="M3.5 1.5L7 5l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The hover-revealed × at the end of a property row or an object key row. */
export function RemoveRowButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRemove}
      className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded text-[var(--text-icon-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** The pin button next to a row's ×: shown on hover and focus, kept in the accent colour while
 *  the property is pinned. */
export function PinRowButton({
  name,
  pinned,
  onToggle,
}: {
  name: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${pinned ? "Unpin" : "Pin"} property ${name}`}
      title={pinned ? "Unpin" : "Pin"}
      aria-pressed={pinned}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      className={`flex h-5 w-5 shrink-0 items-center justify-center self-center rounded transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 ${
        pinned
          ? "text-[var(--accent)]"
          : "text-[var(--text-icon-muted)] opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
      }`}
    >
      <HugeiconsIcon
        icon={PinIcon}
        size={12}
        strokeWidth={2}
        color="currentColor"
        fill={pinned ? "currentColor" : "none"}
      />
    </button>
  );
}
