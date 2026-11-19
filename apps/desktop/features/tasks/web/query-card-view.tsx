// The small card a ```tasks query block shows in place of the block (spec section 7): the block
// is not run; the card names what it is and offers "Convert to Base".
import { useState } from "react";

const PREVIEW_LINES = 3;

export function TasksQueryCard({
  source,
  onConvert,
  onEdit,
}: {
  source: string;
  onConvert: () => Promise<boolean>;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const shown = lines.slice(0, PREVIEW_LINES);
  const button =
    "shrink-0 cursor-pointer rounded-md border border-[var(--line-subtle)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-60";
  return (
    <div
      data-tasks-query-card
      role="group"
      aria-label="Tasks query"
      className="flex items-start justify-between gap-3 rounded-md border border-[var(--line-subtler)] bg-surface-primary px-3 py-2"
    >
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-[var(--text-muted)]">Tasks query</div>
        <pre className="m-0 mt-1 overflow-hidden text-ellipsis whitespace-pre-wrap text-[12px] text-[var(--text-secondary)]">
          {shown.join("\n")}
          {lines.length > shown.length ? "\n..." : ""}
        </pre>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className={button}
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setBusy(true);
            void onConvert().finally(() => setBusy(false));
          }}
        >
          Convert to Base
        </button>
        <button
          type="button"
          className={button}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
    </div>
  );
}
