import { typeKey } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { IconGlyph } from "./icon-glyph";

/**
 * The icon of one value of an enum property, if the type records one (`property_type_set`, the
 * `icons` of the enum entry): the one way every surface (properties panel, dropdown rows, Bases
 * cells, cards and group headers) draws it. Nothing for a value without an icon or a property
 * that is not an enum, so a value looks as it always did. Never drawn in the note body.
 */
export function EnumValueIcon({
  property,
  value,
  size = 14,
  className,
}: {
  property: string;
  value: string;
  size?: number;
  className?: string;
}) {
  const icon = usePropertyTypesStore((s) => {
    const info = s.byKey[typeKey(property)];
    return info?.type === "enum" ? info.icons?.[value] : undefined;
  });
  return icon ? <IconGlyph value={icon} size={size} className={className} /> : null;
}
