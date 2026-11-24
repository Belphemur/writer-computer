import type { ComponentProps } from "react";

/** The pill look of a filter chip, selected or not. */
const look = (pressed: boolean) =>
  `shrink-0 rounded-full px-2.5 py-0.5 text-xs transition-colors ${
    pressed
      ? "bg-[var(--surface-selected)] font-medium text-[var(--text-primary)]"
      : "text-text-muted hover:bg-[var(--item-hover-bg)]"
  }`;

/** A filter chip: a toggle button (`aria-pressed`) in the shared pill look. The palette's kind
 *  filter and the OpenCode models table's Enabled and Free chips are this. */
export function FilterChip({
  pressed,
  onClick,
  children,
  ...rest
}: {
  pressed: boolean;
  onClick: () => void;
} & Omit<ComponentProps<"button">, "onClick" | "className" | "type" | "aria-pressed"> & {
    [data: `data-${string}`]: unknown;
  }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={look(pressed)}
      {...rest}
    >
      {children}
    </button>
  );
}
