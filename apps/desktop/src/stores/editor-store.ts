import { create } from "zustand";
import type { FileContent } from "@/types/fs";
import * as tauri from "@/lib/tauri";
import { getFrontmatterDisplayDate, inferTitle, type TitleSource } from "@/lib/frontmatter";
import { parseOpenedFile } from "@/lib/open-file-parse";
import { getDocumentStats, type DocumentStats } from "@/lib/document-stats";
import { cancelSave, scheduleSave, registerSaveStore } from "@/lib/save";
import {
  locationBehavior,
  locationForPath,
  opensAsDocument,
  serializeLocation,
  deserializeLocation,
  type Location,
  type SerializedLocation,
} from "@/components/editor-area/page-kinds";

export interface OpenFile {
  path: string;
  frontmatter: string | null;
  content: string;
  title: string;
  titleSource: TitleSource;
  diskContent: string;
  isDirty: boolean;
  isLoading: boolean;
  saveError: string | null;
  reloadVersion: number;
  scrollPos: number;
  cursorPos: number;
  displayDate: string | null;
  stats: DocumentStats;
}

export interface Tab {
  id: string;
  location: Location;
  back: Location[];
  forward: Location[];
  /** Pinned tabs form the leading group of the strip (see `SPECs/pinned-tabs-spec.md`). */
  pinned?: boolean;
}

export function isTabPinned(tab: Pick<Tab, "pinned">): boolean {
  return tab.pinned === true;
}

/** How many tabs lead the strip pinned. The store keeps pinned tabs contiguous at the start. */
export function pinnedTabCount(tabs: readonly Tab[]): number {
  let n = 0;
  while (n < tabs.length && isTabPinned(tabs[n]!)) n += 1;
  return n;
}

/** Can this tab be pinned? Everything but the blank new-tab page. */
export function isTabPinnable(tab: Pick<Tab, "location">): boolean {
  return tab.location.kind !== "launcher";
}

/** A closed tab with the position it had, so reopening puts it back where it was. */
export interface ClosedTab {
  tab: Tab;
  index: number;
  /** Cursor and scroll the file had when the tab closed (the open-file entry is pruned then). */
  view: { cursorPos: number; scrollPos: number } | null;
}

/** How many closed tabs are remembered (Chrome keeps about this many per window). */
export const MAX_CLOSED_TABS = 25;

export type { Location, FileLocation } from "@/components/editor-area/page-kinds";

export interface SessionTab {
  location: SerializedLocation;
  back: SerializedLocation[];
  forward: SerializedLocation[];
  /** Omitted when false; session files written before pinned tabs have no field. */
  pinned?: boolean;
}

interface EditorState {
  openFiles: Map<string, OpenFile>;
  tabs: Tab[];
  /** Recently closed tabs, newest last, capped at `MAX_CLOSED_TABS` (the reopen stack). */
  closedTabs: ClosedTab[];
  activeTabId: string | null;
  activeFilePath: string | null;

  openFile: (path: string) => Promise<void>;
  openCompactFile: (path: string, prefetched?: FileContent | null) => Promise<void>;
  openFileInNewTab: (path: string) => Promise<void>;
  /** Open a path as plain text in a new tab even when its kind has its own view (`.base`). */
  openFileAsTextInNewTab: (path: string) => Promise<void>;
  openNewTab: () => void;
  ensureLauncherTab: () => void;
  openOrFocus: (match: (tab: Tab) => boolean, factory: () => Tab) => void;
  replaceTabWithFile: (tabId: string, path: string) => Promise<void>;
  /**
   * Shows `location` in tab `tabId`, keeping the old one in the back history (a file switching
   * between its text editor and its plugin view). A text (`file`) location loads the document.
   */
  replaceTabLocation: (tabId: string, location: Location) => Promise<void>;
  closeFile: (path: string) => void;
  /** `remember: false` skips the reopen stack (failed opens, deleted files). */
  closeTab: (tabId: string, options?: { remember?: boolean }) => void;
  /** Cmd+W and the palette's Close Current Tab: a pinned active tab is unpinned instead of closed. */
  closeActiveTab: () => void;
  /** A user close gesture (middle click, Cmd+W): a pinned tab is unpinned, an unpinned one closes. */
  closeTabByUser: (tabId: string) => void;
  /** Closes every tab but `keepTabId` and the pinned ones. */
  closeOtherTabs: (keepTabId: string) => void;
  /** Closes every tab that is not pinned. */
  closeAllTabs: () => void;
  /** Moves a tab to the end of the pinned group; no-op for the launcher or an already pinned tab. */
  pinTab: (tabId: string) => void;
  /** Moves a tab to the start of the unpinned group. */
  unpinTab: (tabId: string) => void;
  /** Moves a tab to `toIndex`, clamped to its own group (pinned and unpinned never mix). */
  moveTab: (tabId: string, toIndex: number) => void;
  /** Reopens the most recently closed tab (browser-style Cmd+Shift+T), at its old position. */
  reopenClosedTab: () => Promise<boolean>;
  setActiveFile: (path: string) => void;
  setActiveTab: (tabId: string) => void;
  navigateToFile: (path: string) => Promise<void>;
  navigateBack: () => Promise<void>;
  navigateForward: () => Promise<void>;
  renameOpenFile: (oldPath: string, newPath: string) => void;
  removePathReferences: (path: string) => void;
  removePathsWithPrefix: (prefix: string) => void;
  rewritePathPrefix: (oldPrefix: string, newPrefix: string) => void;
  restoreSession: (
    tabs: SessionTab[],
    activeIndex: number | null,
    prefetchedActiveFile?: FileContent | null,
  ) => Promise<void>;
  updateContent: (path: string, content: string) => void;
  updateFrontmatter: (path: string, frontmatter: string | null) => void;
  markSaved: (path: string, diskContent: string, hasNewerChanges?: boolean) => void;
  setSaveError: (path: string, error: string | null) => void;
  setBaseTabView: (tabId: string, view: string | undefined) => void;
  reloadFromDisk: (path: string, rawContent: string) => void;
  updateScrollPos: (path: string, pos: number) => void;
  updateCursorPos: (path: string, pos: number) => void;
}

type EditorStateSetter = (
  partial:
    | EditorState
    | Partial<EditorState>
    | ((state: EditorState) => EditorState | Partial<EditorState>),
  replace?: boolean,
) => void;

const pendingLoads = new Map<string, Promise<void>>();
const pendingNavigationVersionByTabId = new Map<string, number>();

// How long openFile waits for a fresh file to finish loading before falling
// back to creating the tab with a "Loading..." placeholder. Below ~100 ms is
// imperceptible, so fast disk reads never flash the spinner.
const OPEN_FILE_GRACE_MS = 40;

let tabSequence = 0;

function createTabId() {
  tabSequence += 1;
  return `tab-${tabSequence}`;
}

export function createLauncherTab(id = createTabId()): Tab {
  return { id, location: { kind: "launcher" }, back: [], forward: [] };
}

/** A tab for a workspace file: the location kind is decided by the page-kind registry
 *  (`locationForPath`), so a `.base` opens as a table and everything else as a document. */
export function createFileTab(path: string, id = createTabId()): Tab {
  return { id, location: locationForPath(path), back: [], forward: [] };
}

export function createSettingsTab(id = createTabId()): Tab {
  return { id, location: { kind: "settings" }, back: [], forward: [] };
}

export function createPluginViewTab(
  target: { leafId: string; title: string },
  id = createTabId(),
): Tab {
  return { id, location: { kind: "plugin-view", ...target }, back: [], forward: [] };
}

/** A tab for a file a plugin's view shows (a plugin-created leaf adopted as a tab). */
export function createPluginFileTab(
  target: { path: string; viewType: string },
  id = createTabId(),
): Tab {
  return { id, location: { kind: "plugin-file", ...target }, back: [], forward: [] };
}

const EMPTY_STATS: DocumentStats = { words: 0, characters: 0, paragraphs: 0 };

/** A copy of `files` with a loading entry for `path`, or `undefined` when none is needed:
 *  already present, or the path is not a text document (a `.base` is rendered by its own kind). */
function withLoadingEntry(
  files: Map<string, OpenFile>,
  path: string,
  asText = false,
): Map<string, OpenFile> | undefined {
  if (files.has(path) || !(asText || opensAsDocument(path))) return undefined;
  return new Map(files).set(path, createLoadingFile(path));
}

function createLoadingFile(path: string): OpenFile {
  return {
    path,
    frontmatter: null,
    content: "",
    title: "",
    titleSource: "none",
    diskContent: "",
    isDirty: false,
    isLoading: true,
    saveError: null,
    reloadVersion: 0,
    scrollPos: 0,
    cursorPos: 0,
    displayDate: null,
    stats: EMPTY_STATS,
  };
}

function withDerivedDate<T extends { frontmatter: string | null }>(file: T) {
  return { ...file, displayDate: getFrontmatterDisplayDate(file.frontmatter) };
}

// Word/character/paragraph counts are display-only (status bar) and cost a
// full-document pass, so edits refresh them on a trailing timer instead of
// synchronously on every keystroke. Loads and reloads still derive them
// eagerly via `withDerived`.
const STATS_REFRESH_MS = 150;
const statsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleStatsRefresh(path: string, set: EditorStateSetter) {
  const pending = statsRefreshTimers.get(path);
  if (pending) clearTimeout(pending);
  statsRefreshTimers.set(
    path,
    setTimeout(() => {
      statsRefreshTimers.delete(path);
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const stats = getDocumentStats(file.content);
        const files = new Map(state.openFiles);
        files.set(path, { ...file, stats });
        return { openFiles: files };
      });
    }, STATS_REFRESH_MS),
  );
}

function withDerived<T extends { frontmatter: string | null; content: string }>(file: T) {
  return {
    ...file,
    displayDate: getFrontmatterDisplayDate(file.frontmatter),
    stats: getDocumentStats(file.content),
  };
}

function cloneTab(tab: Tab): Tab {
  return { ...tab, back: [...tab.back], forward: [...tab.forward] };
}

function locationPaths(location: Location): string[] {
  return locationBehavior(location).paths(location);
}

function locationPrimaryPath(location: Location): string | null {
  return locationBehavior(location).primaryPath(location);
}

function deriveActiveFilePath(tabs: Tab[], activeTabId: string | null): string | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return activeTab ? locationPrimaryPath(activeTab.location) : null;
}

function getTabIndex(tabs: Tab[], tabId: string) {
  return tabs.findIndex((tab) => tab.id === tabId);
}

/** Where a reopened tab goes: its old index, kept inside its own group (pinned or not). */
function reopenIndex(tabs: readonly Tab[], tab: Tab, index: number): number {
  const pinned = pinnedTabCount(tabs);
  return isTabPinned(tab)
    ? Math.min(index, pinned)
    : Math.min(Math.max(index, pinned), tabs.length);
}

function getActiveTab(state: Pick<EditorState, "tabs" | "activeTabId">) {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

/** The pinned tab that already shows `path` the way opening it would (same page kind), if any. */
function findPinnedTabFor(tabs: readonly Tab[], path: string): Tab | undefined {
  const kind = locationForPath(path).kind;
  return tabs.find(
    (tab) =>
      isTabPinned(tab) && tab.location.kind === kind && locationPrimaryPath(tab.location) === path,
  );
}

/** Focuses the pinned tab that shows `path` (opening a file never duplicates it). */
function focusPinnedTabFor(state: EditorState, path: string): boolean {
  const pinned = findPinnedTabFor(state.tabs, path);
  if (!pinned) return false;
  if (pinned.id !== state.activeTabId) state.setActiveTab(pinned.id);
  return true;
}

function collectReferencedPaths(tabs: Tab[]) {
  const paths = new Set<string>();
  for (const tab of tabs) {
    for (const p of locationPaths(tab.location)) paths.add(p);
    for (const loc of tab.back) for (const p of locationPaths(loc)) paths.add(p);
    for (const loc of tab.forward) for (const p of locationPaths(loc)) paths.add(p);
  }
  return paths;
}

function maybePruneFiles(
  state: Pick<EditorState, "openFiles" | "tabs">,
  nextTabs: Tab[],
  candidatePaths: string[],
) {
  const referenced = collectReferencedPaths(nextTabs);
  let files: Map<string, OpenFile> | null = null;

  for (const path of candidatePaths) {
    if (referenced.has(path)) continue;
    const file = (files ?? state.openFiles).get(path);
    if (!file || file.isDirty) continue;
    cancelSave(path);
    if (!files) files = new Map(state.openFiles);
    files.delete(path);
  }

  return files;
}

function tabPaths(tab: Tab): string[] {
  const paths = new Set<string>();
  for (const p of locationPaths(tab.location)) paths.add(p);
  for (const loc of tab.back) for (const p of locationPaths(loc)) paths.add(p);
  for (const loc of tab.forward) for (const p of locationPaths(loc)) paths.add(p);
  return [...paths];
}

function startNavigation(tabId: string) {
  const nextVersion = (pendingNavigationVersionByTabId.get(tabId) ?? 0) + 1;
  pendingNavigationVersionByTabId.set(tabId, nextVersion);
  return nextVersion;
}

function isNavigationCurrent(tabId: string, version: number) {
  return pendingNavigationVersionByTabId.get(tabId) === version;
}

function rewriteLocation(location: Location, from: string, to: string): Location | null {
  return locationBehavior(location).rewritePath(location as never, from, to) as Location | null;
}

function removeFromLocation(location: Location, path: string): Location | null {
  return locationBehavior(location).removePath(location as never, path) as Location | null;
}

function applyRewriteToTab(tab: Tab, rewrite: (loc: Location) => Location | null): Tab | null {
  const newLocation = rewrite(tab.location);
  if (!newLocation) return null;
  const back = tab.back.map(rewrite).filter((l): l is Location => l !== null);
  const forward = tab.forward.map(rewrite).filter((l): l is Location => l !== null);
  return { ...tab, location: newLocation, back, forward };
}

/** Follows a rename or delete into the reopen stack; an entry whose tab is gone is dropped. */
function rewriteClosedTabs(
  closedTabs: ClosedTab[],
  rewrite: (loc: Location) => Location | null,
): ClosedTab[] {
  return closedTabs.flatMap((entry) => {
    const tab = applyRewriteToTab(entry.tab, rewrite);
    return tab ? [{ ...entry, tab }] : [];
  });
}

/** Is `path` a document: opened as text by default, or held by a `file` location of some tab
 *  (a `.base` opened with "Edit YAML" is a text document in that tab). */
function needsDocument(path: string, tabs: readonly Tab[]): boolean {
  if (opensAsDocument(path)) return true;
  return tabs.some((tab) =>
    [tab.location, ...tab.back, ...tab.forward].some((l) => l.kind === "file" && l.path === path),
  );
}

async function ensureFileLoaded(
  path: string,
  set: EditorStateSetter,
  get: () => EditorState,
  /** Tabs about to be added, so a path only they hold as text (a `.base` as YAML) still loads. */
  pendingTabs: readonly Tab[] = [],
) {
  if (!needsDocument(path, [...get().tabs, ...pendingTabs])) return;
  const existing = get().openFiles.get(path);
  if (existing && !existing.isLoading) return;

  const pending = pendingLoads.get(path);
  if (pending) {
    await pending;
    return;
  }

  if (!existing) {
    set((state) => {
      if (state.openFiles.has(path)) return state;
      const files = new Map(state.openFiles);
      files.set(path, createLoadingFile(path));
      return { openFiles: files };
    });
  }

  const loadPromise = tauri
    .readFile(path)
    .then((raw) => {
      const parsed = parseOpenedFile(path, raw.content);
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const files = new Map(state.openFiles);
        files.set(
          path,
          withDerived({
            ...file,
            path,
            frontmatter: parsed.frontmatter,
            content: parsed.body ?? "",
            title: parsed.title,
            titleSource: parsed.titleSource,
            diskContent: raw.content,
            isLoading: false,
          }),
        );
        return { openFiles: files };
      });
    })
    .catch((error) => {
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const files = new Map(state.openFiles);
        files.delete(path);
        return { openFiles: files };
      });
      throw error;
    })
    .finally(() => {
      pendingLoads.delete(path);
    });

  pendingLoads.set(path, loadPromise);
  await loadPromise;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  openFiles: new Map(),
  tabs: [],
  closedTabs: [],
  activeTabId: null,
  activeFilePath: null,

  openFile: async (path: string) => {
    const state = get();
    if (focusPinnedTabFor(state, path)) return;
    const activeTab = getActiveTab(state);

    if (activeTab?.location.kind === "launcher") {
      await state.replaceTabWithFile(activeTab.id, path);
      return;
    }

    // Reuse the active file (or base) tab by navigating in-place.
    if (activeTab && locationPrimaryPath(activeTab.location) !== null) {
      await state.navigateToFile(path);
      return;
    }

    // No tabs at all — create one.
    const loadPromise = ensureFileLoaded(path, set as EditorStateSetter, get);
    loadPromise.catch(() => {});

    const loadFailedBeforeGrace = await Promise.race([
      loadPromise.then(
        () => false,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), OPEN_FILE_GRACE_MS)),
    ]);
    if (loadFailedBeforeGrace) return;

    const nextTab = createFileTab(path);
    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
      activeFilePath: path,
    }));

    try {
      await loadPromise;
    } catch {
      get().closeTab(nextTab.id, { remember: false });
    }
  },

  openCompactFile: async (path: string, prefetched: FileContent | null = null) => {
    // Seed the prefetched content (standalone startup hands the file over
    // in the startup IPC) so the editor mounts loaded; `ensureFileLoaded`
    // then short-circuits on the non-loading entry.
    if (prefetched && prefetched.path === path) {
      const parsed = parseOpenedFile(path, prefetched.content);
      set((state) => {
        const files = new Map(state.openFiles);
        files.set(
          path,
          withDerived({
            ...createLoadingFile(path),
            frontmatter: parsed.frontmatter,
            content: parsed.body ?? "",
            title: parsed.title,
            titleSource: parsed.titleSource,
            diskContent: prefetched.content,
            isLoading: false,
          }),
        );
        return { openFiles: files };
      });
    }

    const previousTabIds = get().tabs.map((tab) => tab.id);
    const loadPromise = ensureFileLoaded(path, set as EditorStateSetter, get);
    loadPromise.catch(() => {});

    const nextTab = createFileTab(path);
    set((state) => {
      const candidatePaths = [
        ...new Set(state.tabs.flatMap((tab) => tabPaths(tab).filter((p) => p !== path))),
      ];
      const filesWithTarget = state.openFiles.has(path)
        ? null
        : new Map(state.openFiles).set(path, createLoadingFile(path));
      const baseState = filesWithTarget ? { ...state, openFiles: filesWithTarget } : state;
      const tabs = [nextTab];
      const prunedFiles = maybePruneFiles(baseState, tabs, candidatePaths);
      return {
        tabs,
        activeTabId: nextTab.id,
        activeFilePath: path,
        ...(prunedFiles
          ? { openFiles: prunedFiles }
          : filesWithTarget
            ? { openFiles: filesWithTarget }
            : {}),
      };
    });

    for (const tabId of previousTabIds) {
      pendingNavigationVersionByTabId.delete(tabId);
    }

    try {
      await loadPromise;
    } catch {
      get().closeTab(nextTab.id, { remember: false });
    }
  },

  // Always create a fresh tab for `path`, even if another tab already shows it.
  // Used by the sidebar context menu's "Open in new tab" action so it never
  // collapses into the existing tab the way `openFile` does.
  openFileInNewTab: async (path: string) => {
    const nextTab = createFileTab(path);

    set((state) => {
      const openFiles = withLoadingEntry(state.openFiles, path);
      return {
        tabs: [...state.tabs, nextTab],
        activeTabId: nextTab.id,
        activeFilePath: path,
        ...(openFiles ? { openFiles } : {}),
      };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      get().closeTab(nextTab.id, { remember: false });
      throw new Error(`Failed to open ${path}`);
    }
  },

  openFileAsTextInNewTab: async (path: string) => {
    const existing = get().tabs.find(
      (tab) => tab.location.kind === "file" && tab.location.path === path,
    );
    if (existing) {
      get().setActiveTab(existing.id);
      return;
    }
    const nextTab: Tab = {
      id: createTabId(),
      location: { kind: "file", path },
      back: [],
      forward: [],
    };
    set((state) => {
      const openFiles = withLoadingEntry(state.openFiles, path, true);
      return {
        tabs: [...state.tabs, nextTab],
        activeTabId: nextTab.id,
        activeFilePath: path,
        ...(openFiles ? { openFiles } : {}),
      };
    });
    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      get().closeTab(nextTab.id, { remember: false });
      throw new Error(`Failed to open ${path}`);
    }
  },

  openNewTab: () => {
    const nextTab = createLauncherTab();
    set((state) => ({
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
      activeFilePath: null,
    }));
  },

  ensureLauncherTab: () => {
    set((state) => {
      if (state.tabs.length > 0) return state;
      const launcherTab = createLauncherTab();
      return {
        tabs: [launcherTab],
        activeTabId: launcherTab.id,
        activeFilePath: null,
      };
    });
  },

  openOrFocus: (match, factory) => {
    const state = get();
    const existing = state.tabs.find(match);
    if (existing) {
      if (existing.id !== state.activeTabId) {
        state.setActiveTab(existing.id);
      }
      return;
    }
    const activeTab = getActiveTab(state);
    const nextTab = factory();
    set((currentState) => {
      if (activeTab?.location.kind === "launcher") {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index !== -1) {
          const tabs = [...currentState.tabs];
          tabs[index] = { ...nextTab, id: activeTab.id };
          return {
            tabs,
            activeTabId: activeTab.id,
            activeFilePath: deriveActiveFilePath(tabs, activeTab.id),
          };
        }
      }
      return {
        tabs: [...currentState.tabs, nextTab],
        activeTabId: nextTab.id,
        activeFilePath: deriveActiveFilePath([...currentState.tabs, nextTab], nextTab.id),
      };
    });
  },

  replaceTabWithFile: async (tabId: string, path: string) => {
    const targetTab = get().tabs.find((tab) => tab.id === tabId);
    if (!targetTab || targetTab.location.kind !== "launcher") {
      await get().openFile(path);
      return;
    }

    const nextTab = createFileTab(path, tabId);
    const version = startNavigation(tabId);

    set((state) => {
      const index = getTabIndex(state.tabs, tabId);
      if (index === -1) return state;
      if (state.tabs[index]?.location.kind !== "launcher") return state;
      const tabs = [...state.tabs];
      tabs[index] = nextTab;
      const openFiles = withLoadingEntry(state.openFiles, path);
      return {
        tabs,
        activeFilePath: state.activeTabId === tabId ? path : state.activeFilePath,
        ...(openFiles ? { openFiles } : {}),
      };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(tabId, version)) return;

      set((state) => {
        const index = getTabIndex(state.tabs, tabId);
        if (index === -1) {
          const files = maybePruneFiles(state, state.tabs, [path]);
          return files ? { openFiles: files } : state;
        }

        const currentTab = state.tabs[index];
        const currentLocation = currentTab?.location;
        if (!currentLocation || locationPrimaryPath(currentLocation) !== path) {
          const files = maybePruneFiles(state, state.tabs, [path]);
          return files ? { openFiles: files } : state;
        }

        const tabs = [...state.tabs];
        tabs[index] = targetTab;
        const files = maybePruneFiles(state, tabs, [path]);

        return {
          tabs,
          activeFilePath: state.activeTabId === tabId ? null : state.activeFilePath,
          ...(files ? { openFiles: files } : {}),
        };
      });
    }
  },

  closeFile: (path: string) => {
    const { activeTabId, tabs } = get();
    const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null;
    if (activeTab && locationPrimaryPath(activeTab.location) === path) {
      get().closeTab(activeTab.id, { remember: false });
      return;
    }

    const targetTab = tabs.find((tab) => locationPrimaryPath(tab.location) === path);
    if (targetTab) get().closeTab(targetTab.id, { remember: false });
  },

  closeTab: (tabId: string, options?: { remember?: boolean }) => {
    set((state) => {
      const index = getTabIndex(state.tabs, tabId);
      if (index === -1) return state;

      const closedTab = state.tabs[index]!;
      // Blank launcher tabs are not worth reopening (browsers skip empty new-tab pages too).
      // A plugin view holds a live leaf that dies with the tab: nothing to reopen.
      const remember =
        options?.remember !== false &&
        closedTab.location.kind !== "launcher" &&
        closedTab.location.kind !== "plugin-view";
      const primary = locationPrimaryPath(closedTab.location);
      const openFile = primary ? state.openFiles.get(primary) : undefined;
      const closedTabs = remember
        ? [
            ...state.closedTabs,
            {
              tab: closedTab,
              index,
              view: openFile
                ? { cursorPos: openFile.cursorPos, scrollPos: openFile.scrollPos }
                : null,
            },
          ].slice(-MAX_CLOSED_TABS)
        : state.closedTabs;
      let tabs = state.tabs.filter((tab) => tab.id !== tabId);

      let activeTabId = state.activeTabId;
      if (tabs.length === 0) {
        const launcherTab = createLauncherTab();
        tabs = [launcherTab];
        activeTabId = launcherTab.id;
      } else if (state.activeTabId === tabId) {
        activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
      }

      const files = maybePruneFiles(state, tabs, tabPaths(closedTab));

      return {
        tabs,
        closedTabs,
        activeTabId,
        activeFilePath: deriveActiveFilePath(tabs, activeTabId),
        ...(files ? { openFiles: files } : {}),
      };
    });

    pendingNavigationVersionByTabId.delete(tabId);
  },

  reopenClosedTab: async () => {
    // Newest first; an entry whose file is gone is dropped and the next older one is tried.
    for (;;) {
      const stack = get().closedTabs;
      const entry = stack[stack.length - 1];
      if (!entry) return false;
      set({ closedTabs: stack.slice(0, -1) });

      const primary = locationPrimaryPath(entry.tab.location);
      const wasOpen = primary !== null && get().openFiles.has(primary);
      if (primary !== null) {
        try {
          await ensureFileLoaded(primary, set as EditorStateSetter, get, [entry.tab]);
        } catch {
          continue;
        }
      }

      const reopened: Tab = { ...entry.tab, id: createTabId() };
      set((state) => {
        // A lone blank launcher tab is replaced rather than left next to the reopened tab.
        const onlyLauncher = state.tabs.length === 1 && state.tabs[0]!.location.kind === "launcher";
        const tabs = onlyLauncher ? [] : [...state.tabs];
        tabs.splice(reopenIndex(tabs, reopened, entry.index), 0, reopened);
        // Cursor and scroll come back unless another tab kept the file open meanwhile.
        const file = primary !== null && !wasOpen ? state.openFiles.get(primary) : undefined;
        let openFiles: Map<string, OpenFile> | undefined;
        if (file && entry.view) {
          openFiles = new Map(state.openFiles);
          openFiles.set(primary!, { ...file, ...entry.view });
        }
        return {
          ...(openFiles ? { openFiles } : {}),
          tabs,
          activeTabId: reopened.id,
          activeFilePath: deriveActiveFilePath(tabs, reopened.id),
        };
      });
      return true;
    }
  },

  closeActiveTab: () => {
    const activeTabId = get().activeTabId;
    if (activeTabId) get().closeTabByUser(activeTabId);
  },

  closeTabByUser: (tabId: string) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (isTabPinned(tab)) get().unpinTab(tabId);
    else get().closeTab(tabId);
  },

  closeOtherTabs: (keepTabId: string) => {
    const { tabs, activeTabId } = get();
    const ids = tabs
      .filter((tab) => tab.id !== keepTabId && !isTabPinned(tab))
      .map((tab) => tab.id);
    // Land on the tab the user asked to keep, not on whichever neighbour survives the closes.
    if (activeTabId !== null && ids.includes(activeTabId)) get().setActiveTab(keepTabId);
    for (const id of ids) get().closeTab(id);
  },

  closeAllTabs: () => {
    const ids = get()
      .tabs.filter((tab) => !isTabPinned(tab))
      .map((tab) => tab.id);
    for (const id of ids) get().closeTab(id);
  },

  pinTab: (tabId: string) => {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab || isTabPinned(tab) || !isTabPinnable(tab)) return state;
      const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
      tabs.splice(pinnedTabCount(tabs), 0, { ...tab, pinned: true });
      return { tabs };
    });
  },

  unpinTab: (tabId: string) => {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab || !isTabPinned(tab)) return state;
      const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
      tabs.splice(pinnedTabCount(tabs), 0, { ...tab, pinned: false });
      return { tabs };
    });
  },

  moveTab: (tabId: string, toIndex: number) => {
    set((state) => {
      const from = getTabIndex(state.tabs, tabId);
      if (from === -1) return state;
      const tab = state.tabs[from]!;
      const pinned = pinnedTabCount(state.tabs);
      const [min, max] = isTabPinned(tab) ? [0, pinned - 1] : [pinned, state.tabs.length - 1];
      const to = Math.min(Math.max(toIndex, min), max);
      if (to === from) return state;
      const tabs = [...state.tabs];
      tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return { tabs };
    });
  },

  setActiveFile: (path: string) => {
    const tab = get().tabs.find((candidate) => locationPrimaryPath(candidate.location) === path);
    if (!tab) return;
    set({ activeTabId: tab.id, activeFilePath: path });
  },

  setActiveTab: (tabId: string) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId, activeFilePath: deriveActiveFilePath(get().tabs, tabId) });
  },

  navigateToFile: async (path: string) => {
    const state = get();
    if (focusPinnedTabFor(state, path)) return;
    const activeTab = getActiveTab(state);
    if (!activeTab) {
      await state.openFile(path);
      return;
    }
    if (activeTab.location.kind === "launcher") {
      await state.replaceTabWithFile(activeTab.id, path);
      return;
    }
    // A plugin view holds a live leaf (e.g. a chat); navigating over it would destroy it.
    if (activeTab.location.kind === "plugin-view") {
      await state.openFileInNewTab(path);
      return;
    }
    // A pinned tab keeps its page: another file opens next to it, like a browser's pinned tab.
    if (activeTab.pinned) {
      await state.openFileInNewTab(path);
      return;
    }
    if (locationPrimaryPath(activeTab.location) === path) return;

    const previousTab = cloneTab(activeTab);
    const nextLocation = locationForPath(path);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: nextLocation,
      back: [...activeTab.back, activeTab.location],
      forward: [],
    };

    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      const openFiles = withLoadingEntry(currentState.openFiles, path);
      return {
        tabs,
        activeFilePath:
          currentState.activeTabId === activeTab.id ? path : currentState.activeFilePath,
        ...(openFiles ? { openFiles } : {}),
      };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [path]);
        return {
          tabs,
          activeFilePath:
            currentState.activeTabId === activeTab.id
              ? locationPrimaryPath(previousTab.location)
              : currentState.activeFilePath,
          ...(files ? { openFiles: files } : {}),
        };
      });
    }
  },

  replaceTabLocation: async (tabId: string, location: Location) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const path = locationPrimaryPath(location);
    const previousTab = cloneTab(tab);
    const nextTab: Tab = {
      ...cloneTab(tab),
      location,
      back: [...tab.back, tab.location],
      forward: [],
    };
    const version = startNavigation(tabId);
    set((state) => {
      const index = getTabIndex(state.tabs, tabId);
      if (index === -1) return state;
      const tabs = [...state.tabs];
      tabs[index] = nextTab;
      const openFiles =
        path && location.kind === "file" ? withLoadingEntry(state.openFiles, path, true) : null;
      return {
        tabs,
        activeFilePath: state.activeTabId === tabId ? path : state.activeFilePath,
        ...(openFiles ? { openFiles } : {}),
      };
    });
    if (!path || location.kind !== "file") return;
    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(tabId, version)) return;
      set((state) => {
        const index = getTabIndex(state.tabs, tabId);
        if (index === -1) return state;
        const tabs = [...state.tabs];
        tabs[index] = previousTab;
        return {
          tabs,
          activeFilePath:
            state.activeTabId === tabId
              ? locationPrimaryPath(previousTab.location)
              : state.activeFilePath,
        };
      });
    }
  },

  navigateBack: async () => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab || activeTab.back.length === 0) return;

    const targetLocation = activeTab.back[activeTab.back.length - 1]!;
    const previousTab = cloneTab(activeTab);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: targetLocation,
      back: activeTab.back.slice(0, -1),
      forward: [activeTab.location, ...activeTab.forward],
    };
    const targetPath = locationPrimaryPath(targetLocation);
    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      return {
        tabs,
        activeFilePath:
          currentState.activeTabId === activeTab.id ? targetPath : currentState.activeFilePath,
      };
    });

    if (!targetPath) return;

    try {
      await ensureFileLoaded(targetPath, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [targetPath]);
        return {
          tabs,
          activeFilePath:
            currentState.activeTabId === activeTab.id
              ? locationPrimaryPath(previousTab.location)
              : currentState.activeFilePath,
          ...(files ? { openFiles: files } : {}),
        };
      });
    }
  },

  navigateForward: async () => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab || activeTab.forward.length === 0) return;

    const [targetLocation, ...remainingForward] = activeTab.forward;
    const previousTab = cloneTab(activeTab);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: targetLocation!,
      back: [...activeTab.back, activeTab.location],
      forward: remainingForward,
    };
    const targetPath = locationPrimaryPath(targetLocation!);
    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      return {
        tabs,
        activeFilePath:
          currentState.activeTabId === activeTab.id ? targetPath : currentState.activeFilePath,
      };
    });

    if (!targetPath) return;

    try {
      await ensureFileLoaded(targetPath, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [targetPath]);
        return {
          tabs,
          activeFilePath:
            currentState.activeTabId === activeTab.id
              ? locationPrimaryPath(previousTab.location)
              : currentState.activeFilePath,
          ...(files ? { openFiles: files } : {}),
        };
      });
    }
  },

  renameOpenFile: (oldPath: string, newPath: string) => {
    let shouldScheduleSave = false;

    set((state) => {
      const file = state.openFiles.get(oldPath);
      // A tab can reference a path with no loaded document (a `.base`): still re-point it.
      if (
        !file &&
        !state.tabs.some((tab) => tabPaths(tab).includes(oldPath)) &&
        !state.closedTabs.some((entry) => tabPaths(entry.tab).includes(oldPath))
      )
        return state;

      shouldScheduleSave = file?.isDirty ?? false;

      const files = new Map(state.openFiles);
      if (file) {
        files.delete(oldPath);
        files.set(newPath, { ...file, path: newPath });
      }

      const rewrite = (loc: Location) => rewriteLocation(loc, oldPath, newPath);
      const tabs = state.tabs.map((tab) => applyRewriteToTab(tab, rewrite) ?? tab);

      return {
        openFiles: files,
        tabs,
        closedTabs: rewriteClosedTabs(state.closedTabs, rewrite),
        activeFilePath: state.activeFilePath === oldPath ? newPath : state.activeFilePath,
      };
    });

    cancelSave(oldPath);
    if (shouldScheduleSave) scheduleSave(newPath);
  },

  // Drop every reference to `path` from editor state. Used after a delete so
  // tabs, history, openFiles, and pending saves are all cleaned up explicitly
  // instead of relying on the file watcher to fix things up later.
  removePathReferences: (path: string) => {
    set((state) => {
      const transform = (loc: Location) => removeFromLocation(loc, path);
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      let activeTabId = state.activeTabId;
      if (!tabs.some((tab) => tab.id === activeTabId)) {
        activeTabId = tabs[0]?.id ?? null;
      }

      const files = state.openFiles.has(path) ? new Map(state.openFiles) : null;
      files?.delete(path);

      return {
        tabs,
        closedTabs: rewriteClosedTabs(state.closedTabs, transform),
        activeTabId,
        activeFilePath: deriveActiveFilePath(tabs, activeTabId),
        ...(files ? { openFiles: files } : {}),
      };
    });

    cancelSave(path);

    if (get().tabs.length === 0) {
      get().ensureLauncherTab();
    }
  },

  // Drop every reference to paths starting with `prefix` from editor state.
  // Used after deleting a folder to clean up all contained files.
  removePathsWithPrefix: (prefix: string) => {
    const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const matches = (p: string) => p === prefix || p.startsWith(dirPrefix);

    const cancelledPaths: string[] = [];

    set((state) => {
      const transform = (loc: Location): Location | null => {
        for (const p of locationPaths(loc)) {
          if (matches(p)) {
            return removeFromLocation(loc, p);
          }
        }
        return loc;
      };
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      let activeTabId = state.activeTabId;
      if (!tabs.some((tab) => tab.id === activeTabId)) {
        activeTabId = tabs[0]?.id ?? null;
      }

      const files = new Map(state.openFiles);
      for (const path of files.keys()) {
        if (matches(path)) {
          cancelledPaths.push(path);
          files.delete(path);
        }
      }

      return {
        tabs,
        closedTabs: rewriteClosedTabs(state.closedTabs, transform),
        activeTabId,
        activeFilePath: deriveActiveFilePath(tabs, activeTabId),
        openFiles: files,
      };
    });

    for (const path of cancelledPaths) {
      cancelSave(path);
    }

    if (get().tabs.length === 0) {
      get().ensureLauncherTab();
    }
  },

  // Rewrite a path prefix across all tabs, histories, and openFiles.
  // Used after renaming a folder to update all contained file references.
  rewritePathPrefix: (oldPrefix: string, newPrefix: string) => {
    const dirPrefix = oldPrefix.endsWith("/") ? oldPrefix : `${oldPrefix}/`;
    const rewritePath = (p: string) => {
      if (p === oldPrefix) return newPrefix;
      if (p.startsWith(dirPrefix)) return newPrefix + p.slice(oldPrefix.length);
      return p;
    };

    const reschedulePaths: string[] = [];

    set((state) => {
      const transform = (loc: Location): Location | null => {
        let next: Location = loc;
        for (const p of locationPaths(loc)) {
          const rewritten = rewritePath(p);
          if (rewritten !== p) {
            const applied = rewriteLocation(next, p, rewritten);
            if (!applied) return null;
            next = applied;
          }
        }
        return next;
      };
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      const files = new Map<string, OpenFile>();
      for (const [path, file] of state.openFiles) {
        const newPath = rewritePath(path);
        if (newPath !== path) {
          files.set(newPath, { ...file, path: newPath });
          if (file.isDirty) reschedulePaths.push(newPath);
          cancelSave(path);
        } else {
          files.set(path, file);
        }
      }

      return {
        tabs,
        closedTabs: rewriteClosedTabs(state.closedTabs, transform),
        openFiles: files,
        activeFilePath: state.activeFilePath ? rewritePath(state.activeFilePath) : null,
      };
    });

    for (const path of reschedulePaths) {
      scheduleSave(path);
    }
  },

  restoreSession: async (
    tabs: SessionTab[],
    activeIndex: number | null,
    prefetchedActiveFile: FileContent | null = null,
  ) => {
    const restoredTabs: Tab[] = [];
    const sessionOrder: Tab[] = [];
    for (const sessionTab of tabs) {
      const location = deserializeLocation(sessionTab.location);
      if (!location) continue;
      const back = sessionTab.back
        .map((l) => deserializeLocation(l))
        .filter((l): l is Location => l !== null);
      const forward = sessionTab.forward
        .map((l) => deserializeLocation(l))
        .filter((l): l is Location => l !== null);
      const tab: Tab = { id: createTabId(), location, back, forward };
      if (sessionTab.pinned === true && isTabPinnable(tab)) tab.pinned = true;
      sessionOrder.push(tab);
    }
    // The active index points into the saved order; pinned tabs then move to the front (a stable
    // partition, so a file written by hand or by a future client still gets a contiguous group).
    const savedActiveTab = sessionOrder[activeIndex ?? 0] ?? sessionOrder[0] ?? null;
    restoredTabs.push(
      ...sessionOrder.filter((tab) => isTabPinned(tab)),
      ...sessionOrder.filter((tab) => !isTabPinned(tab)),
    );

    if (restoredTabs.length === 0) {
      set({
        openFiles: new Map(),
        tabs: [],
        activeTabId: null,
        activeFilePath: null,
      });
      get().ensureLauncherTab();
      return;
    }

    const uniquePaths = [
      ...new Set(
        restoredTabs.flatMap((tab) => [
          ...locationPaths(tab.location),
          ...tab.back.flatMap((l) => locationPaths(l)),
          ...tab.forward.flatMap((l) => locationPaths(l)),
        ]),
      ),
    ];
    const activeTab = savedActiveTab;
    const activePath = activeTab ? locationPrimaryPath(activeTab.location) : null;

    // If the bundled `restore_workspace` IPC pre-fetched the active file, seed
    // it directly so the editor can mount with content already in place — no
    // round-trip back to Rust for the most-visible tab.
    const seededActive =
      prefetchedActiveFile && activePath && prefetchedActiveFile.path === activePath
        ? (() => {
            const parsed = parseOpenedFile(activePath, prefetchedActiveFile.content);
            return withDerived({
              ...createLoadingFile(activePath),
              path: activePath,
              frontmatter: parsed.frontmatter,
              content: parsed.body ?? "",
              title: parsed.title,
              titleSource: parsed.titleSource,
              diskContent: prefetchedActiveFile.content,
              isLoading: false,
            });
          })()
        : null;

    set((state) => {
      const files = new Map(state.openFiles);
      for (const path of uniquePaths) {
        if (!files.has(path) && needsDocument(path, restoredTabs))
          files.set(path, createLoadingFile(path));
      }
      if (seededActive && activePath) {
        files.set(activePath, seededActive);
      }

      return {
        openFiles: files,
        tabs: restoredTabs,
        closedTabs: [],
        activeTabId: activeTab?.id ?? null,
        activeFilePath: activePath,
      };
    });

    // Skip the active path if we already seeded it from the prefetch — the
    // remaining background tabs still get loaded in parallel.
    const pathsToLoad = seededActive
      ? uniquePaths.filter((path) => path !== activePath)
      : uniquePaths;

    const results = await Promise.allSettled(
      pathsToLoad.map((path) => ensureFileLoaded(path, set as EditorStateSetter, get)),
    );
    const failedPaths = new Set(
      pathsToLoad.filter((_, index) => results[index]?.status === "rejected"),
    );

    if (failedPaths.size === 0) return;

    let shouldEnsureLauncher = false;
    set((state) => {
      const transform = (loc: Location): Location | null => {
        for (const p of locationPaths(loc)) {
          if (failedPaths.has(p)) return null;
        }
        return loc;
      };
      const nextTabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);
      const files = new Map(state.openFiles);
      for (const path of failedPaths) files.delete(path);

      const activeTabId = nextTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : (nextTabs[0]?.id ?? null);
      shouldEnsureLauncher = nextTabs.length === 0;

      return {
        openFiles: files,
        tabs: nextTabs,
        activeTabId,
        activeFilePath: deriveActiveFilePath(nextTabs, activeTabId),
      };
    });

    if (shouldEnsureLauncher) get().ensureLauncherTab();
  },

  updateContent: (path: string, content: string) => {
    const file = get().openFiles.get(path);
    if (!file) return;

    set((state) => {
      const existing = state.openFiles.get(path);
      if (!existing) return state;
      if (existing.content === content && existing.isDirty) return state;

      // The title comes from the frontmatter only, so a body edit never changes it.
      const files = new Map(state.openFiles);
      files.set(path, {
        ...existing,
        content,
        isDirty: true,
      });
      return { openFiles: files };
    });

    scheduleStatsRefresh(path, set as EditorStateSetter);
    scheduleSave(path);
  },

  updateFrontmatter: (path: string, frontmatter: string | null) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.frontmatter === frontmatter) return state;

      const { title, titleSource } = inferTitle(frontmatter);
      const files = new Map(state.openFiles);
      files.set(
        path,
        withDerivedDate({
          ...file,
          frontmatter,
          title,
          titleSource,
          isDirty: true,
        }),
      );
      return { openFiles: files };
    });

    scheduleSave(path);
  },

  markSaved: (path: string, diskContent: string, hasNewerChanges = false) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file) return state;

      const files = new Map(state.openFiles);
      files.set(path, {
        ...file,
        diskContent,
        isDirty: hasNewerChanges,
        saveError: null,
      });
      return { openFiles: files };
    });
  },

  setSaveError: (path: string, error: string | null) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.saveError === error) return state;

      const files = new Map(state.openFiles);
      files.set(path, { ...file, saveError: error });
      return { openFiles: files };
    });
  },

  setBaseTabView: (tabId: string, view: string | undefined) => {
    set((state) => {
      const index = getTabIndex(state.tabs, tabId);
      const tab = state.tabs[index];
      if (!tab || tab.location.kind !== "base" || tab.location.view === view) return state;
      const location: Location = { kind: "base", path: tab.location.path };
      if (view !== undefined) location.view = view;
      const tabs = [...state.tabs];
      tabs[index] = { ...tab, location };
      return { tabs };
    });
  },

  reloadFromDisk: (path: string, rawContent: string) => {
    cancelSave(path);
    const parsed = parseOpenedFile(path, rawContent);
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file) return state;

      const files = new Map(state.openFiles);
      files.set(
        path,
        withDerived({
          ...file,
          frontmatter: parsed.frontmatter,
          content: parsed.body ?? "",
          title: parsed.title,
          titleSource: parsed.titleSource,
          diskContent: rawContent,
          isDirty: false,
          reloadVersion: file.reloadVersion + 1,
        }),
      );
      return { openFiles: files };
    });
  },

  updateScrollPos: (path: string, pos: number) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.scrollPos === pos) return state;

      const files = new Map(state.openFiles);
      files.set(path, { ...file, scrollPos: pos });
      return { openFiles: files };
    });
  },

  updateCursorPos: (path: string, pos: number) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.cursorPos === pos) return state;

      const files = new Map(state.openFiles);
      files.set(path, { ...file, cursorPos: pos });
      return { openFiles: files };
    });
  },
}));

// Wire the save engine to this store. The save module lives in `lib/` and must
// not import `stores/`, so it reads/writes the store through this injected
// accessor instead (see `registerSaveStore`).
registerSaveStore({
  getOpenFile: (path) => useEditorStore.getState().openFiles.get(path),
  markSaved: (path, diskContent, hasNewerChanges) =>
    useEditorStore.getState().markSaved(path, diskContent, hasNewerChanges),
  setSaveError: (path, error) => useEditorStore.getState().setSaveError(path, error),
});

export function getEditorSessionSnapshot(state: Pick<EditorState, "tabs" | "activeTabId">) {
  const tabs: SessionTab[] = [];
  let activeIndex: number | null = null;
  state.tabs.forEach((tab) => {
    const location = serializeLocation(tab.location);
    if (!location) return;
    const back = tab.back
      .map((l) => serializeLocation(l))
      .filter((l): l is SerializedLocation => l !== null);
    const forward = tab.forward
      .map((l) => serializeLocation(l))
      .filter((l): l is SerializedLocation => l !== null);
    const index = tabs.length;
    tabs.push({ location, back, forward, ...(isTabPinned(tab) ? { pinned: true } : {}) });
    if (state.activeTabId && tab.id === state.activeTabId) {
      activeIndex = index;
    }
  });
  return { tabs, activeIndex };
}
