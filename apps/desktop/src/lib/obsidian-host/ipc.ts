// Backend boundary of the plugin host. The Rust side owns trust, enablement, assets, plugin
// data and the store; the host only talks to it through this interface so tests can fake it.
import type { PluginManifest } from "./api/core";
import { invoke } from "@tauri-apps/api/core";

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
}

export interface PluginsState {
  trusted: boolean;
  enabled: string[];
  installed: InstalledPlugin[];
}

export type PluginAssetKind = "manifest" | "styles";

export interface HostIpc {
  state(): Promise<PluginsState>;
  setTrust(trusted: boolean): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  readAsset(id: string, kind: PluginAssetKind): Promise<string>;
  dataRead(id: string): Promise<string | null>;
  dataWrite(id: string, json: string): Promise<void>;
  storeList(): Promise<unknown>;
  storeDetail(id: string): Promise<unknown>;
  storeInstall(id: string): Promise<unknown>;
  storeUninstall(id: string): Promise<unknown>;
}

export const tauriHostIpc: HostIpc = {
  state: () => invoke("plugins_state"),
  setTrust: (trusted) => invoke("plugins_set_trust", { trusted }),
  setEnabled: (id, enabled) => invoke("plugins_set_enabled", { id, enabled }),
  readAsset: (id, kind) => invoke("plugin_read_asset", { id, kind }),
  dataRead: (id) => invoke("plugin_data_read", { id }),
  dataWrite: (id, json) => invoke("plugin_data_write", { id, json }),
  storeList: () => invoke("plugin_store_list"),
  storeDetail: (id) => invoke("plugin_store_detail", { id }),
  storeInstall: (id) => invoke("plugin_store_install", { id }),
  storeUninstall: (id) => invoke("plugin_store_uninstall", { id }),
};

/** `writer-plugin://localhost/<id>/main.js`, served by Rust wrapped in __writerPluginDefine. */
export function pluginScriptUrl(id: string, nonce: number): string {
  return `writer-plugin://localhost/${encodeURIComponent(id)}/main.js?n=${nonce}`;
}
