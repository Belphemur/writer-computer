import { create } from "zustand";
import type { WorkspaceListenerContribution } from "@/lib/features/workspace-events";

// Keeps an open image in step with the file on disk. The viewer registers its path while mounted
// (`track`), the workspace listener below feeds watcher events in, and the viewer reads `version`
// (the cache key of the asset URL) and `deleted`. Paths with no open viewer are ignored. Watcher
// events for one path arrive in bursts (an editor's atomic save is a delete plus a create), so the
// last event after a quiet period decides. In-app renames and moves are followed by the page
// kind's `rewritePath`, not here.

export const DISK_SYNC_DEBOUNCE_MS = 150;

export interface DiskState {
  version: number;
  deleted: boolean;
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
    set((s) =>
      s.views[path] ? s : { views: { ...s.views, [path]: { version: 0, deleted: false } } },
    ),
  forget: (path) =>
    set((s) => {
      const { [path]: _gone, ...rest } = s.views;
      return { views: rest };
    }),
  reload: (path) =>
    set((s) => {
      const prev = s.views[path];
      return prev
        ? { views: { ...s.views, [path]: { version: prev.version + 1, deleted: false } } }
        : s;
    }),
  markDeleted: (path) =>
    set((s) => {
      const prev = s.views[path];
      return prev ? { views: { ...s.views, [path]: { ...prev, deleted: true } } } : s;
    }),
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The asset URL's cache key: version 0 is the plain URL. */
export const withVersion = (src: string, version: number): string =>
  version > 0 ? `${src}?v=${version}` : src;

export const diskSyncListener: WorkspaceListenerContribution = {
  id: "images.disk-sync",
  onFileChanged(kind, path) {
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
