import { definePageKind, type SerializedLocation } from "./types";

/**
 * A community plugin's options page (the Obsidian `PluginSettingTab` it registered), shown as an
 * editor tab. The location carries the plugin id, the plugin's display name (so the title stays a
 * pure function of the location and survives a restore before the plugin has loaded) and an
 * optional setting-tab id for plugins that register several tabs.
 */
export type PluginSettingsLocation = {
  kind: "plugin-settings";
  pluginId: string;
  pluginName: string;
  tabId?: string;
};

// The view (PluginSettingsPage) is registered in `./views`. Persisted: at restore time the plugin
// may not be loaded yet, so the view renders a "Plugin not loaded" state instead of the tab.
export const pluginSettingsKind = definePageKind<"plugin-settings", PluginSettingsLocation>({
  kind: "plugin-settings",
  title: (l) => `${l.pluginName || l.pluginId} options`,
  description: "Community plugin options",
  keepAlive: true,
  fromPayload: (data: SerializedLocation) =>
    typeof data.pluginId === "string" && data.pluginId
      ? {
          kind: "plugin-settings",
          pluginId: data.pluginId,
          pluginName: typeof data.pluginName === "string" ? data.pluginName : data.pluginId,
          ...(typeof data.tabId === "string" ? { tabId: data.tabId } : {}),
        }
      : null,
  serialize: (l) => ({
    pluginId: l.pluginId,
    pluginName: l.pluginName,
    ...(l.tabId ? { tabId: l.tabId } : {}),
  }),
});
