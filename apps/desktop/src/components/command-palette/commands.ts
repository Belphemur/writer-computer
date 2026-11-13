// Command registry for the palette. Built-ins are data (id, label, availability, action) and
// plugin commands are merged in from the host's command registry: adding a command means adding
// one entry here, not another branch in the component.
import type { RegisteredCommand } from "@/lib/obsidian-host/api/core";
import { settingsKind } from "@/components/editor-area/page-kinds/settings";

/** Everything a built-in command may read or do. Supplied by the palette component. */
export interface CommandContext {
  hasWorkspace: boolean;
  isCompactFileMode: boolean;
  activeFilePath: string | null;
  hasActiveTab: boolean;
  tabCount: number;
  hasPluginLeaves: boolean;
  /** Closes the palette. Built-ins close it after running unless `keepOpen`. */
  close: () => void;
  toggleSidebar: () => void;
  openCreateFile: () => void;
  openFileInCompactWindow: (path: string) => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  openWorkspace: () => Promise<void>;
  closeWorkspace: () => void;
  toggleTheme: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  openSettings: () => void;
  togglePluginPane: () => void;
  openPluginBrowser: () => void;
}

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
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
    id: "open-in-compact-window",
    label: "Open File in Compact Window",
    description: COMMAND,
    when: (c) => c.hasWorkspace && c.activeFilePath !== null,
    run: (c) => c.activeFilePath && c.openFileInCompactWindow(c.activeFilePath),
  },
  {
    id: "close-tab",
    label: "Close Current Tab",
    description: COMMAND,
    when: (c) => c.hasActiveTab && !c.isCompactFileMode,
    run: (c) => c.closeActiveTab(),
  },
  {
    id: "close-all",
    label: "Close All Tabs",
    description: COMMAND,
    when: (c) => c.tabCount > 0 && !c.isCompactFileMode,
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
    id: "toggle-plugin-pane",
    label: "Toggle Plugin Side Pane",
    description: COMMAND,
    when: (c) => c.hasWorkspace && !c.isCompactFileMode && c.hasPluginLeaves,
    run: (c) => c.togglePluginPane(),
  },
  {
    id: "browse-community-plugins",
    label: "Browse community plugins",
    description: COMMAND,
    when: (c) => c.hasWorkspace && !c.isCompactFileMode,
    run: (c) => c.openPluginBrowser(),
  },
  {
    id: "open-settings",
    label: "Settings",
    description: settingsKind.description,
    when: (c) => !c.isCompactFileMode,
    run: (c) => c.openSettings(),
  },
];

/**
 * Built-ins available in `ctx`, then the plugin commands that can run right now
 * (`checkCallback` / `editorCheckCallback` / editor requirements are evaluated here).
 */
export function resolveCommands(
  ctx: CommandContext,
  pluginCommands: readonly RegisteredCommand[],
): PaletteCommand[] {
  const builtins = BUILTIN_COMMANDS.filter((c) => c.when?.(ctx) ?? true).map(
    (c): PaletteCommand => ({
      id: c.id,
      label: c.label,
      description: c.description,
      run: () => {
        c.run(ctx);
        if (!c.keepOpen) ctx.close();
      },
    }),
  );
  const taken = new Set(builtins.map((c) => c.id));
  const plugins = pluginCommands
    .filter((c) => !taken.has(c.id) && c.isAvailable())
    .map(
      (c): PaletteCommand => ({
        id: c.id,
        label: c.name,
        description: "Plugin command",
        run: () => {
          ctx.close();
          // After the palette dialog has released focus, so a command that opens a modal or
          // focuses the editor is not undone by the dialog's focus restore.
          setTimeout(() => c.run(), 0);
        },
      }),
    );
  return [...builtins, ...plugins];
}
