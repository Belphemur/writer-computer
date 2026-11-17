import { useEffect, useRef } from "react";
import { useBooleanSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";
import { useEditorStore } from "@/stores/editor-store";

export const AUTO_REVEAL_DEBOUNCE_MS = 150;
/** How long after the last pointer/wheel event inside the sidebar we stay out of the way. */
export const AUTO_REVEAL_POINTER_PAUSE_MS = 800;
const RETRY_MS = 250;
const MAX_RETRIES = 40;

interface Options {
  /** Path of the row being renamed, if any. */
  renamingPath: string | null;
  /** The Everything section is folded: nothing to reveal into. */
  everythingCollapsed: boolean;
}

/** Whether the tree can show this path: under the root and not in a hidden (dot) folder. */
export function isRevealablePath(root: string | null, path: string | null): path is string {
  if (!root || !path || !path.startsWith(`${root}/`)) return false;
  return !path
    .slice(root.length + 1)
    .split("/")
    .some((segment) => segment.startsWith("."));
}

/**
 * Setting `sidebar.auto-reveal-active-file`: when the active file changes,
 * reveal it in the Everything tree through `revealPathInSidebar` (expand
 * ancestors, scroll only if off-screen). Never focuses anything, only
 * expands folders, waits out rename, drag and pointer use in the sidebar, and
 * does nothing while the sidebar or the Everything section is collapsed
 * (it reveals when they open).
 */
export function useAutoRevealActiveFile({ renamingPath, everythingCollapsed }: Options): void {
  const enabled = useBooleanSetting("sidebar.auto-reveal-active-file", true);
  const sidebarVisible = useBooleanSetting("appearance.sidebar-visible", true);
  const root = useWorkspaceRoot();
  const activeFilePath = useEditorStore((s) => s.activeFilePath);
  const renamingRef = useRef(renamingPath);
  renamingRef.current = renamingPath;
  const lastPointerRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (!enabled) return;
    const mark = (event: Event) => {
      if ((event.target as Element | null)?.closest?.("[data-sidebar-surface]")) {
        lastPointerRef.current = Date.now();
      }
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("pointerup", mark, true);
    document.addEventListener("wheel", mark, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("pointerup", mark, true);
      document.removeEventListener("wheel", mark, true);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !sidebarVisible || everythingCollapsed) return;
    if (!isRevealablePath(root, activeFilePath)) return;
    const path = activeFilePath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const busy = () =>
      renamingRef.current !== null ||
      document.body.classList.contains("tree-dragging") ||
      Date.now() - lastPointerRef.current < AUTO_REVEAL_POINTER_PAUSE_MS;

    const run = () => {
      if (busy() && retries++ < MAX_RETRIES) {
        timer = setTimeout(run, RETRY_MS);
        return;
      }
      if (busy()) return;
      void revealPathInSidebar(path, { center: true });
    };
    timer = setTimeout(run, AUTO_REVEAL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, sidebarVisible, everythingCollapsed, root, activeFilePath]);
}
