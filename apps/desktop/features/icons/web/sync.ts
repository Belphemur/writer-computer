// Keeps core's icon store (`lib/file-icons.ts`) equal to what Rust resolves: loaded when the
// feature starts and when the workspace changes, reloaded after every write and when the backend
// reports a change on disk (the CLI, Obsidian with Iconize). One writer of the store; the newest
// request wins, so a slow answer never replaces a newer one.
import { create } from "zustand";
import { clearFileIcons, setFileIcons } from "@/lib/file-icons";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { iconsResolved } from "./ipc";

interface IconizeState {
  /** Iconize icons from packs Writer does not show (Settings). */
  unsupported: number;
}

export const useIconizeStatus = create<IconizeState>(() => ({ unsupported: 0 }));

let latest = 0;

/** Fetch the icons of the open workspace into the store (cleared without one). */
export async function syncIcons(): Promise<void> {
  const mine = ++latest;
  if (useWorkspaceStore.getState().root === null) {
    clearFileIcons();
    useIconizeStatus.setState({ unsupported: 0 });
    return;
  }
  try {
    const r = await iconsResolved();
    if (mine !== latest) return;
    setFileIcons(r.icons);
    useIconizeStatus.setState({ unsupported: r.iconizeUnsupported });
  } catch {
    // Fail visibly in the log (never the error text: it can carry a path), keep the icons as they
    // were: a missing icon is not worth a dialog.
    logger.warn("icons", "could not load the icons");
  }
}

/** Start following the workspace; returns the stop function (it also clears the icons). */
export function startIconSync(): () => void {
  void syncIcons();
  let root = useWorkspaceStore.getState().root;
  let generation = useWorkspaceStore.getState().workspaceGeneration;
  const unsubscribe = useWorkspaceStore.subscribe((s) => {
    if (s.root === root && s.workspaceGeneration === generation) return;
    root = s.root;
    generation = s.workspaceGeneration;
    void syncIcons();
  });
  return () => {
    unsubscribe();
    latest++;
    clearFileIcons();
    useIconizeStatus.setState({ unsupported: 0 });
  };
}
