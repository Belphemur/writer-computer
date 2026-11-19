import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import type { PropertyRow } from "@/lib/frontmatter-properties";
import { PROPERTY_TYPES, typeKey, type PropertyType } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { AnchoredPopover } from "./anchored-popover";
import { PropertyEnumSelect } from "./enum-select";
import { chipText, PINNED_VISIBLE } from "./pinned-properties";
import { PropertyValue, type PropertyActions } from "./property-value";

const CHIP_BUTTON =
  "inline-flex max-w-[12rem] items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] leading-[1.3] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover,var(--surface-subtle))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]";

/** Enter ends a single-value edit (a list or a picker keeps its own Enter). */
const ENTER_CLOSES = new Set(["text", "number", "empty", "link", "url"]);

interface PinnedChipProps {
  row: PropertyRow;
  type: PropertyType;
  text: string;
  actions: PropertyActions;
}

/** One pinned property in the collapsed header: its icon (the enum value's own, else the type's)
 *  and short value, the name as the tooltip. A click edits it in place with the property's own
 *  editor (`PropertyValue`, or the enum dropdown) under the chip, without expanding the panel. */
function PinnedChip({ row, type, text, actions }: PinnedChipProps) {
  const [editing, setEditing] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const valueIcon = usePropertyTypesStore((s) =>
    type === "enum" && typeof row.value === "string"
      ? s.byKey[typeKey(row.key)]?.icons?.[row.value]
      : undefined,
  );
  const isEnum = type === "enum" && (row.kind === "text" || row.kind === "empty");

  const close = () => {
    setEditing(false);
    chip.current?.focus();
  };
  // A text edit commits on blur: blur first, so a click outside never drops a typed value.
  const dismiss = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && body.current?.contains(active)) active.blur();
    close();
  };
  useEffect(() => {
    if (editing && !isEnum) body.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [editing, isEnum]);
  // Escape and Enter are stopped by the fields that handle them: watch them on the way down.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const enter = e.key === "Enter" && ENTER_CLOSES.has(row.kind) && target.tagName === "INPUT";
    if (e.key === "Escape" || enter) queueMicrotask(close);
  };

  return (
    <span className="relative inline-flex min-w-0 max-w-[12rem]">
      <button
        ref={chip}
        type="button"
        data-pinned-chip={row.key}
        title={row.key}
        aria-label={`${row.key}: ${text}`}
        aria-haspopup="dialog"
        aria-expanded={editing}
        onClick={() => setEditing(!editing)}
        className={CHIP_BUTTON}
      >
        {valueIcon ? (
          <IconGlyph value={valueIcon} size={12} />
        ) : (
          <HugeiconsIcon
            icon={PROPERTY_TYPES[type].icon}
            size={12}
            strokeWidth={2}
            color="currentColor"
            className="shrink-0 text-[var(--text-icon-muted)]"
          />
        )}
        <span className="min-w-0 truncate">{text}</span>
      </button>
      {editing && isEnum && (
        // the dropdown's own trigger, invisible over the chip, anchors its list under it
        <span className="pointer-events-none absolute inset-0 opacity-0">
          <PropertyEnumSelect
            name={row.key}
            value={row.value === null ? null : String(row.value)}
            defaultOpen
            onSelect={(v) => {
              actions.setValue(row.key, v);
              close();
            }}
            onDismiss={() => setEditing(false)}
          />
        </span>
      )}
      {editing && !isEnum && (
        <AnchoredPopover
          anchorRef={chip}
          width={280}
          role="dialog"
          label={`Edit ${row.key}`}
          onDismiss={dismiss}
        >
          <div
            ref={body}
            onKeyDownCapture={onKeyDownCapture}
            className="flex min-w-0 items-baseline gap-2 px-2 py-1"
          >
            <PropertyValue row={row} actions={actions} type={type} />
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}

interface PinnedChipsProps {
  /** The note's pinned rows in pin order. */
  rows: readonly PropertyRow[];
  typeOf: (row: PropertyRow) => PropertyType;
  actions: PropertyActions;
}

/** The pinned properties of the note after its tags in the collapsed header; those with no value
 *  show nothing, and past `PINNED_VISIBLE` the rest collapse to `+n`. */
export function PinnedChips({ rows, typeOf, actions }: PinnedChipsProps) {
  const shown = rows.flatMap((row) => {
    const text = chipText(row);
    return text === null ? [] : [{ row, text }];
  });
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.slice(0, PINNED_VISIBLE).map(({ row, text }) => (
        <PinnedChip key={row.key} row={row} type={typeOf(row)} text={text} actions={actions} />
      ))}
      {shown.length > PINNED_VISIBLE && (
        <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
          +{shown.length - PINNED_VISIBLE}
        </span>
      )}
    </span>
  );
}
