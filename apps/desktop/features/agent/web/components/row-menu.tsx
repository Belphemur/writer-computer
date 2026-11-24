import { useRef, type RefObject } from "react";
import { useMenuKeyboard } from "@/hooks/use-menu-keyboard";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { AnchoredPopover } from "@/components/editor-area/anchored-popover";

export type RowMenuItem = {
  id: string;
  label: string;
  /** Every entry has an icon, drawn before its label. */
  icon: IconSvgElement;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip; explains a disabled entry. */
  hint?: string;
  /** Destructive entry (archive, delete): drawn in the danger colour. */
  destructive?: boolean;
};

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

  const onKeyDown = useMenuKeyboard(bodyRef, { onClose, returnFocusTo: anchorRef });

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      width={176}
      role="menu"
      label={label}
      onDismiss={onClose}
      onKeyDown={onKeyDown}
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
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] ${
              item.destructive ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"
            } hover:bg-[var(--item-hover-bg)] focus:bg-[var(--item-hover-bg)] focus:outline-none disabled:opacity-50 disabled:hover:bg-transparent`}
          >
            <HugeiconsIcon icon={item.icon} size={14} strokeWidth={1.8} className="shrink-0" />
            {item.label}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
