import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import {
  contributedCreateItems,
  contributedMenuItems,
  withContributedItems,
} from "@/lib/features/menus";
import type { DirEntry } from "@/types/fs";
import { detectPlatform, revealLabelForPlatform, type Platform } from "./context-menu-utils";

export type FolderMenuActionId =
  | "new-file"
  | "new-folder"
  | "copy-relative-path"
  | "copy-absolute-path"
  | "open-terminal"
  | "reveal"
  | "rename"
  | "delete";

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
): Array<
  { kind: "item"; id: FolderMenuActionId; text: string; action: () => void } | { kind: "separator" }
> {
  return [
    { kind: "item", id: "new-file", text: "New Note", action: handlers.onNewFile },
    { kind: "item", id: "new-folder", text: "New Folder", action: handlers.onNewFolder },
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
    contributedCreateItems("sidebar-folder", entry),
    contributedMenuItems("sidebar-folder", entry),
  ]);
  const spec = buildFolderMenuItemsSpec(handlers);
  // the "New …" items of features follow New Note / New Folder, before the first separator
  const at = spec.findIndex((e) => e.kind === "separator");
  const withCreate = [...spec.slice(0, at), ...create, ...spec.slice(at)];
  await showNativeContextMenu(withContributedItems(withCreate, extra));
}
