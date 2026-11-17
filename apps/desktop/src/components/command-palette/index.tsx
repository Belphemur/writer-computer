import { useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import type { SearchResult } from "@/types/fs";
import {
  useCloseCommandPalette,
  useCommandPaletteIntent,
  useCommandPaletteSearch,
  useIsCommandPaletteOpen,
  useOpenCommandPalette,
  useSetCommandPaletteSearch,
} from "@/hooks/use-command-palette";
import { useSidebar } from "@/hooks/use-sidebar";
import { useCloseWorkspace, useIsCompactFileMode, useWorkspace } from "@/hooks/use-workspace";
import {
  useActiveFilePath,
  useActiveTabId,
  useCloseActiveTab,
  useCloseTab,
  useHasClosedTabs,
  useReopenClosedTab,
  useOpenFile,
  useOpenSettingsTab,
  useOpenTabs,
} from "@/hooks/use-tabs";
import { useTheme } from "@/hooks/use-theme";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import * as logActions from "@/lib/log-actions";
import { resetZoom, zoomIn, zoomOut } from "@/hooks/zoom-api";
import {
  useOpenPluginBrowser,
  usePluginCommands,
  usePluginLeaves,
  useTogglePluginPane,
} from "@/hooks/use-plugins";
import { ContentSearchPalette } from "./content-search-palette";
import { resolveCommands } from "./commands";
import { useFuzzySearch } from "./use-fuzzy-search";
import { useGlobalRecentFiles } from "@/hooks/use-global-recent-files";
import { openStandaloneFile } from "@/hooks/use-open-drop";
import { rankCandidates } from "@/lib/search-rank";
import { getFileName, getFileStem, getParentDir } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import type { RecentFile } from "@/lib/tauri";

function toCreatePath(root: string, rawName: string) {
  const trimmed = rawName.trim();
  const fileName = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  return `${root}/${fileName}`;
}

function matchesSearch(text: string, q: string) {
  return text.toLowerCase().includes(q.toLowerCase());
}

/**
 * Compact windows have no index: rank the global recents (file name, path and title) with the
 * shared TS scorer, boosted by when each was opened. An empty query keeps the recents order.
 */
function rankGlobalRecents(files: RecentFile[], query: string): RecentFile[] {
  const recency = (f: RecentFile) => ({ openedMs: f.opened_at > 0 ? f.opened_at * 1000 : null });
  const opts = { nowMs: Date.now(), recency: true };
  const byPath = rankCandidates(
    files.map((item) => ({ item, path: item.path, recency: recency(item) })),
    query,
    opts,
  );
  const byTitle = rankCandidates(
    files
      .filter((f) => f.title)
      .map((item) => ({ item, path: `${item.title}.md`, recency: recency(item) })),
    query,
    opts,
  );
  const best = new Map<RecentFile, number>();
  for (const { item, score } of [...byPath, ...byTitle]) {
    best.set(item, Math.max(best.get(item) ?? -Infinity, score));
  }
  return files.filter((f) => best.has(f)).sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0));
}

function HighlightedPath({ path, indices }: { path: string; indices: number[] }) {
  const set = new Set(indices);
  return (
    <span>
      {Array.from(path).map((char, i) => (
        <span key={i} className={set.has(i) ? "text-link font-semibold" : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
}

/** Two palette modes share one open state: "Search in notes" has its own dialog. */
export function CommandPalette() {
  const intent = useCommandPaletteIntent();
  return intent === "search-notes" ? <ContentSearchPalette /> : <FilePalette />;
}

function FilePalette() {
  const isOpen = useIsCommandPaletteOpen();
  const close = useCloseCommandPalette();
  const openCommandPalette = useOpenCommandPalette();
  const intent = useCommandPaletteIntent();
  const search = useCommandPaletteSearch();
  const setSearch = useSetCommandPaletteSearch();
  const { toggleSidebar } = useSidebar();
  const { root, isIndexing, openWorkspace } = useWorkspace();
  const closeWorkspace = useCloseWorkspace();
  const openFile = useOpenFile();
  const closeActiveTab = useCloseActiveTab();
  const closeTab = useCloseTab();
  const activeTabId = useActiveTabId();
  const activeFilePath = useActiveFilePath();
  const tabs = useOpenTabs();
  const hasClosedTabs = useHasClosedTabs();
  const reopenClosedTab = useReopenClosedTab();
  const { toggleTheme } = useTheme();
  const openSettingsTab = useOpenSettingsTab();
  const isCompactFileMode = useIsCompactFileMode();
  const pluginCommands = usePluginCommands();
  const pluginLeaves = usePluginLeaves();
  const togglePluginPane = useTogglePluginPane();
  const openPluginBrowser = useOpenPluginBrowser();

  const isCreateIntent = intent === "create-file";
  const trimmedSearch = search.trim();
  const fileQuery = isCreateIntent ? "" : search;
  // Standalone compact windows have no workspace index — search filters the
  // global recents list client-side instead of hitting fuzzy_search.
  const { results, error: searchError } = useFuzzySearch(
    fileQuery,
    20,
    isOpen && !isCompactFileMode && !isCreateIntent,
  );
  const { files: globalRecents } = useGlobalRecentFiles(30, isOpen && isCompactFileMode);
  // In standalone mode new files are created next to the active file.
  const createBaseDir = root ?? (activeFilePath ? getParentDir(activeFilePath) : null);
  const createPath =
    createBaseDir && trimmedSearch ? toCreatePath(createBaseDir, trimmedSearch) : null;

  function handleSelect(path: string) {
    void (isCompactFileMode ? openStandaloneFile(path) : openFile(path));
    close();
  }

  function handleCreate() {
    if (!createPath) return;

    close();
    void (async () => {
      await tauri.createFile(createPath);
      if (isCompactFileMode) {
        await openStandaloneFile(createPath);
      } else {
        await openFile(createPath);
      }
    })();
  }

  async function handleOpenWorkspace() {
    const picked = await tauri.pickWorkspace();
    if (picked) {
      // Standalone compact windows stay pure — workspaces open elsewhere.
      if (isCompactFileMode) {
        await tauri.openWorkspaceInNewWindow(picked);
      } else {
        await openWorkspace(picked);
      }
    }
    close();
  }

  // Resolved only while open: plugin availability checks run plugin code.
  const commands = !isOpen
    ? []
    : resolveCommands(
        {
          hasWorkspace: root !== null,
          isCompactFileMode,
          activeFilePath,
          hasActiveTab: activeTabId !== null,
          tabCount: tabs.length,
          hasClosedTabs,
          hasPluginLeaves: pluginLeaves.length > 0,
          close,
          toggleSidebar,
          openCreateFile: () => openCommandPalette("create-file"),
          openSearchNotes: () => openCommandPalette("search-notes"),
          openFileInCompactWindow: (path) => void tauri.openFileInStandaloneWindow(path),
          closeActiveTab,
          reopenClosedTab: () => void reopenClosedTab(),
          closeAllTabs: () => {
            for (const tab of tabs) closeTab(tab.id);
          },
          openWorkspace: handleOpenWorkspace,
          closeWorkspace,
          toggleTheme,
          zoomIn,
          zoomOut,
          resetZoom,
          openSettings: openSettingsTab,
          togglePluginPane,
          openPluginBrowser,
          openLogFolder: () => {
            logActions
              .openLogFolder()
              .catch((e) => showEditorNotice(`Could not open the log folder: ${String(e)}`));
          },
          copyRecentErrors: () => {
            logActions
              .copyRecentErrors()
              .then((n) => showEditorNotice(logActions.copyResultMessage(n)))
              .catch((e) => showEditorNotice(`Could not copy the logs: ${String(e)}`));
          },
        },
        pluginCommands,
      );

  // An empty query lists recent files (opened first, then modified) above the commands.
  const visibleFiles: SearchResult[] = !isCreateIntent && !isCompactFileMode ? results : [];
  const visibleRecents: RecentFile[] =
    !isCreateIntent && isCompactFileMode
      ? trimmedSearch
        ? rankGlobalRecents(globalRecents, trimmedSearch)
        : globalRecents
      : [];
  const visibleCommands = isCreateIntent
    ? []
    : trimmedSearch
      ? commands.filter((c) => matchesSearch(c.label, trimmedSearch))
      : commands;
  // Typed query: commands match first; empty query: recent files come first.
  const firstValue = trimmedSearch
    ? (visibleCommands[0]?.id ?? visibleFiles[0]?.path ?? visibleRecents[0]?.path ?? "")
    : (visibleFiles[0]?.path ?? visibleRecents[0]?.path ?? visibleCommands[0]?.id ?? "");

  const commandItems = visibleCommands.map((c) => (
    <CommandItem key={c.id} value={c.id} onSelect={c.run}>
      <div className="flex flex-col">
        <span>{c.label}</span>
        <span className="text-[13px] text-text-muted">{c.description}</span>
      </div>
    </CommandItem>
  ));
  const fileItems = visibleFiles.map((r) => (
    <CommandItem key={r.path} value={r.path} onSelect={() => handleSelect(r.path)}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{getFileName(r.path)}</span>
        <span className="truncate text-[13px] text-text-muted">
          <HighlightedPath path={r.relative_path} indices={r.match_indices} />
        </span>
      </div>
    </CommandItem>
  ));
  const recentItems = visibleRecents.map((entry) => (
    <CommandItem key={entry.path} value={entry.path} onSelect={() => handleSelect(entry.path)}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{entry.title || getFileStem(entry.name)}</span>
        <span className="truncate text-[13px] text-text-muted">{getParentDir(entry.path)}</span>
      </div>
    </CommandItem>
  ));

  const listRef = useRef<HTMLDivElement>(null);
  const [selectedValue, setSelectedValue] = useState(firstValue);

  // Snap selection + scroll to the first item whenever the search/intent
  // changes, or when async file results arrive and the first item shifts.
  // firstValue is a primitive, so this is stable across renders.
  // selectedValue is also set by cmdk onValueChange (keyboard nav) and this effect also scrolls the list — not pure derived state.
  /* eslint-disable react-doctor/no-derived-state */
  useEffect(() => {
    setSelectedValue(firstValue);
    listRef.current?.scrollTo({ top: 0 });
  }, [search, intent, firstValue]);
  /* eslint-enable react-doctor/no-derived-state */

  const placeholder = isCreateIntent ? "Create a new note..." : "Search...";

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label="Command Palette"
      shouldFilter={false}
      value={selectedValue}
      onValueChange={setSelectedValue}
    >
      <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
      <CommandList ref={listRef}>
        {isCreateIntent ? (
          <>
            {!trimmedSearch && <CommandEmpty>Type a note name to create it.</CommandEmpty>}
            {createPath && (
              <CommandGroup heading="Create note">
                <CommandItem value={createPath} onSelect={handleCreate}>
                  Create: {getFileName(createPath)}
                </CommandItem>
              </CommandGroup>
            )}
          </>
        ) : (
          <>
            {visibleFiles.length === 0 &&
              visibleRecents.length === 0 &&
              visibleCommands.length === 0 && (
                <CommandEmpty>
                  {searchError && trimmedSearch && !isCompactFileMode
                    ? `File search unavailable: ${searchError}`
                    : isIndexing && trimmedSearch && !isCompactFileMode
                      ? "Indexing workspace..."
                      : "No results found."}
                </CommandEmpty>
              )}

            {trimmedSearch ? (
              (visibleFiles.length > 0 ||
                visibleRecents.length > 0 ||
                visibleCommands.length > 0) && (
                <CommandGroup heading={isIndexing ? "Results (indexing...)" : "Results"}>
                  {commandItems}
                  {fileItems}
                  {recentItems}
                </CommandGroup>
              )
            ) : (
              <>
                {(visibleFiles.length > 0 || visibleRecents.length > 0) && (
                  <CommandGroup heading="Recent">
                    {fileItems}
                    {recentItems}
                  </CommandGroup>
                )}
                {visibleCommands.length > 0 && (
                  <CommandGroup heading="Suggested">{commandItems}</CommandGroup>
                )}
              </>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
