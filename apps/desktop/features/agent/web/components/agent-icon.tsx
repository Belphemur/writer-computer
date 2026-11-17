import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";

type IconSvgElement = NonNullable<ComponentProps<typeof HugeiconsIcon>["icon"]>;

export function Ico({
  icon,
  size = 14,
  className,
}: {
  icon: IconSvgElement;
  size?: number;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={1.75}
      className={className}
      aria-hidden="true"
    />
  );
}

/** Spinner that becomes a static "…" under prefers-reduced-motion (spec 3.7). */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex items-center text-text-icon-muted">
      <span className="motion-safe:inline motion-reduce:hidden">
        <Ico icon={Loading03Icon} size={size} className="animate-spin" />
      </span>
      <span className="hidden motion-reduce:inline">…</span>
    </span>
  );
}
