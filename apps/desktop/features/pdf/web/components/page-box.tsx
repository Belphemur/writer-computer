import { useEffect, useRef, useState } from "react";

/**
 * The page indicator `3 / 12`. A click turns it into an input holding the page; Enter goes there
 * (a number outside the document is clamped by the reader), Escape or leaving the box cancels.
 */
export function PageBox({
  page,
  pageCount,
  onGo,
}: {
  page: number;
  pageCount: number;
  onGo: (page: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        title="Go to page"
        data-testid="pdf-page-box"
        className="rounded px-1 tabular-nums hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
        onClick={() => setEditing(true)}
      >
        {page} / {pageCount}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <input
        ref={input}
        autoFocus
        data-testid="pdf-page-input"
        aria-label="Go to page"
        inputMode="numeric"
        defaultValue={String(page)}
        className="w-12 rounded bg-[var(--item-hover-bg)] px-1 text-center text-[var(--text-primary)] outline-none"
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const n = Number.parseInt(e.currentTarget.value, 10);
            if (Number.isFinite(n)) onGo(n);
            setEditing(false);
          }
        }}
      />
      <span>/ {pageCount}</span>
    </span>
  );
}
