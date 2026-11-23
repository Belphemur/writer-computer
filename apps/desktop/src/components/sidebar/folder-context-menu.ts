import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import { contributedMenuItems, withContributedItems } from "@/lib/features/menus";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { contributedCreateItems, createMenuItems } from "./create-menu-items";
import type { DirEntry } from "@/types/fs";
import { detectPlatform, type Platform } from "@/lib/platform";
import { revealLabelForPlatform } from "@/lib/platform-labels";

export interface FolderContextMenuHandlers {
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopyRelativePath: () => void;
  onCopyAbsolutePath: () => void;
  onOpenInTerminal: () => void;
  onReveal: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * Build the items array for the folder row context menu. Pulled out from
 * `showFolderContextMenu` so it can be unit-tested without the Tauri runtime.
 */
export function buildFolderMenuItemsSpec(
  handlers: FolderContextMenuHandlers,
  platform: Platform = detectPlatform(),
  contributedCreate: readonly MenuItemSpec[] = [],
): MenuItemSpec[] {
  return [
    ...createMenuItems(handlers, contributedCreate),
    { kind: "separator" },
    {
      kind: "item",
      id: "copy-relative-path",
      text: "Copy relative path",
      action: handlers.onCopyRelativePath,
    },
    {
      kind: "item",
      id: "copy-absolute-path",
      text: "Copy absolute path",
      action: handlers.onCopyAbsolutePath,
    },
    { kind: "separator" },
    {
      kind: "item",
      id: "open-terminal",
      text: "Open in Terminal",
      action: handlers.onOpenInTerminal,
    },
    {
      kind: "item",
      id: "reveal",
      text: revealLabelForPlatform(platform),
      action: handlers.onReveal,
    },
    { kind: "separator" },
    { kind: "item", id: "rename", text: "Rename...", action: handlers.onRename },
    { kind: "item", id: "delete", text: "Delete", action: handlers.onDelete },
  ];
}

/**
 * Pop up the folder row menu: the core items, then what features contributed for `entry`
 * (`sidebar-folder`).
 */
export async function showFolderContextMenu(
  handlers: FolderContextMenuHandlers,
  entry: DirEntry,
): Promise<void> {
  const [create, extra] = await Promise.all([
    contributedCreateItems(entry.path),
    contributedMenuItems("sidebar-folder", entry),
  ]);
  await showNativeContextMenu(
    withContributedItems(buildFolderMenuItemsSpec(handlers, detectPlatform(), create), extra),
  );
}
