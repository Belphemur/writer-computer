import { useEffect } from "react";
import { usePluginsStore } from "@/stores/plugins-store";
import { useUIStore } from "@/stores/ui-store";
import { useUpdatesStore } from "@/stores/plugin-updates-store";
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
    // Update state is bound to the same vault; the scheduler checks shortly after start and
    // then every few hours (throttled by the persisted timestamp, silent on failure).
    const updates = useUpdatesStore.getState();
    void updates.attachRoot(root);
    const stopChecks = updates.startScheduler();
    return () => {
      stopChecks();
      void updates.attachRoot(null);
      void detach();
    };
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
  return useUIStore((s) => s.isPluginBrowserOpen);
}
export function useOpenPluginBrowser() {
  return useUIStore((s) => s.openPluginBrowser);
}
export function useClosePluginBrowser() {
  return useUIStore((s) => s.closePluginBrowser);
}

export function usePluginUpdateCount() {
  return useUpdatesStore((s) => Object.keys(s.available).length);
}
