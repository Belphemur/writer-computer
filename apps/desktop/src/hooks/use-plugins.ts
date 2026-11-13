import { useEffect } from "react";
import { usePluginsStore } from "@/stores/plugins-store";
import { useIsStartupResolved, useWorkspaceChromeMode, useWorkspaceRoot } from "./use-workspace";

export { PANE_MAX_WIDTH, PANE_MIN_WIDTH } from "@/stores/plugins-store";

/**
 * Owns the plugin host for this window: attaches when a workspace is open (never for the
 * standalone compact window or the welcome screen) and detaches on workspace change/unmount.
 * Mount once, at the app root.
 */
export function usePluginHostLifecycle() {
  const root = useWorkspaceRoot();
  const chromeMode = useWorkspaceChromeMode();
  const isStartupResolved = useIsStartupResolved();
  const attach = usePluginsStore((s) => s.attach);
  const detach = usePluginsStore((s) => s.detach);
  const enabled = isStartupResolved && root !== null && chromeMode === "workspace";

  useEffect(() => {
    if (!enabled || root === null) return;
    void attach(root);
    return () => void detach();
  }, [enabled, root, attach, detach]);
}

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
