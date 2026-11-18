// The icon buttons of a surface's toolbar (search, Whole vault or local, Fit, panel), shared by the
// tab and the local panel so the two stay in step. Icons carry an accessible name and a tooltip.
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

export const TOOL_BUTTON =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] aria-pressed:bg-[var(--item-active-bg)] disabled:opacity-30";

export function ToolbarButton({
  icon,
  label,
  pressed,
  onClick,
  disabled,
}: {
  icon: Icon;
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${TOOL_BUTTON} w-7 px-0`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} size={15} />
    </button>
  );
}
