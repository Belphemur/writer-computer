import { useRef, useState } from "react";
import { relationshipItems } from "@/lib/relationships";
import type { PropertyRow } from "@/lib/frontmatter-properties";
import type { SearchResult } from "@/types/fs";
import { CHIP, ChipRemove } from "./property-chip";
import type { PropertyActions } from "./property-value";
import { RelationshipPicker } from "./relationship-picker";
import { WikiLinkButton } from "./property-wikilink";

/** The value cell of a relationships property: one chip per link (click opens the note, dimmed
 *  when it does not exist, "x" removes it) and a "+" that opens the note picker. The single or
 *  list shape is the edit helpers' business (`lib/relationships.ts`). */
export function RelationshipsField({
  row,
  actions,
}: {
  row: PropertyRow;
  actions: PropertyActions;
}) {
  const [picking, setPicking] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const items = relationshipItems(row);
  const pick = (file: SearchResult) => {
    setPicking(false);
    plus.current?.focus();
    void actions.addLink(row, file);
  };
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {items.map((item, i) => (
        <span key={`${i}:${item}`} className={CHIP} data-relationship>
          <WikiLinkButton value={item} />
          <ChipRemove label={item} onRemove={() => actions.removeLink(row, i)} />
        </span>
      ))}
      <button
        ref={plus}
        type="button"
        aria-label={`Add to ${row.key}`}
        aria-haspopup="dialog"
        aria-expanded={picking}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPicking((p) => !p)}
        className="flex h-5 min-w-5 items-center justify-center rounded px-1 text-[12px] leading-[1.3] text-[var(--text-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
      >
        {items.length === 0 ? "+ Add link" : "+"}
      </button>
      {picking && (
        <RelationshipPicker
          anchorRef={plus}
          linked={items}
          onPick={pick}
          onClose={(refocus) => {
            setPicking(false);
            if (refocus) plus.current?.focus();
          }}
        />
      )}
    </span>
  );
}
