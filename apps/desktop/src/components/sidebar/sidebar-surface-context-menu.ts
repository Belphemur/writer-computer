import {
  showNativeContextMenu,
  type MenuItemSpec,
} from "@/components/editor-area/editor-context-menu";
import { detectPlatform, type Platform } from "@/lib/platform";
import { openFolderLabelForPlatform } from "@/lib/platform-labels";
import { contributedCreateItems, createMenuItems } from "./create-menu-items";
import { SIDEBAR_SORT_MODES, type SidebarSortMode } from "./sidebar-sort";

interface SidebarSurfaceWorkspaceActions {
  /** The vault root: where New Note, New Folder and the contributed "New …" items create. */
  root: string;
  sortMode: SidebarSortMode;
  foldersFirst: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onOpenInTerminal: () => void;
  onOpenInFileManager: () => void;
  onSortModeChange: (mode: SidebarSortMode) => void;
  onFoldersFirstChange: (foldersFirst: boolean) => void;
}

export interface SidebarSurfaceMenuState {
  showSearch: boolean;
  showRecents: boolean;
  workspaceActions: SidebarSurfaceWorkspaceActions | null;
  onToggleSearch: (visible: boolean) => void;
  onToggleRecents: (visible: boolean) => void;
}

export type SidebarSurfaceMenuEntry = MenuItemSpec;

/**
 * The "Sort by" submenu: one check item per sort mode, exactly one checked,
 * with a separator between the name / modified / created groups, then the
 * independent "Folders first" toggle at the bottom.
 */
function buildSortSubmenu(actions: SidebarSurfaceWorkspaceActions): SidebarSurfaceMenuEntry {
  const items: SidebarSurfaceMenuEntry[] = [];
  let lastGroup: string | null = null;
  for (const mode of SIDEBAR_SORT_MODES) {
    if (lastGroup !== null && mode.group !== lastGroup) items.push({ kind: "separator" });
    lastGroup = mode.group;
    items.push({
      kind: "check",
      id: mode.id,
      text: mode.text,
      checked: mode.id === actions.sortMode,
      action: () => actions.onSortModeChange(mode.id),
    });
  }
  items.push(
    { kind: "separator" },
    {
      kind: "check",
      id: "folders-first",
      text: "Folders first",
      checked: actions.foldersFirst,
      action: () => actions.onFoldersFirstChange(!actions.foldersFirst),
    },
  );
  return { kind: "submenu", id: "sort", text: "Sort by", items };
}

/**
 * Build the sidebar surface menu shown on empty space and section headers.
 * Workspace actions precede the always-present visibility checks. Pulled out
 * from `showSidebarSurfaceContextMenu` so it can be tested without Tauri.
 */
export function buildSidebarSurfaceMenuItemsSpec(
  state: SidebarSurfaceMenuState,
  platform: Platform = detectPlatform(),
  contributedCreate: readonly MenuItemSpec[] = [],
): SidebarSurfaceMenuEntry[] {
  const toggles: SidebarSurfaceMenuEntry[] = [
    {
      kind: "check",
      id: "toggle-search",
      text: "Search",
      checked: state.showSearch,
      action: () => state.onToggleSearch(!state.showSearch),
    },
    {
      kind: "check",
      id: "toggle-recents",
      text: "Recents",
      checked: state.showRecents,
      action: () => state.onToggleRecents(!state.showRecents),
    },
  ];

  if (!state.workspaceActions) return toggles;

  return [
    ...createMenuItems(state.workspaceActions, contributedCreate),
    { kind: "separator" },
    {
      kind: "item",
      id: "open-terminal",
      text: "Open in Terminal",
      action: state.workspaceActions.onOpenInTerminal,
    },
    {
      kind: "item",
      id: "open-file-manager",
      text: openFolderLabelForPlatform(platform),
      action: state.workspaceActions.onOpenInFileManager,
    },
    { kind: "separator" },
    buildSortSubmenu(state.workspaceActions),
    { kind: "separator" },
    ...toggles,
  ];
}

/** Pop up the sidebar surface menu at the cursor (the OS dismisses it). */
export async function showSidebarSurfaceContextMenu(state: SidebarSurfaceMenuState): Promise<void> {
  const create = state.workspaceActions
    ? await contributedCreateItems(state.workspaceActions.root)
    : [];
  await showNativeContextMenu(buildSidebarSurfaceMenuItemsSpec(state, detectPlatform(), create));
}
