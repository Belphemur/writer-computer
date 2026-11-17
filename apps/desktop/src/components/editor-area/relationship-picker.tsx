import { useRef, useState, type KeyboardEvent } from "react";
import { useFuzzySearch } from "@/components/command-palette/use-fuzzy-search";
import { isAlreadyLinked } from "@/lib/relationships";
import { wikiCompletionDisplay } from "@/lib/wiki-links";
import type { SearchResult } from "@/types/fs";
import { AnchoredPopover } from "./anchored-popover";

interface PickerProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The links the property already holds: those notes are not offered. */
  linked: readonly string[];
  onPick: (file: SearchResult) => void;
  /** Escape or a pick: the caller returns focus to the "+". Click-outside does not. */
  onClose: (refocus: boolean) => void;
}

const FETCH = 30;

/** The "+" note picker of a relationships property: a search field over the vault's own ranked
 *  file search (`fuzzy_search`: fuzzy, typo tolerant, recents first when empty), notes already
 *  linked hidden. Type to filter, arrows move, Enter picks, Escape closes. */
export function RelationshipPicker({ anchorRef, linked, onPick, onClose }: PickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { results, error } = useFuzzySearch(query, FETCH);
  const items = results.filter((r) => !isAlreadyLinked(linked, r));
  const at = Math.min(active, Math.max(items.length - 1, 0));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" && items.length > 0) setActive((at + 1) % items.length);
    else if (e.key === "ArrowUp" && items.length > 0)
      setActive((at + items.length - 1) % items.length);
    else if (e.key === "Enter") {
      if (items[at]) onPick(items[at]);
    } else if (e.key === "Escape") onClose(true);
    else return;
    e.preventDefault();
  };

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      width={288}
      role="dialog"
      label="Add a link"
      onDismiss={() => onClose(false)}
    >
      <input
        ref={(el) => {
          input.current = el;
          el?.focus();
        }}
        type="text"
        role="combobox"
        aria-expanded
        aria-controls="relationship-picker-list"
        aria-label="Search notes"
        placeholder="Search notes"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="mb-1 w-full rounded bg-[var(--surface-subtle)] px-2 py-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
      />
      <div id="relationship-picker-list" role="listbox" aria-label="Notes">
        {items.map((file, i) => {
          const { label, detail } = wikiCompletionDisplay(file);
          return (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(file)}
              className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] ${
                i === at ? "bg-[var(--surface-subtle)]" : "hover:bg-[var(--surface-subtle)]"
              }`}
            >
              <span className="min-w-0 truncate">{label}</span>
              {detail && (
                <span className="min-w-0 truncate text-[12px] text-[var(--text-muted)]">
                  {detail}
                </span>
              )}
            </button>
          );
        })}
        {items.length === 0 && (
          <p role="status" className="px-2 py-1 text-[12px] text-[var(--text-muted)]">
            {error ?? "No notes to link"}
          </p>
        )}
      </div>
    </AnchoredPopover>
  );
}
