import { HugeiconsIcon } from "@hugeicons/react";
import { useHugeicon } from "@/lib/icon-picker/icon-set";
import { parseIconValue } from "@/lib/icon-picker/icon-value";

/**
 * A picked icon (`emoji:<emoji>` or `icon:<Hugeicons name>`, `lib/icon-picker/icon-value.ts`)
 * drawn at `size` px: an emoji as text, an icon in the text colour once its shard has loaded.
 * Nothing for a value that is none. Decorative: the label next to it says what it is.
 */
export function IconGlyph({
  value,
  size = 14,
  className,
}: {
  value: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const parsed = parseIconValue(value);
  const icon = useHugeicon(parsed?.kind === "icon" ? parsed.name : null);
  if (!parsed) return null;
  return (
    <span
      aria-hidden="true"
      data-icon-glyph={parsed.kind}
      className={`inline-flex shrink-0 items-center justify-center ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {parsed.kind === "emoji" ? (
        <span style={{ fontSize: size * 0.9, lineHeight: 1 }}>{parsed.name}</span>
      ) : icon ? (
        <HugeiconsIcon icon={icon} size={size} strokeWidth={1.75} color="currentColor" />
      ) : null}
    </span>
  );
}
