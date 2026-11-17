import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import { contributedMenuItems, withContributedItems } from "@/lib/features/menus";

export type BulkMenuActionId = "delete" | "copy-relative-paths" | "copy-absolute-paths";

export interface BulkContextMenuHandlers {
  onDelete: () => void;
  onCopyRelativePaths: () => void;
  onCopyAbsolutePaths: () => void;
}

export function buildBulkMenuItemsSpec(
  handlers: BulkContextMenuHandlers,
  count: number,
): Array<
  { kind: "item"; id: BulkMenuActionId; text: string; action: () => void } | { kind: "separator" }
> {
  return [
    {
      kind: "item",
      id: "copy-relative-paths",
      text: `Copy ${count} relative paths`,
      action: handlers.onCopyRelativePaths,
    },
    {
      kind: "item",
      id: "copy-absolute-paths",
      text: `Copy ${count} absolute paths`,
      action: handlers.onCopyAbsolutePaths,
    },
    { kind: "separator" },
    {
      kind: "item",
      id: "delete",
      text: `Delete ${count} items`,
      action: handlers.onDelete,
    },
  ];
}

/** Pop up the multi-selection menu: the core items, then what features contributed for `paths`
 *  (`sidebar-bulk`). */
export async function showBulkContextMenu(
  handlers: BulkContextMenuHandlers,
  paths: readonly string[],
): Promise<void> {
  const extra = await contributedMenuItems("sidebar-bulk", paths);
  await showNativeContextMenu(
    withContributedItems(buildBulkMenuItemsSpec(handlers, paths.length), extra),
  );
}
