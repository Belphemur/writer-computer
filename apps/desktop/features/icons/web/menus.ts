// "Change icon..." in the context menus of the sidebar (file, folder, multi-selection) and of a
// tab: one item builder, four surfaces (`feature.json` `contributes.menus`).
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { openIconPicker } from "./picker-store";

/** The one item: opens the picker for `paths` (absolute). */
export function changeIconItems(paths: readonly string[]): MenuItemSpec[] {
  return [
    {
      kind: "item",
      id: "icons.change",
      text: "Change icon...",
      action: () => openIconPicker(paths),
    },
  ];
}
