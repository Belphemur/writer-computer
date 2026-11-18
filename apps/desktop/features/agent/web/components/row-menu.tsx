import { useEffect, useRef, type RefObject } from "react";
import { AnchoredPopover } from "@/components/editor-area/anchored-popover";

export type RowMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip; explains a disabled entry. */
  hint?: string;
  /** Destructive entry (archive, delete): drawn in the danger colour. */
  destructive?: boolean;
};

const ENABLED = "[role=menuitem]:not(:disabled)";

/** The shared row actions menu (the history list's per-chat menu and the per-project menu of the
 *  project home and switcher), opened by a "..." button or a right click: arrow keys move, Enter picks, Esc and a click outside close it (the shared
 *  popover dismiss hook), and it is placed inside the window (`AnchoredPopover`). Focus goes to
 *  the first enabled entry on open and back to the anchor on close
 *  (unless the user moved it elsewhere). */
export function RowMenu({
  items,
  anchorRef,
  label,
  onClose,
}: {
  items: RowMenuItem[];
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    bodyRef.current?.querySelector<HTMLElement>(ENABLED)?.focus();
    return () => {
      // back to the anchor unless focus already went somewhere else (a click outside)
      const active = document.activeElement;
      if (!active || active === document.body) anchor?.focus();
    };
  }, [anchorRef]);

  const move = (delta: 1 | -1) => {
    const entries = [...(bodyRef.current?.querySelectorAll<HTMLElement>(ENABLED) ?? [])];
    if (entries.length === 0) return;
    const i = entries.indexOf(document.activeElement as HTMLElement);
    entries[(i + delta + entries.length) % entries.length]?.focus();
  };

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      width={176}
      role="menu"
      label={label}
      onDismiss={onClose}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Tab") {
          onClose();
        }
      }}
    >
      <div ref={bodyRef}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-[12.5px] ${
              item.destructive ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"
            } hover:bg-[var(--item-hover-bg)] focus:bg-[var(--item-hover-bg)] focus:outline-none disabled:opacity-50 disabled:hover:bg-transparent`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
