import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useMenuKeyboard } from "@/hooks/use-menu-keyboard";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";

type DataAttrs = { [data: `data-${string}`]: unknown };
type ButtonProps = ComponentProps<"button"> & DataAttrs;

/** The chip button's look; a chip adds to it through `buttonProps.className`. */
const CHIP =
  "rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)]";

const ROW = "block w-full rounded-md px-2 text-left hover:bg-[var(--item-hover-bg)]";
const SIZE = { md: "py-1.5 text-[12.5px]", sm: "py-1 text-[12px]" } as const;

type RowProps = {
  onSelect: () => void;
  size?: keyof typeof SIZE;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "onClick" | "className" | "role" | "type" | "children"> &
  DataAttrs;

/** A checkable row of a chip menu (`menuitemradio`, a check mark before the label when chosen). */
export function ChipMenuRadio({
  checked,
  onSelect,
  size = "md",
  className = "",
  children,
  ...rest
}: RowProps & { checked: boolean }) {
  return (
    <button
      role="menuitemradio"
      type="button"
      aria-checked={checked}
      onClick={onSelect}
      className={`${ROW} ${SIZE[size]} aria-checked:font-medium ${className}`}
      {...rest}
    >
      {checked ? "✓ " : ""}
      {children}
    </button>
  );
}

/** An action row of a chip menu (`menuitem`). */
export function ChipMenuItem({
  onSelect,
  size = "md",
  className = "",
  children,
  ...rest
}: RowProps) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onSelect}
      className={`${ROW} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The composer's chip with a menu above it (mode, model, harness): the button, the popover's
 * placement and dismissal, and the keyboard of `useMenuKeyboard`. Content is the caller's, given
 * a `close`.
 */
export function ChipMenu({
  buttonProps,
  menuLabel,
  width,
  maxHeight,
  children,
}: {
  buttonProps: ButtonProps;
  menuLabel: string;
  width: number;
  maxHeight?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(wrapRef, wrapRef, () => setOpen(false), open);
  const placement = usePopoverPlacement(wrapRef, open, { width, maxHeight });
  const onKeyDown = useMenuKeyboard(menuRef, {
    onClose: () => setOpen(false),
    returnFocusTo: buttonRef,
    open,
  });
  const { className = "", ...button } = buttonProps;

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${CHIP} ${className}`}
        {...button}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={menuLabel}
          style={placement}
          className="absolute bottom-full left-0 z-30 mb-1 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
