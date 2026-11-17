// The Obsidian host as a built-in feature (SPECs/builtin-plugins-spec.md step 5): a lifecycle
// wrapper. The API shim (`lib/obsidian-host`), the plugins store and the trust and consent flows
// are core and unchanged; this registers what only exists while community plugins can run: the
// host's boot and teardown, its palette commands, the plugin pane dock, the plugin browser, and
// the Settings pages. Switched off, none of it exists and no plugin code loads.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution } from "@/lib/features/types";
import { isCompactFileMode } from "@/lib/keybindings/when";
import { usePluginsStore } from "@/stores/plugins-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import manifest from "../feature.json";
import { startHostLifecycle } from "./lifecycle";
import { syncSettingsPages } from "./settings-pages";

const workspaceWindow = () => useWorkspaceStore.getState().root !== null && !isCompactFileMode();

/** Availability names used in `feature.json`; the manifest names them, this is their meaning. */
const WHEN = {
  "workspace-window": workspaceWindow,
  "has-plugin-leaves": () => workspaceWindow() && usePluginsStore.getState().leaves.length > 0,
} as const;

const ACTIONS: Record<string, () => void> = {
  "obsidian-host.toggle-pane": () => usePluginsStore.getState().togglePane(),
  "obsidian-host.browse-plugins": () => useUIStore.getState().openPluginBrowser(),
};

const commands: CommandContribution[] = manifest.contributes.commands.map((c) => ({
  id: c.id,
  label: c.label,
  description: c.description,
  when: WHEN[c.when as keyof typeof WHEN],
  run: () => ACTIONS[c.id]!(),
}));

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands,
    docks: [
      {
        id: manifest.contributes.docks[0]!,
        // Below the agent pane (20); one column, the pane opened last wins (`use-docks`).
        priority: 10,
        isOpen: () => {
          const s = usePluginsStore.getState();
          return s.isPaneOpen && s.activeLeaf !== null;
        },
        width: () => usePluginsStore.getState().paneWidth,
        close: () => usePluginsStore.getState().closePane(),
        subscribe: (listener) => usePluginsStore.subscribe(listener),
        load: () => import("@/components/plugins/plugin-view-pane").then((m) => m.PluginViewPane),
      },
    ],
    overlays: [
      {
        id: manifest.contributes.overlays[0]!,
        load: () =>
          import("@/components/plugin-browser/plugin-browser-dialog").then(
            (m) => m.PluginBrowserDialog,
          ),
      },
    ],
  },
  // Activated when a workspace opens (`onWorkspaceOpen`): follows the workspace, attaches the
  // host there and publishes the Settings pages; everything is undone when the feature goes off.
  activate(ctx) {
    ctx.disposables.add(syncSettingsPages());
    ctx.disposables.add(startHostLifecycle());
  },
});
