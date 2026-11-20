import { useCallback, useRef, useTransition, type MouseEvent, type PointerEvent } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { HugeiconsIcon } from "@hugeicons/react";
import { PinIcon } from "@hugeicons/core-free-icons";
import {
  useActiveTabId,
  useCanNavigateBack,
  useCanNavigateForward,
  useCloseAllTabs,
  useCloseOtherTabs,
  useCloseTabByUser,
  useMoveTab,
  usePinTab,
  useUnpinTab,
  isTabPinnable,
  isTabPinned,
  useFileSaveError,
  useIsFileLoading,
  useNavigateBack,
  useNavigateForward,
  useOpenNewTab,
  useOpenTabs,
  useResolvedDocumentTitle,
  useSetActiveTab,
  type Tab,
} from "@/hooks/use-tabs";
import { ScrollFade } from "@/components/scroll-fade";
import { useScrollActiveTabIntoView } from "@/hooks/use-scroll-active-tab-into-view";
import { getParentDir, getRelativePath } from "@/lib/paths";
import { useHoverTooltip } from "@/components/hover-tooltip";
import { pageKind } from "./page-kinds";
import { buildTabMenuItemsSpec, showTabContextMenu } from "./editor-context-menu";
import { noteLabel } from "@/lib/note-title";
import { useFileIcon } from "@/lib/file-icons";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import { isMarkdownPath, openNoteTitleDialog } from "@/stores/note-title-dialog-store";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";
import { useTabDrag } from "./use-tab-drag";

interface EditorTabButtonProps {
  tab: Tab;
  isActive: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, tab: Tab) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>, tab: Tab) => void;
  /** Swallows the click that ends a drag. */
  shouldIgnoreClick?: () => boolean;
}

function EditorTabButton({
  tab,
  isActive,
  onSelect,
  onClose,
  onContextMenu,
  onPointerDown,
  shouldIgnoreClick,
}: EditorTabButtonProps) {
  const kind = pageKind(tab.location);
  const filePath = kind.primaryPath(tab.location);
  const isLoading = useIsFileLoading(filePath ?? "");
  const saveError = useFileSaveError(filePath);
  const documentTitle = useResolvedDocumentTitle(filePath);
  // The file name unless the note sets a frontmatter `title` (an override, marked in the strip).
  const label = filePath ? noteLabel(filePath, documentTitle) : null;
  const titleOverride = label?.isOverride ? label : null;
  const title = titleOverride ? titleOverride.text : kind.title(tab.location);
  const pinned = isTabPinned(tab);
  const fileIcon = useFileIcon(filePath);
  const workspaceRoot = useWorkspaceRoot();
  const labelRef = useRef<HTMLSpanElement>(null);
  // The vault-relative folder tells two same-named notes apart; nothing at the root.
  const folder = filePath && workspaceRoot ? vaultFolder(filePath, workspaceRoot) : undefined;
  const alert = saveError ? `Save failed: ${saveError}` : undefined;
  const { triggerProps, tooltip } = useHoverTooltip({
    labelRef,
    content: {
      title,
      detail: [folder, titleOverride?.tooltip].filter(Boolean).join("\n") || undefined,
      alert,
    },
    always: pinned || !!alert,
  });

  return (
    // tab row wraps a native <button> close control; HTML forbids nested buttons so it cannot become a <button>.
    <div
      // eslint-disable-next-line react-doctor/prefer-tag-over-role
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!shouldIgnoreClick?.()) onSelect(tab.id);
      }}
      {...triggerProps}
      onPointerDown={(event) => {
        triggerProps.onPointerDown();
        onPointerDown?.(event, tab);
      }}
      aria-label={pinned ? `${title}, pinned` : undefined}
      // Middle-click closes the tab (as in browsers) and unpins a pinned one (the close rule is
      // the store's `closeTabByUser`); preventDefault stops middle-button autoscroll.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(tab.id);
      }}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onContextMenu(event, tab);
      }}
      className={` group relative flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-[8px] text-[13px] leading-[1.15] select-none cursor-default h-[var(--chrome-control-height)] ${
        pinned ? "max-w-[132px] gap-1.5 px-2.5" : "max-w-[180px] px-3.5"
      } ${
        isActive
          ? "bg-[var(--tab-active-bg)] text-[var(--text-secondary)] backdrop-blur-2xl"
          : "bg-transparent text-[var(--text-muted)] hover:bg-[var(--tab-active-bg)] hover:text-[var(--text-secondary)] hover:backdrop-blur-2xl"
      }`}
    >
      {saveError ? (
        <span
          aria-label={`Save failed: ${saveError}`}
          className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff5f57]"
        />
      ) : null}
      {pinned ? (
        <HugeiconsIcon
          icon={PinIcon}
          size={12}
          strokeWidth={2}
          color="currentColor"
          aria-hidden="true"
          data-pin-glyph
          className={`shrink-0 ${isActive ? "text-[var(--text-secondary)]" : "text-[var(--text-icon-muted)]"}`}
        />
      ) : null}
      {kind.icon ? (
        <HugeiconsIcon
          icon={kind.icon}
          size={13}
          strokeWidth={2}
          color="currentColor"
          aria-hidden="true"
          data-tab-icon={kind.kind}
          className={`shrink-0 ${pinned ? "" : "mr-1.5"} ${isActive ? "text-[var(--text-secondary)]" : "text-[var(--text-icon-muted)]"}`}
        />
      ) : null}
      {fileIcon ? (
        <IconGlyph
          value={fileIcon.icon}
          color={fileIcon.color}
          size={13}
          className={pinned ? "" : "mr-1.5"}
        />
      ) : null}
      <span
        ref={labelRef}
        className={`truncate ${pinned ? "" : "group-hover:[mask-image:linear-gradient(to_right,black,black_calc(100%_-_28px),transparent)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black,black_calc(100%_-_32px),transparent_calc(100%_-_8px))]"} ${isLoading ? "animate-pulse opacity-60" : ""} ${titleOverride ? "italic" : ""}`}
      >
        {title}
      </span>
      {pinned ? null : (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex translate-x-full items-center justify-end pr-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
          style={{ width: 40 }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
            className="pointer-events-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-[var(--text-icon-muted)] hover:text-[var(--text-secondary)]"
            aria-label={`Close ${title}`}
          >
            ×
          </button>
        </div>
      )}
      {tooltip}
    </div>
  );
}

/** The folder of `filePath` relative to the vault, `undefined` at the root or outside it. */
function vaultFolder(filePath: string, root: string): string | undefined {
  const relative = getRelativePath(filePath, root);
  if (relative.startsWith("/")) return undefined;
  const dir = getParentDir(relative);
  return dir === "/" || dir === "" || dir === "." ? undefined : dir;
}

export function EditorTabs() {
  const tabs = useOpenTabs();
  const activeTabId = useActiveTabId();
  const setActiveTab = useSetActiveTab();
  const closeTabByUser = useCloseTabByUser();
  const closeOtherTabs = useCloseOtherTabs();
  const closeAllTabs = useCloseAllTabs();
  const pinTab = usePinTab();
  const unpinTab = useUnpinTab();
  const moveTab = useMoveTab();
  const { onPointerDown, consumeDragClick } = useTabDrag(moveTab);
  const canNavigateBack = useCanNavigateBack();
  const canNavigateForward = useCanNavigateForward();
  const navigateBack = useNavigateBack();
  const navigateForward = useNavigateForward();
  const openNewTab = useOpenNewTab();
  const workspaceRoot = useWorkspaceRoot();
  const [, startTransition] = useTransition();
  useScrollActiveTabIntoView();
  // The store keeps the pinned group as the prefix, so a filter keeps the order.
  const pinnedTabs = tabs.filter(isTabPinned);
  const unpinnedTabs = tabs.filter((tab) => !isTabPinned(tab));

  const handleTabContextMenu = useCallback(
    (_event: MouseEvent<HTMLElement>, tab: Tab) => {
      const kind = pageKind(tab.location);
      const pinned = isTabPinned(tab);
      const filePath = kind.supportsFileContextMenu ? kind.primaryPath(tab.location) : null;
      const relative =
        filePath && workspaceRoot ? getRelativePath(filePath, workspaceRoot) : filePath;

      void showTabContextMenu(
        buildTabMenuItemsSpec(
          {
            onTogglePin: () => (pinned ? unpinTab(tab.id) : pinTab(tab.id)),
            onClose: () => closeTabByUser(tab.id),
            onCloseOthers: () => closeOtherTabs(tab.id),
            onCloseAll: closeAllTabs,
            ...(filePath && isMarkdownPath(filePath)
              ? { onSetDisplayTitle: () => openNoteTitleDialog(filePath) }
              : {}),
            ...(filePath && relative
              ? {
                  onRevealInSidebar: () => {
                    setActiveTab(tab.id);
                    void revealPathInSidebar(filePath, { showSidebar: true });
                  },
                  onCopyPath: () => {
                    void writeText(relative);
                  },
                }
              : {}),
          },
          {
            pinned,
            pinnable: isTabPinnable(tab),
            closeOthersEnabled: tabs.some((t) => t.id !== tab.id && !isTabPinned(t)),
            closeAllEnabled: tabs.some((t) => !isTabPinned(t)),
          },
        ),
        filePath,
      );
    },
    [
      tabs,
      closeTabByUser,
      closeOtherTabs,
      closeAllTabs,
      pinTab,
      unpinTab,
      setActiveTab,
      workspaceRoot,
    ],
  );

  const handleTabPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>, tab: Tab) => onPointerDown(event, tab.id, isTabPinned(tab)),
    [onPointerDown],
  );

  const renderTab = (tab: Tab) => (
    <div
      key={tab.id}
      data-tab-id={tab.id}
      data-tab-pinned={isTabPinned(tab)}
      className="flex items-center"
    >
      <EditorTabButton
        tab={tab}
        isActive={tab.id === activeTabId}
        onSelect={(tabId) => startTransition(() => setActiveTab(tabId))}
        onClose={closeTabByUser}
        onContextMenu={handleTabContextMenu}
        onPointerDown={handleTabPointerDown}
        shouldIgnoreClick={consumeDragClick}
      />
    </div>
  );

  return (
    <div
      data-tauri-drag-region
      className="group/tabs flex min-w-0 items-center gap-3"
      style={{
        height: "var(--chrome-bar-height)",
        paddingBlock: "var(--chrome-control-padding)",
      }}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void navigateBack()}
          disabled={!canNavigateBack}
          className="flex h-[var(--chrome-control-height)] w-7 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors enabled:hover:bg-[var(--surface-subtle)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30"
          title="Back"
          aria-label="Back"
        >
          ←
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void navigateForward()}
          disabled={!canNavigateForward}
          className="flex h-[var(--chrome-control-height)] w-7 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors enabled:hover:bg-[var(--surface-subtle)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30"
          title="Forward"
          aria-label="Forward"
        >
          →
        </button>
      </div>

      <div
        data-tauri-drag-region
        data-tab-strip
        className="relative flex min-w-0 flex-1 items-center"
      >
        {/* Two parts so the pinned group is fixed: it never scrolls, only the unpinned tabs do
            (SPECs/pinned-tabs-spec.md "Fixed pinned group"). */}
        {pinnedTabs.length > 0 ? (
          <>
            <div
              data-tauri-drag-region
              data-pinned-group
              className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 overflow-x-auto scrollbar-none"
            >
              {pinnedTabs.map(renderTab)}
            </div>
            {unpinnedTabs.length > 0 ? (
              <div
                aria-hidden="true"
                data-pinned-divider
                className="mx-1 h-4 w-px shrink-0 bg-[var(--line-subtle)]"
              />
            ) : null}
          </>
        ) : null}
        <ScrollFade
          axis="horizontal"
          data-tab-scroll
          data-tauri-drag-region
          className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
        >
          <div data-tauri-drag-region className="flex min-w-max items-center gap-1">
            {unpinnedTabs.map(renderTab)}
          </div>
        </ScrollFade>
        <button
          type="button"
          onClick={openNewTab}
          className="ml-1 flex h-[var(--chrome-control-height)] w-9 shrink-0 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--text-secondary)]"
          title="New tab"
          aria-label="New tab"
        >
          +
        </button>
      </div>
    </div>
  );
}
