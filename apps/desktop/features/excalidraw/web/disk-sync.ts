import { create } from "zustand";
import { isDrawingPath } from "@/lib/paths";
import type { WorkspaceListenerContribution } from "@/lib/features/workspace-events";

// What the watcher tells the feature about drawing files (ADR 2026-11-18, point 9):
//
// - an open drawing tab or an embed registers its path while mounted (`track`); a change from outside (the
//   watcher does not report Writer's own saves) bumps its `version`, and the tab reloads and
//   merges (`lib/reconcile.ts`). Bursts (an atomic save is a delete and a create) settle on the
//   last event after a quiet period.
// - any drawing that changes from outside, open or not, schedules the automatic SVG export when
//   the setting is on. That half imports the exporter lazily, so this file stays in the startup
//   chunk without Excalidraw.

export const DISK_SYNC_DEBOUNCE_MS = 150;

export interface DiskState {
  version: number;
  deleted: boolean;
  /** Tabs and embeds showing the path: it is tracked until the last one lets go. */
  refs: number;
}

interface DiskStore {
  views: Record<string, DiskState>;
  track: (path: string) => void;
  forget: (path: string) => void;
  reload: (path: string) => void;
  markDeleted: (path: string) => void;
}

export const useDiskStore = create<DiskStore>((set) => ({
  views: {},
  track: (path) =>
    set((s) => {
      const prev = s.views[path] ?? { version: 0, deleted: false, refs: 0 };
      return { views: { ...s.views, [path]: { ...prev, refs: prev.refs + 1 } } };
    }),
  forget: (path) =>
    set((s) => {
      const prev = s.views[path];
      if (!prev) return s;
      if (prev.refs > 1) return { views: { ...s.views, [path]: { ...prev, refs: prev.refs - 1 } } };
      const { [path]: _gone, ...rest } = s.views;
      return { views: rest };
    }),
  reload: (path) =>
    set((s) => {
      const prev = s.views[path];
      return prev
        ? { views: { ...s.views, [path]: { ...prev, version: prev.version + 1, deleted: false } } }
        : s;
    }),
  markDeleted: (path) =>
    set((s) => {
      const prev = s.views[path];
      return prev ? { views: { ...s.views, [path]: { ...prev, deleted: true } } } : s;
    }),
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const diskSyncListener: WorkspaceListenerContribution = {
  id: "excalidraw.disk-sync",
  onFileChanged(kind, path) {
    if (!isDrawingPath(path)) return;
    if (kind !== "delete") {
      void import("./lib/export-svg").then((m) => m.scheduleAutoExport(path));
    }
    if (!useDiskStore.getState().views[path]) return;
    const pending = timers.get(path);
    if (pending) clearTimeout(pending);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        const store = useDiskStore.getState();
        if (kind === "delete") store.markDeleted(path);
        else store.reload(path);
      }, DISK_SYNC_DEBOUNCE_MS),
    );
  },
};
