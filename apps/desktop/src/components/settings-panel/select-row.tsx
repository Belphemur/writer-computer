import type { ReactNode } from "react";

// The row shell and the control classes of a titled settings row with its control on the right: the
// Agent page, its model catalog and tier models, and the backend panels features contribute to it
// share them, so one look is written once.

export const ROW = "flex items-center justify-between gap-4 px-4 py-3.5";
export const SELECT =
  "h-9 min-w-[160px] appearance-none rounded-lg border border-transparent bg-[var(--surface-input)] bg-[image:var(--select-chevron)] bg-[length:12px_12px] bg-[position:right_10px_center] bg-no-repeat pl-3 pr-8 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)] focus-visible:outline-none disabled:opacity-50";
export const INPUT =
  "h-9 w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)] focus-visible:outline-none";

/** A titled row of the Agent card with its control on the right. */
export function SelectRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{description}</div>
      </div>
      {children}
    </div>
  );
}
