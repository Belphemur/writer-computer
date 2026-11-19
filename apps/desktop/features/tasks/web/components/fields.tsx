// The small inputs the quick add and the edit dialog share.
import type { ReactNode } from "react";

export const FIELD =
  "w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 py-2 text-[13px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";

export const PRIORITIES = ["", "highest", "high", "medium", "low", "lowest"] as const;

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--text-muted)]">
      {label}
      {children}
    </label>
  );
}

export function PrioritySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {p === "" ? "None" : p[0]!.toUpperCase() + p.slice(1)}
        </option>
      ))}
    </select>
  );
}

export function DialogButtons({
  onCancel,
  submitLabel,
  busy,
}: {
  onCancel: () => void;
  submitLabel: string;
  busy: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] text-white disabled:opacity-60"
      >
        {submitLabel}
      </button>
    </div>
  );
}
