// Shared look of the property value cells: the inline field, the chip and its remove button.

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
