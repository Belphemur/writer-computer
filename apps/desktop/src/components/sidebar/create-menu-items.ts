// The "New …" section of the sidebar's right-click menus, one list for every surface that creates
// in a folder (a folder row, the sidebar's empty area): New Note and New Folder, then the items
// features contribute on the `sidebar-create` surface for that folder (New Drawing, ...).
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { contributedMenuItems } from "@/lib/features/menus";

export interface CreateMenuHandlers {
  onNewFile: () => void;
  onNewFolder: () => void;
}

/** The section, given what features contributed (`contributedCreateItems`). */
export function createMenuItems(
  handlers: CreateMenuHandlers,
  contributed: readonly MenuItemSpec[] = [],
): MenuItemSpec[] {
  return [
    { kind: "item", id: "new-file", text: "New Note", action: handlers.onNewFile },
    { kind: "item", id: "new-folder", text: "New Folder", action: handlers.onNewFolder },
    ...contributed,
  ];
}

/** What features add to the section for `folder` (absolute path). */
export function contributedCreateItems(folder: string): Promise<MenuItemSpec[]> {
  return contributedMenuItems("sidebar-create", folder);
}
