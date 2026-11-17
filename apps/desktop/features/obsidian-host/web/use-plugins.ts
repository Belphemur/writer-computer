import { usePluginsStore } from "./stores/plugins-store";
import { usePluginBrowserStore } from "./stores/plugin-browser-store";
import { useUpdatesStore } from "./stores/plugin-updates-store";

export { PANE_MAX_WIDTH, PANE_MIN_WIDTH } from "./stores/plugins-store";

export function usePluginsSnapshot() {
  return usePluginsStore((s) => s.snapshot);
}
export function usePluginsBootError() {
  return usePluginsStore((s) => s.bootError);
}
export function usePluginsActionError() {
  return usePluginsStore((s) => s.actionError);
}
export function usePluginCommands() {
  return usePluginsStore((s) => s.commands);
}
export function usePluginRibbon() {
  return usePluginsStore((s) => s.ribbon);
}
export function usePluginStatusItems() {
  return usePluginsStore((s) => s.statusItems);
}
export function usePluginSettingTabs() {
  return usePluginsStore((s) => s.settingTabs);
}
export function usePluginLeaves() {
  return usePluginsStore((s) => s.leaves);
}
export function useActivePluginLeaf() {
  return usePluginsStore((s) => s.activeLeaf);
}
/** Leaves placed in the main editor area (each is shown as an editor tab). */
export function usePluginMainLeaves() {
  return usePluginsStore((s) => s.mainLeaves);
}
export function usePluginLeafRevision() {
  return usePluginsStore((s) => s.leafRevision);
}
export function useIsPluginPaneOpen() {
  return usePluginsStore((s) => s.isPaneOpen);
}
export function usePluginPaneWidth() {
  return usePluginsStore((s) => s.paneWidth);
}
export function useSetPluginPaneWidth() {
  return usePluginsStore((s) => s.setPaneWidth);
}
export function useClosePluginPane() {
  return usePluginsStore((s) => s.closePane);
}
export function useSelectPluginLeaf() {
  return usePluginsStore((s) => s.selectLeaf);
}
export function useTogglePluginPane() {
  return usePluginsStore((s) => s.togglePane);
}
export function useSetPluginsTrusted() {
  return usePluginsStore((s) => s.setTrusted);
}
export function useSetPluginEnabled() {
  return usePluginsStore((s) => s.setEnabled);
}
export function useRequestPluginsTrust() {
  return usePluginsStore((s) => s.requestTrust);
}
export function useReconcilePlugins() {
  return usePluginsStore((s) => s.reconcile);
}
export function useIsPluginBrowserOpen() {
  return usePluginBrowserStore((s) => s.isOpen);
}
export function useOpenPluginBrowser() {
  return usePluginBrowserStore((s) => s.open);
}
export function useClosePluginBrowser() {
  return usePluginBrowserStore((s) => s.close);
}

export function usePluginUpdateCount() {
  return useUpdatesStore((s) => Object.keys(s.available).length);
}
