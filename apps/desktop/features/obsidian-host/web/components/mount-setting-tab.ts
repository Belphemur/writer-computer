import { recordPluginError } from "../host/error-log";
import type { SettingTabLike } from "../host/api/core";

export interface MountedSettingTab {
  /** Message of the error display() threw, or null. */
  error: string | null;
  /** hide() the tab and detach its container. Never throws; safe to call once. */
  dispose: () => void;
}

/**
 * Attaches a plugin PluginSettingTab's containerEl into `host`, then calls display() (plugins
 * such as Copilot render a React root into the container and expect it to be in the document).
 * A throwing display() is recorded and returned, never propagated.
 */
export function mountSettingTab(
  host: HTMLElement,
  pluginId: string,
  tab: SettingTabLike,
): MountedSettingTab {
  host.replaceChildren(tab.containerEl);
  let error: string | null = null;
  try {
    if (tab.hostDisplay) tab.hostDisplay();
    else tab.display();
  } catch (e) {
    console.error(`[plugin] settings tab ${pluginId}:${tab.id} display threw:`, e);
    recordPluginError(pluginId, "settings-tab", e);
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    error,
    dispose() {
      try {
        tab.hide();
      } catch (e) {
        console.error(`[plugin] settings tab ${pluginId}:${tab.id} hide threw:`, e);
        recordPluginError(pluginId, "settings-tab-hide", e);
      }
      if (tab.containerEl.parentElement === host) tab.containerEl.remove();
    },
  };
}
