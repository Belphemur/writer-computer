import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import { contributedMenuItems, withContributedItems } from "@/lib/features/menus";
import type { DirEntry } from "@/types/fs";
import { detectPlatform, revealLabelForPlatform, type Platform } from "./context-menu-utils";

export { detectPlatform, revealLabelForPlatform, type Platform } from "./context-menu-utils";

export type FileMenuActionId =
  | "open"
  | "open-in-new-tab"
  | "toggle-pin"
  | "duplicate"
  | "copy-relative-path"
  | "copy-absolute-path"
  | "reveal"
  | "rename"
  | "set-display-title"
  | "delete";

export interface FileContextMenuHandlers {
  isPinned?: boolean;
  onOpen: () => void;
  onOpenInNewTab: () => void;
  onTogglePin: () => void;
  onDuplicate: () => void;
  onCopyRelativePath: () => void;
  onCopyAbsolutePath: () => void;
  onReveal: () => void;
  onRename: () => void;
  /** Markdown notes only: opens the display-title dialog (the frontmatter `title`). */
  onSetDisplayTitle?: () => void;
  onDelete: () => void;
}

/**
 * Build the items array for the file row context menu in the order described
 * by the spec. Pulled out from `showFileContextMenu` so it can be unit-tested
 * without depending on the Tauri runtime.
 */
export function buildFileMenuItemsSpec(
  handlers: FileContextMenuHandlers,
  platform: Platform = detectPlatform(),
): Array<
  { kind: "item"; id: FileMenuActionId; text: string; action: () => void } | { kind: "separator" }
> {
  return [
    { kind: "item", id: "open", text: "Open", action: handlers.onOpen },
    {
      kind: "item",
      id: "open-in-new-tab",
      text: "Open in new tab",
      action: handlers.onOpenInNewTab,
    },
    {
      kind: "item",
      id: "toggle-pin",
      text: handlers.isPinned ? "Unpin" : "Pin",
      action: handlers.onTogglePin,
    },
    { kind: "separator" },
    { kind: "item", id: "duplicate", text: "Duplicate", action: handlers.onDuplicate },
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
      id: "reveal",
      text: revealLabelForPlatform(platform),
      action: handlers.onReveal,
    },
    { kind: "separator" },
    // Renames the file itself and rewrites the links to it; the display title is separate.
    { kind: "item", id: "rename", text: "Rename file...", action: handlers.onRename },
    ...(handlers.onSetDisplayTitle
      ? [
          {
            kind: "item" as const,
            id: "set-display-title" as const,
            text: "Set display title...",
            action: handlers.onSetDisplayTitle,
          },
        ]
      : []),
    { kind: "item", id: "delete", text: "Delete", action: handlers.onDelete },
  ];
}

/**
 * Pop up the file row menu at the current cursor position (a native menu, dismissed by the OS):
 * the core items, then what features contributed for `entry` (`sidebar-file`).
 */
export async function showFileContextMenu(
  handlers: FileContextMenuHandlers,
  entry: DirEntry,
): Promise<void> {
  const extra = await contributedMenuItems("sidebar-file", entry);
  await showNativeContextMenu(withContributedItems(buildFileMenuItemsSpec(handlers), extra));
}
