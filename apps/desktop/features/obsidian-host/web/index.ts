// The Obsidian host as a built-in feature (SPECs/builtin-plugins-spec.md step 5). The API shim
// (`./host`), the plugins store, the plugin UI and the trust and consent flows live in this
// folder; the Rust commands stay core-registered and gated (spec section 15). This registers what
// only exists while community plugins can run: the host's boot and teardown, its palette commands,
// the plugin pane dock, the plugin browser, the Settings pages, the editor extensions and
// markdown processors, the ribbon and status strips and the tab bodies of its page kinds.
// Switched off, none of it exists and no plugin code loads. The plugin host itself (`./host`) is a
// dynamic import of the plugins store; this file imports the stores, which are small.
import { defineFeature } from "@/lib/features/registry";
import type { CommandContribution } from "@/lib/features/types";
import { isCompactFileMode } from "@/lib/keybindings/when";
import { usePluginsStore } from "./stores/plugins-store";
import { usePluginBrowserStore } from "./stores/plugin-browser-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import manifest from "../feature.json";
import { startHostLifecycle } from "./lifecycle";
import { publishRunningPlugins } from "./running-plugins";
import { syncSettingsPages } from "./settings-pages";

const workspaceWindow = () => useWorkspaceStore.getState().root !== null && !isCompactFileMode();

/** Availability names used in `feature.json`; the manifest names them, this is their meaning. */
const WHEN = {
  "workspace-window": workspaceWindow,
  "has-plugin-leaves": () => workspaceWindow() && usePluginsStore.getState().leaves.length > 0,
} as const;

const ACTIONS: Record<string, () => void> = {
  "obsidian-host.toggle-pane": () => usePluginsStore.getState().togglePane(),
  "obsidian-host.browse-plugins": () => usePluginBrowserStore.getState().open(),
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
    editorExtensions: [
      {
        id: "obsidian-host.editor",
        // Plugin editor extensions (the shared compartment), their guard and the markdown
        // processors: loaded when the first editor needs them, removed from live editors with the
        // feature (`lib/features/editor-extensions.ts`).
        load: () => import("./editor-extension").then((m) => m.pluginEditorExtension()),
      },
    ],
    slots: [
      {
        id: "obsidian-host.ribbon",
        slot: "sidebar-ribbon",
        load: () => import("./components/plugin-strips").then((m) => m.PluginRibbon),
      },
      {
        id: "obsidian-host.status-bar",
        slot: "editor-status",
        load: () => import("./components/plugin-strips").then((m) => m.PluginStatusBar),
      },
      {
        id: "obsidian-host.plugin-file-tab",
        slot: "page-view:plugin-file",
        load: () => import("./components/plugin-file-tab").then((m) => m.PluginFileTab),
      },
      {
        id: "obsidian-host.plugin-view-tab",
        slot: "page-view:plugin-view",
        load: () => import("./components/plugin-view-tab").then((m) => m.PluginViewTab),
      },
    ],
    // Plugin commands join the palette while a host runs; availability runs plugin code, so the
    // list is computed when the palette is open.
    commandSources: [
      {
        id: "obsidian-host.plugin-commands",
        list: () =>
          usePluginsStore
            .getState()
            .commands.filter((c) => c.isAvailable())
            .map((c) => ({
              id: c.id,
              label: c.name,
              description: "Plugin command",
              // After the palette dialog has released focus, so a command that opens a modal or
              // focuses the editor is not undone by the dialog's focus restore.
              run: () => void setTimeout(() => c.run(), 0),
            })),
      },
    ],
    // What core tells features: files changed on disk and the secret store, mirrored into the
    // plugin vault and `SecretStorage`.
    workspaceListeners: [
      {
        id: "obsidian-host.workspace-events",
        onFileChanged: (kind, path) => usePluginsStore.getState().notifyExternal(kind, path),
        onSecretChanged: (id, value) => usePluginsStore.getState().syncSecret(id, value),
        onSecretsReady: () => usePluginsStore.getState().retrySecrets(),
      },
    ],
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
        load: () => import("./components/plugin-view-pane").then((m) => m.PluginViewPane),
      },
    ],
    overlays: [
      {
        id: manifest.contributes.overlays[0]!,
        load: () =>
          import("./plugin-browser/plugin-browser-dialog").then((m) => m.PluginBrowserDialog),
      },
    ],
  },
  // Activated when a workspace opens (`onWorkspaceOpen`): follows the workspace, attaches the
  // host there and publishes the Settings pages; everything is undone when the feature goes off.
  activate(ctx) {
    ctx.disposables.add(syncSettingsPages());
    ctx.disposables.add(publishRunningPlugins());
    ctx.disposables.add(startHostLifecycle());
  },
});
