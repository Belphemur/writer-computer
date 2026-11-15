import {
  createPluginSettingsTab,
  createPluginViewTab,
  createSettingsTab,
  useEditorStore,
} from "@/stores/editor-store";
export type { OpenFile, Tab, SessionTab } from "@/stores/editor-store";

export function getOpenFile(path: string) {
  return useEditorStore.getState().openFiles.get(path) ?? null;
}

export function getOpenFiles() {
  return useEditorStore.getState().openFiles;
}

export function getActiveFilePath() {
  return useEditorStore.getState().activeFilePath;
}

export function closeFile(path: string) {
  useEditorStore.getState().closeFile(path);
}

export function closeActiveTab() {
  useEditorStore.getState().closeActiveTab();
}

export function markSaved(path: string, diskContent: string) {
  useEditorStore.getState().markSaved(path, diskContent);
}

export function updateContent(path: string, content: string) {
  useEditorStore.getState().updateContent(path, content);
}

export function updateCursorPos(path: string, pos: number) {
  useEditorStore.getState().updateCursorPos(path, pos);
}

export function updateScrollPos(path: string, pos: number) {
  useEditorStore.getState().updateScrollPos(path, pos);
}

export function updateFrontmatter(path: string, frontmatter: string | null) {
  useEditorStore.getState().updateFrontmatter(path, frontmatter);
}

export function reloadFromDisk(path: string, rawContent: string) {
  useEditorStore.getState().reloadFromDisk(path, rawContent);
}

export function navigateToFile(path: string) {
  return useEditorStore.getState().navigateToFile(path);
}

/** Persist the selected view of a base tab in its location (restored with the session). */
export function setBaseTabView(tabId: string, view: string | undefined) {
  useEditorStore.getState().setBaseTabView(tabId, view);
}

export function renameOpenFile(oldPath: string, newPath: string) {
  useEditorStore.getState().renameOpenFile(oldPath, newPath);
}

export function openFileInNewTab(path: string) {
  return useEditorStore.getState().openFileInNewTab(path);
}

/** Open a path as plain text in a new tab even when its kind has its own view (`.base` "Edit YAML"). */
export function openFileAsTextInNewTab(path: string) {
  return useEditorStore.getState().openFileAsTextInNewTab(path);
}

export function removePathReferences(path: string) {
  useEditorStore.getState().removePathReferences(path);
}

export function removePathsWithPrefix(prefix: string) {
  useEditorStore.getState().removePathsWithPrefix(prefix);
}

export function rewritePathPrefix(oldPrefix: string, newPrefix: string) {
  useEditorStore.getState().rewritePathPrefix(oldPrefix, newPrefix);
}

/** Opens (or focuses, if already open) the Settings page. */
export function openSettings() {
  useEditorStore
    .getState()
    .openOrFocus((tab) => tab.location.kind === "settings", createSettingsTab);
}

/** Opens (or focuses) a community plugin's options tab. One tab per plugin setting tab. */
export function openPluginSettings(target: {
  pluginId: string;
  pluginName: string;
  tabId?: string;
}) {
  useEditorStore.getState().openOrFocus(
    (tab) =>
      tab.location.kind === "plugin-settings" &&
      tab.location.pluginId === target.pluginId &&
      tab.location.tabId === target.tabId,
    () => createPluginSettingsTab(target),
  );
}

/** Opens (or focuses) the editor tab that shows a plugin leaf's view (an Obsidian main-area leaf). */
export function openPluginViewTab(target: { leafId: string; title: string }) {
  useEditorStore.getState().openOrFocus(
    (tab) => tab.location.kind === "plugin-view" && tab.location.leafId === target.leafId,
    () => createPluginViewTab(target),
  );
}

/** Re-titles the plugin view tab of `leafId` (the view's display text changed). */
export function updatePluginViewTab(leafId: string, title: string) {
  useEditorStore.setState((state) => {
    let changed = false;
    const tabs = state.tabs.map((tab) => {
      if (
        tab.location.kind !== "plugin-view" ||
        tab.location.leafId !== leafId ||
        tab.location.title === title
      )
        return tab;
      changed = true;
      return { ...tab, location: { ...tab.location, title } };
    });
    return changed ? { tabs } : state;
  });
}

/** Closes the plugin view tab of `leafId`, if open. */
export function closePluginViewTab(leafId: string) {
  const state = useEditorStore.getState();
  const tab = state.tabs.find(
    (t) => t.location.kind === "plugin-view" && t.location.leafId === leafId,
  );
  if (tab) state.closeTab(tab.id);
}

/** The leaf ids that currently have an editor tab, and the id behind the active tab (or null). */
export function getPluginViewTabLeafIds(): { open: string[]; active: string | null } {
  const { tabs, activeTabId } = useEditorStore.getState();
  const open: string[] = [];
  let active: string | null = null;
  for (const tab of tabs) {
    if (tab.location.kind !== "plugin-view") continue;
    open.push(tab.location.leafId);
    if (tab.id === activeTabId) active = tab.location.leafId;
  }
  return { open, active };
}
