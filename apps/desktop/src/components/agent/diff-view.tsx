import { useState } from "react";
import type { DiffRow } from "@/lib/agent/events";
import { collapseContext, PAGE_ROWS } from "@/lib/agent/diff-rows";

const ROW_TONE: Record<DiffRow["kind"], string> = {
  context: "text-text-secondary",
  add: "bg-[var(--success-soft)] text-text-primary",
  del: "bg-[var(--danger-soft)] text-text-primary",
};
const SIGN: Record<DiffRow["kind"], string> = { context: " ", add: "+", del: "-" };
const SIGN_LABEL: Record<DiffRow["kind"], string> = {
  context: "unchanged",
  add: "added",
  del: "removed",
};

function Row({ row }: { row: DiffRow }) {
  return (
    <div
      data-diff-row={row.kind}
      className={`flex font-[var(--mono-font)] text-[12px] leading-snug ${ROW_TONE[row.kind]}`}
    >
      <span aria-hidden="true" className="w-8 shrink-0 pr-1 text-right text-text-muted select-none">
        {row.oldLine ?? ""}
      </span>
      <span aria-hidden="true" className="w-8 shrink-0 pr-1 text-right text-text-muted select-none">
        {row.newLine ?? ""}
      </span>
      <span
        className={`w-3 shrink-0 text-center select-none ${
          row.kind === "add"
            ? "text-[var(--success)]"
            : row.kind === "del"
              ? "text-[var(--danger)]"
              : ""
        }`}
      >
        <span aria-hidden="true">{SIGN[row.kind]}</span>
        <span className="sr-only">{SIGN_LABEL[row.kind]}: </span>
      </span>
      <span className="min-w-0 flex-1 pl-1 break-words whitespace-pre-wrap">{row.text || " "}</span>
    </div>
  );
}

/** A unified diff: line numbers, added/removed rows, unchanged runs folded behind "Show N lines",
 *  and at most `PAGE_ROWS` rows at a time behind "Show more" (a long diff never floods the DOM). */
export function DiffView({
  rows,
  truncated,
  label,
}: {
  rows: DiffRow[];
  truncated?: boolean;
  label: string;
}) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [limit, setLimit] = useState(PAGE_ROWS);
  const segments = collapseContext(rows);
  if (rows.length === 0)
    return <p className="px-2 py-1 text-[11.5px] text-text-muted">No line changes</p>;

  // flatten what is visible, folded runs counting as one row, then cap
  let budget = limit;
  let more = 0;
  const out: React.ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (seg.kind === "gap" && !opened.has(i)) {
      if (budget <= 0) return void (more += 1);
      budget -= 1;
      out.push(
        <button
          key={`gap-${i}`}
          type="button"
          onClick={() => setOpened(new Set(opened).add(i))}
          className="block w-full bg-[var(--surface-subtle)] px-2 py-0.5 text-left text-[11px] text-text-muted hover:text-text-primary"
        >
          Show {seg.rows.length} lines
        </button>,
      );
      return;
    }
    seg.rows.forEach((row, j) => {
      if (budget <= 0) return void (more += 1);
      budget -= 1;
      out.push(<Row key={`${i}-${j}`} row={row} />);
    });
  });
  return (
    <div
      role="group"
      aria-label={label}
      data-agent-diff
      tabIndex={0}
      className="max-h-[28rem] overflow-auto rounded-md border border-border bg-[var(--surface-subtle)]/40 py-1"
    >
      {out}
      {more > 0 && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE_ROWS)}
          className="block w-full px-2 py-1 text-left text-[11px] text-text-muted underline hover:text-text-primary"
        >
          Show more
        </button>
      )}
      {truncated && more === 0 && (
        <p className="px-2 py-1 text-[11px] text-text-muted">
          Diff cut: the file is too large to show in full
        </p>
      )}
    </div>
  );
}
