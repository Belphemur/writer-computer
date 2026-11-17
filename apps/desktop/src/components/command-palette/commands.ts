// Command registry for the palette. Built-ins are data (id, label, availability, action), and
// features add commands as data or as sources (the Obsidian host's plugin commands): adding a
// command means adding one entry here, not another branch in the component.
import {
  featurePaletteCommands,
  featurePaletteSources,
  type FeaturePaletteCommand,
} from "@/lib/features/palette";
import "@/lib/keybindings/core-bindings";
import { keybindings } from "@/lib/keybindings/registry";
import { settingsKind } from "@/components/editor-area/page-kinds/settings";
import { TITLE_PALETTE_COMMANDS } from "./title-commands";

/** Everything a built-in command may read or do. Supplied by the palette component. */
export interface CommandContext {
  hasWorkspace: boolean;
  isCompactFileMode: boolean;
  activeFilePath: string | null;
  hasActiveTab: boolean;
  tabCount: number;
  /** Tabs Close All Tabs would close (pinned tabs stay). */
  unpinnedTabCount: number;
  /** The active tab's pin state; `null` when it cannot be pinned (the new-tab page). */
  activeTabPin: "pinned" | "unpinned" | null;
  /** Is there a closed tab to bring back (the reopen stack is not empty)? */
  hasClosedTabs: boolean;
  /** Closes the palette. Built-ins close it after running unless `keepOpen`. */
  close: () => void;
  toggleSidebar: () => void;
  openCreateFile: () => void;
  openSearchNotes: () => void;
  openFileInCompactWindow: (path: string) => void;
  pinActiveTab: () => void;
  unpinActiveTab: () => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  reopenClosedTab: () => void;
  openWorkspace: () => Promise<void>;
  closeWorkspace: () => void;
  toggleTheme: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  openSettings: () => void;
  openLogFolder: () => void;
  copyRecentErrors: () => void;
}

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  /** The key bound to this command, read from the keybinding registry (never typed here). */
  shortcut?: string;
  run: () => void;
}

interface BuiltinCommand {
  id: string;
  label: string;
  description: string;
  when?: (ctx: CommandContext) => boolean;
  /** The action owns closing the palette (it opens another palette mode or closes async). */
  keepOpen?: boolean;
  run: (ctx: CommandContext) => void;
}

const COMMAND = "Command";

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    description: COMMAND,
    when: (c) => c.hasWorkspace && !c.isCompactFileMode,
    run: (c) => c.toggleSidebar(),
  },
  {
    id: "new-file",
    label: "Create New File",
    description: COMMAND,
    when: (c) => c.hasWorkspace || (c.isCompactFileMode && c.activeFilePath !== null),
    keepOpen: true,
    run: (c) => c.openCreateFile(),
  },
  {
    id: "search-notes",
    label: "Search in Notes",
    description: COMMAND,
    when: (c) => c.hasWorkspace && !c.isCompactFileMode,
    keepOpen: true,
    run: (c) => c.openSearchNotes(),
  },
  {
    id: "open-in-compact-window",
    label: "Open File in Compact Window",
    description: COMMAND,
    when: (c) => c.hasWorkspace && c.activeFilePath !== null,
    run: (c) => c.activeFilePath && c.openFileInCompactWindow(c.activeFilePath),
  },
  {
    id: "pin-tab",
    label: "Pin Tab",
    description: COMMAND,
    when: (c) => c.activeTabPin === "unpinned" && !c.isCompactFileMode,
    run: (c) => c.pinActiveTab(),
  },
  {
    id: "unpin-tab",
    label: "Unpin Tab",
    description: COMMAND,
    when: (c) => c.activeTabPin === "pinned" && !c.isCompactFileMode,
    run: (c) => c.unpinActiveTab(),
  },
  {
    id: "close-tab",
    label: "Close Current Tab",
    // On a pinned tab it unpins first (SPECs/pinned-tabs-spec.md), like Cmd+W.
    description: COMMAND,
    when: (c) => c.hasActiveTab && !c.isCompactFileMode,
    run: (c) => c.closeActiveTab(),
  },
  {
    id: "reopen-closed-tab",
    label: "Reopen Closed Tab",
    description: COMMAND,
    when: (c) => c.hasClosedTabs && !c.isCompactFileMode,
    run: (c) => c.reopenClosedTab(),
  },
  {
    id: "close-all",
    label: "Close All Tabs",
    description: COMMAND,
    when: (c) => c.unpinnedTabCount > 0 && !c.isCompactFileMode,
    run: (c) => c.closeAllTabs(),
  },
  {
    id: "open-workspace",
    label: "Open Workspace",
    description: COMMAND,
    keepOpen: true,
    run: (c) => void c.openWorkspace(),
  },
  {
    id: "close-workspace",
    label: "Close Workspace",
    description: COMMAND,
    when: (c) => c.hasWorkspace,
    run: (c) => c.closeWorkspace(),
  },
  {
    id: "toggle-theme",
    label: "Toggle Dark Mode",
    description: COMMAND,
    run: (c) => c.toggleTheme(),
  },
  { id: "zoom-in", label: "Zoom In", description: COMMAND, run: (c) => c.zoomIn() },
  { id: "zoom-out", label: "Zoom Out", description: COMMAND, run: (c) => c.zoomOut() },
  { id: "zoom-reset", label: "Reset Zoom", description: COMMAND, run: (c) => c.resetZoom() },
  {
    id: "open-log-folder",
    label: "Open log folder",
    description: COMMAND,
    run: (c) => c.openLogFolder(),
  },
  {
    id: "copy-recent-errors",
    label: "Copy recent errors",
    description: COMMAND,
    run: (c) => c.copyRecentErrors(),
  },
  {
    id: "open-settings",
    label: "Settings",
    description: settingsKind.description,
    when: (c) => !c.isCompactFileMode,
    run: (c) => c.openSettings(),
  },
  ...TITLE_PALETTE_COMMANDS,
];

/**
 * Built-ins (and feature-contributed commands) available in `ctx`, then the commands the features'
 * sources list right now (the Obsidian host's plugin commands evaluate `checkCallback` /
 * `editorCheckCallback` / editor requirements here). A source never takes a built-in's id.
 */
export function resolveCommands(ctx: CommandContext): PaletteCommand[] {
  const toPalette = (c: Omit<FeaturePaletteCommand, "owner">): PaletteCommand => ({
    id: c.id,
    label: c.label,
    description: c.description,
    shortcut: keybindings.shortcutFor(c.id),
    run: () => {
      c.run(ctx);
      if (!c.keepOpen) ctx.close();
    },
  });
  const builtins = [...BUILTIN_COMMANDS, ...featurePaletteCommands.list()]
    .filter((c) => c.when?.(ctx) ?? true)
    .map(toPalette);
  const taken = new Set(builtins.map((c) => c.id));
  const sourced = featurePaletteSources
    .list()
    .flatMap((s) => s.list(ctx))
    .filter((c) => !taken.has(c.id) && (c.when?.(ctx) ?? true))
    .map(toPalette);
  return [...builtins, ...sourced];
}
