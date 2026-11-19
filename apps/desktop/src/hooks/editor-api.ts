import { useUIStore } from "@/stores/ui-store";
import {
  createGraphTab,
  createPluginFileTab,
  createPluginViewTab,
  createSessionChangesTab,
  createSettingsTab,
  createTasksTab,
  useEditorStore,
} from "@/stores/editor-store";
import type { GraphLocation, Location } from "@/components/editor-area/page-kinds";
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
  // Programmatic (error recovery): closes even a pinned tab, unlike the user's Cmd+W.
  const { activeTabId, closeTab } = useEditorStore.getState();
  if (activeTabId) closeTab(activeTabId);
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

/** Opens (or focuses) the global graph tab; with `center` the tab is centered on that note
 *  (vault-relative path) and a graph tab already open is re-centered on it. */
export function openGraphTab(target: { center?: string; depth?: number } = {}) {
  const store = useEditorStore.getState();
  const existing = store.tabs.find((t) => t.location.kind === "graph");
  if (existing && target.center !== undefined) {
    store.setGraphTabState(existing.id, { center: target.center, depth: target.depth });
  }
  store.openOrFocus(
    (tab) => tab.location.kind === "graph",
    () => createGraphTab(target),
  );
}

/** Opens (or focuses) the Tasks page. */
export function openTasksTab() {
  useEditorStore.getState().openOrFocus((tab) => tab.location.kind === "tasks", createTasksTab);
}

/** Opens (or focuses) the Session changes tab of a chat, scrolled to `focus` (a vault-relative
 *  path). One tab per chat: a second "Diff" re-targets it. */
export function openSessionChangesTab(target: { chatId: string; focus?: string }) {
  const matches = (tab: { location: Location }) =>
    tab.location.kind === "session-changes" && tab.location.chatId === target.chatId;
  const store = useEditorStore.getState();
  if (store.tabs.some(matches)) {
    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        matches(tab) ? { ...tab, location: { kind: "session-changes", ...target } } : tab,
      ),
    }));
  }
  store.openOrFocus(matches, () => createSessionChangesTab(target));
}

/** Persist a graph tab's camera and pins in its location (restored with the session). */
export function setGraphTabState(tabId: string, state: Partial<Omit<GraphLocation, "kind">>) {
  useEditorStore.getState().setGraphTabState(tabId, state);
}

export function renameOpenFile(oldPath: string, newPath: string) {
  useEditorStore.getState().renameOpenFile(oldPath, newPath);
}

export function openFileInNewTab(path: string, options?: { activate?: boolean }) {
  return useEditorStore.getState().openFileInNewTab(path, options);
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

/** Opens (or focuses, if already open) the Settings page, optionally at a section id (see
 *  `settings-sections.ts`; a plugin's options are `pluginSectionId(owner, tabId)`). */
export function openSettings(sectionId?: string) {
  if (sectionId) useUIStore.getState().selectSettingsSection(sectionId);
  useEditorStore
    .getState()
    .openOrFocus((tab) => tab.location.kind === "settings", createSettingsTab);
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

/** Closes the tab with this id (the view behind it closed itself). */
export function closeTab(tabId: string) {
  useEditorStore.getState().closeTab(tabId, { remember: false });
}

/** The tab with this id, if open. */
export function getTabLocation(tabId: string) {
  return useEditorStore.getState().tabs.find((tab) => tab.id === tabId)?.location ?? null;
}

/** Shows the file of a plugin-file tab as text, or a file as its plugin view, in the same tab. */
export function replaceTabLocation(tabId: string, location: Location) {
  return useEditorStore.getState().replaceTabLocation(tabId, location);
}

/** Opens a new tab for a file view a plugin created in its own leaf; returns the tab's id. */
export function openPluginFileTab(target: { path: string; viewType: string }): string | null {
  useEditorStore.getState().openOrFocus(
    () => false,
    () => createPluginFileTab(target),
  );
  return useEditorStore.getState().activeTabId;
}
