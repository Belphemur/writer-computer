import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { menuTypes, MISMATCH_ICON, PROPERTY_TYPES, type PropertyType } from "@/lib/property-types";
import { AnchoredPopover } from "./anchored-popover";

interface TypeMenuProps {
  current: PropertyType;
  anchorRef: React.RefObject<HTMLElement | null>;
  onPick: (type: PropertyType) => void;
  /** Escape or a pick: the caller returns focus to the anchor. Click-outside does not. */
  onClose: (refocus: boolean) => void;
}

/** The type list: arrows/Home/End move focus, Enter or click picks, Escape closes. */
export function PropertyTypeMenu({ current, anchorRef, onPick, onClose }: TypeMenuProps) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const types = menuTypes(current);
  const focusItem = (i: number) => items.current[(i + types.length) % types.length]?.focus();
  useEffect(() => {
    items.current[Math.max(0, types.indexOf(current))]?.focus();
    // On open only: later re-renders must not pull focus back from an arrow-key move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      width={176}
      role="menu"
      label="Property type"
      onDismiss={() => onClose(false)}
      onKeyDown={(e) => {
        const at = items.current.findIndex((el) => el === document.activeElement);
        if (e.key === "ArrowDown") focusItem(at + 1);
        else if (e.key === "ArrowUp") focusItem(at < 0 ? -1 : at - 1);
        else if (e.key === "Home") focusItem(0);
        else if (e.key === "End") focusItem(-1);
        else if (e.key === "Escape") onClose(true);
        else if (e.key === "Tab") onClose(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {types.map((type, i) => (
        <button
          key={type}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={type === current}
          onClick={() => {
            onPick(type);
            onClose(true);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)]"
        >
          <HugeiconsIcon
            icon={PROPERTY_TYPES[type].icon}
            size={14}
            color="currentColor"
            strokeWidth={1.75}
            className="shrink-0 text-[var(--text-muted)]"
          />
          <span className="min-w-0 flex-1 truncate">{PROPERTY_TYPES[type].label}</span>
          {type === current && (
            <HugeiconsIcon icon={Tick02Icon} size={14} color="currentColor" strokeWidth={2} />
          )}
        </button>
      ))}
    </AnchoredPopover>
  );
}

interface TypeControlProps {
  name: string;
  type: PropertyType;
  /** Whether the row's value fits `type`; false shows the unknown/mixed state. */
  fits: boolean;
  /** Other notes whose value does not fit the vault-wide type. */
  mismatched?: number;
  onChange: (type: PropertyType) => void;
}

/** The type icon at the start of a property row; clicking it opens the type menu. */
export function PropertyTypeControl({
  name,
  type,
  fits,
  mismatched = 0,
  onChange,
}: TypeControlProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const def = PROPERTY_TYPES[type];
  const tip = [
    fits ? def.label : `${def.label}: ${def.warning.toLowerCase()}`,
    mismatched > 0
      ? `${mismatched} ${mismatched === 1 ? "note has" : "notes have"} a value that does not fit`
      : null,
    "Click to change type",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${name}: ${def.label}. Change type`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tip}
        data-type={type}
        data-mismatch={fits ? undefined : ""}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-5 w-5 shrink-0 items-center justify-center self-center rounded transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)] ${
          fits ? "text-[var(--text-icon-muted)]" : "text-[var(--warning)]"
        }`}
      >
        <HugeiconsIcon
          icon={fits ? def.icon : MISMATCH_ICON}
          size={14}
          color="currentColor"
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <PropertyTypeMenu
          current={type}
          anchorRef={button}
          onPick={onChange}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}
