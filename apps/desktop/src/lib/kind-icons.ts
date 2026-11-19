// The glyph of a file kind. The kind list (ids, labels, icon names) comes from the backend's
// registry over `search_kinds`; this is only the table from a Hugeicons name to its component, so
// a row can draw what the registry named. A name not listed here draws a plain file.
import type { IconSvgElement } from "@hugeicons/react";
import {
  CodeIcon,
  Database02Icon,
  DrawingModeIcon,
  File02Icon,
  ImageIcon,
  Pdf02Icon,
} from "@hugeicons/core-free-icons";

export const KIND_ICONS: Record<string, IconSvgElement> = {
  CodeIcon,
  Database02Icon,
  DrawingModeIcon,
  File02Icon,
  ImageIcon,
  Pdf02Icon,
};

export function kindIcon(name: string | undefined): IconSvgElement {
  return (name && KIND_ICONS[name]) || File02Icon;
}
