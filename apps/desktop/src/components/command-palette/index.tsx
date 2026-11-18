import { useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import { keyIntent, linkHandlers, openPath, type LinkIntent } from "@/lib/link-activation";
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
  useActiveTabPinState,
  useCloseAllTabs,
  usePinTab,
  useUnpinTab,
  useUnpinnedTabCount,
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
import { ContentSearchPalette } from "./content-search-palette";
import { resolveCommands, setCommandContextProvider, type CommandContext } from "./commands";
import { useFuzzySearch } from "./use-fuzzy-search";
import { useGlobalRecentFiles } from "@/hooks/use-global-recent-files";
import { openStandaloneFile } from "@/hooks/use-open-drop";
import { rankCandidates } from "@/lib/search-rank";
import { noteLabel } from "@/lib/note-title";
import { NoteResultTitle } from "./note-result-title";
import { getFileName, getParentDir } from "@/lib/paths";
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
  return rankCandidates(
    files.map((item) => ({
      item,
      path: item.path,
      title: item.title,
      recency: recency(item),
    })),
    query,
    { nowMs: Date.now(), recency: true },
  ).map(({ item }) => item);
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
  const closeAllTabs = useCloseAllTabs();
  const pinTab = usePinTab();
  const unpinTab = useUnpinTab();
  const activeTabPin = useActiveTabPinState();
  const unpinnedTabCount = useUnpinnedTabCount();
  const activeTabId = useActiveTabId();
  const activeFilePath = useActiveFilePath();
  const tabs = useOpenTabs();
  const hasClosedTabs = useHasClosedTabs();
  const reopenClosedTab = useReopenClosedTab();
  const { toggleTheme } = useTheme();
  const openSettingsTab = useOpenSettingsTab();
  const isCompactFileMode = useIsCompactFileMode();

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

  function handleSelect(path: string, how: LinkIntent = "current") {
    void (isCompactFileMode
      ? openStandaloneFile(path)
      : how === "current"
        ? openFile(path)
        : openPath(path, how));
    close();
  }

  // A result row is a note link: middle click opens it in a background tab (not in compact mode,
  // which has one file); Cmd/Ctrl+Enter is handled on the dialog.
  const rowLink = (path: string) =>
    isCompactFileMode
      ? {}
      : linkHandlers(
          { kind: "custom", open: (how) => handleSelect(path, how) },
          { middleOnly: true },
        );
  function onResultKeyDown(e: React.KeyboardEvent) {
    const how = keyIntent(e);
    if (!how || how === "current") return;
    const path = [...visibleFiles, ...visibleRecents].find((r) => r.path === selectedValue)?.path;
    if (!path) return;
    e.preventDefault();
    handleSelect(path, how);
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

  // What a command may read or do. Built when the palette resolves its list, and handed to
  // `runCommand` so a key bound to a command runs it the same way.
  const buildContext = (): CommandContext => ({
    hasWorkspace: root !== null,
    isCompactFileMode,
    activeFilePath,
    hasActiveTab: activeTabId !== null,
    tabCount: tabs.length,
    unpinnedTabCount,
    activeTabPin,
    hasClosedTabs,
    close,
    toggleSidebar,
    openCreateFile: () => openCommandPalette("create-file"),
    openSearchNotes: () => openCommandPalette("search-notes"),
    openFileInCompactWindow: (path) => void tauri.openFileInStandaloneWindow(path),
    pinActiveTab: () => {
      if (activeTabId) pinTab(activeTabId);
    },
    unpinActiveTab: () => {
      if (activeTabId) unpinTab(activeTabId);
    },
    closeActiveTab,
    reopenClosedTab: () => void reopenClosedTab(),
    closeAllTabs,
    openWorkspace: handleOpenWorkspace,
    closeWorkspace,
    toggleTheme,
    zoomIn,
    zoomOut,
    resetZoom,
    openSettings: openSettingsTab,
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
  });
  useEffect(() => {
    setCommandContextProvider(buildContext);
    return () => setCommandContextProvider(null);
  });

  // Resolved only while open: plugin availability checks run plugin code.
  const commands = !isOpen ? [] : resolveCommands(buildContext());

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
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-col">
          <span>{c.label}</span>
          <span className="text-[13px] text-text-muted">{c.description}</span>
        </div>
        {c.shortcut && (
          <kbd className="ml-auto shrink-0 text-[11px] tracking-[0.1em] text-text-muted">
            {c.shortcut}
          </kbd>
        )}
      </div>
    </CommandItem>
  ));
  const fileItems = visibleFiles.map((r) => (
    <CommandItem
      key={r.path}
      value={r.path}
      onSelect={() => handleSelect(r.path)}
      {...rowLink(r.path)}
    >
      <div className="flex min-w-0 flex-col">
        {/* An override leads (italic); the path below then carries the file name. */}
        <NoteResultTitle path={r.path} name={getFileName(r.path)} override={r.title} />
        <span className="truncate text-[13px] text-text-muted">
          <HighlightedPath path={r.relative_path} indices={r.match_indices} />
        </span>
      </div>
    </CommandItem>
  ));
  const recentItems = visibleRecents.map((entry) => (
    <CommandItem
      key={entry.path}
      value={entry.path}
      onSelect={() => handleSelect(entry.path)}
      {...rowLink(entry.path)}
    >
      <div className="flex min-w-0 flex-col">
        <NoteResultTitle
          path={entry.path}
          name={noteLabel(entry.path, null).text}
          override={entry.title}
        />
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
      onKeyDown={onResultKeyDown}
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
