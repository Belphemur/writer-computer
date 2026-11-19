import { HugeiconsIcon } from "@hugeicons/react";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import type { SearchKind } from "@/lib/content-search";
import { useFileIcon } from "@/lib/file-icons";
import { kindIcon } from "@/lib/kind-icons";

/**
 * The icon of a result row: the icon the user (or Iconize) gave the file, else the glyph the
 * registry names for its kind. Nothing while the kinds have not arrived and the file has no icon
 * of its own, so a row never shows a wrong glyph first.
 */
export function ResultIcon({
  path,
  kind,
  kinds,
}: {
  path: string;
  kind: string | undefined;
  kinds: SearchKind[];
}) {
  const custom = useFileIcon(path);
  if (custom) return <IconGlyph value={custom.icon} color={custom.color} size={16} />;
  const named = kinds.find((k) => k.id === kind);
  if (!named) return null;
  return (
    <span aria-hidden="true" data-kind-icon={named.id} className="flex shrink-0 text-text-muted">
      <HugeiconsIcon icon={kindIcon(named.icon)} size={16} color="currentColor" strokeWidth={1.8} />
    </span>
  );
}
