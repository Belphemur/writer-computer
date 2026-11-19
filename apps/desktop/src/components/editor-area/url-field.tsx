import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { urlItems } from "@/lib/url-property";
import { UrlChip } from "../url-chip";
import { CHIP, ChipRemove, FIELD } from "./property-chip";
import { rowLabel, type PropertyActions } from "./property-value";
import type { PropertyRow } from "@/lib/frontmatter-properties";

function focusOnMount(el: HTMLInputElement | null) {
  el?.focus();
}

/** The raw text of a single URL, edited in place: Enter or blur saves, Escape keeps the old value. */
function EditUrl({
  row,
  actions,
  value,
  onDone,
}: {
  row: PropertyRow;
  actions: PropertyActions;
  value: string;
  onDone: () => void;
}) {
  return (
    <input
      ref={focusOnMount}
      type="text"
      aria-label={`${rowLabel(row, actions)} value`}
      defaultValue={value}
      spellCheck={false}
      onBlur={(e) => {
        const next = e.currentTarget.value;
        if (next !== value) actions.setValue(row.key, next === "" ? null : next);
        onDone();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      className={FIELD}
    />
  );
}

/**
 * The value cell of a `url` property: one link chip per address (click opens it, "x" removes it),
 * a pencil beside a single address to edit its raw text, and an input to add another (the second
 * makes a list). Whether the text is a URL never changes what is written: a value that is none
 * stays as typed and shows "Not a URL" (`UrlChip`, the row's warning). The single or list shape
 * is the edit helpers' business (`lib/url-property.ts`).
 */
export function UrlField({ row, actions }: { row: PropertyRow; actions: PropertyActions }) {
  const [editing, setEditing] = useState(false);
  const items = urlItems(row);
  const single = row.kind !== "list" && items.length === 1;
  const label = rowLabel(row, actions);
  const add = (el: HTMLInputElement) => {
    const raw = el.value.trim();
    if (raw !== "" && actions.addUrl(row, raw)) el.value = "";
  };
  return (
    <span
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
      // the empty part of the row edits the raw text of a single address
      onClick={(e) => e.target === e.currentTarget && single && setEditing(true)}
    >
      {editing && single ? (
        <EditUrl row={row} actions={actions} value={items[0]!} onDone={() => setEditing(false)} />
      ) : (
        <>
          {items.map((item, i) => (
            <UrlChip key={`${i}:${item}`} value={item} className={CHIP}>
              <ChipRemove label={item} onRemove={() => actions.removeUrl(row, i)} />
            </UrlChip>
          ))}
          {single && (
            <button
              type="button"
              aria-label={`Edit ${label}`}
              onClick={() => setEditing(true)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-icon-muted)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
            >
              <HugeiconsIcon icon={PencilEdit01Icon} size={12} color="currentColor" />
            </button>
          )}
          <input
            type="text"
            aria-label={`Add to ${label}`}
            placeholder={items.length === 0 ? "add URL" : "+"}
            spellCheck={false}
            onBlur={(e) => add(e.currentTarget)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                add(e.currentTarget);
              } else if (e.key === "Escape") {
                e.currentTarget.value = "";
                e.currentTarget.blur();
              }
            }}
            className={`${FIELD} min-w-[3.5rem] flex-none`}
          />
        </>
      )}
    </span>
  );
}
