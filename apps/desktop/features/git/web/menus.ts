// "Show history" in the context menus of a file row and of a tab: one item builder, two surfaces
// (`feature.json` `contributes.menus`). Offered only once the vault has version history.
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { openGitHistoryTab } from "@/hooks/editor-api";
import { useGitStatus } from "./lib/status-store";

/** The item for the file at `path` (absolute); nothing before the vault is set up. */
export function showHistoryItems(path: string): MenuItemSpec[] {
  if (useGitStatus.getState().status?.setUp !== true) return [];
  return [
    {
      kind: "item",
      id: "git.show-history",
      text: "Show history",
      action: () => openGitHistoryTab({ path }),
    },
  ];
}
