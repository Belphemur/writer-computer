import { useEffect, useRef, useState } from "react";
import type { ReaderApi, ReaderFindState } from "./pdf-reader";

/** The query is sent to the reader this long after the last keystroke. */
export const FIND_DEBOUNCE_MS = 120;

const button =
  "flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40";

/** What the count reads: nothing before a query, `…` while pages are still read, `3 / 12`. */
export function countLabel(find: ReaderFindState, hasQuery: boolean): string {
  if (!hasQuery) return "";
  if (find.count === 0) return find.searching ? "…" : "No results";
  return `${find.current} / ${find.count}`;
}

/**
 * The find bar over the viewer (Cmd/Ctrl+F in a PDF tab): the match count `3 / 12`, Enter and
 * Shift+Enter for next and previous, Escape closes. The text is searched in the reader
 * (`../lib/use-find.ts`), which also marks the matches in its text layers. `focusToken` changes
 * whenever the bar is asked for again (a second Cmd+F selects the query).
 */
export function FindBar({
  api,
  find,
  focusToken,
  onClose,
}: {
  api: { current: ReaderApi | null };
  find: ReaderFindState;
  focusToken: number;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  useEffect(() => {
    const timer = setTimeout(() => api.current?.find.setQuery(value), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, api]);

  const hasQuery = value.trim() !== "";
  return (
    <div
      data-testid="pdf-find-bar"
      role="search"
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-[var(--line-subtle)] bg-[var(--bg-base)] px-2 py-1 text-[13px] shadow-sm"
    >
      <input
        ref={input}
        data-testid="pdf-find-input"
        aria-label="Find in PDF"
        placeholder="Find"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) api.current?.find.prev();
            else api.current?.find.next();
          }
        }}
        className="w-44 bg-transparent px-1 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
      />
      <span
        data-testid="pdf-find-count"
        className="min-w-14 text-center text-[var(--text-muted)] tabular-nums"
      >
        {countLabel(find, hasQuery)}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        className={button}
        disabled={find.count === 0}
        onClick={() => api.current?.find.prev()}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        className={button}
        disabled={find.count === 0}
        onClick={() => api.current?.find.next()}
      >
        ↓
      </button>
      <button type="button" aria-label="Close find" className={button} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
