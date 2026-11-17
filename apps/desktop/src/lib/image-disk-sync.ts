import { useImageViewerStore } from "@/stores/image-viewer-store";

/** Watcher events for one path arrive in bursts (an editor's atomic save is a delete plus a create). */
export const IMAGE_SYNC_DEBOUNCE_MS = 150;

type WatcherKind = "modified" | "created" | "deleted" | "renamed";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Called by the one watcher subscription (`hooks/use-file-watcher.ts`) for every file event.
 * Paths with no open image viewer are ignored. After a quiet period the last event decides: a
 * delete shows the deleted state, anything else reloads the image with a new cache key (the viewer
 * keeps zoom when the pixel size is unchanged). In-app renames and moves are followed by the page
 * kind's `rewritePath`, not here.
 */
export function syncImageFromDisk(path: string, kind: WatcherKind): void {
  if (!useImageViewerStore.getState().views[path]) return;
  const pending = timers.get(path);
  if (pending) clearTimeout(pending);
  timers.set(
    path,
    setTimeout(() => {
      timers.delete(path);
      const store = useImageViewerStore.getState();
      if (kind === "deleted") store.markDeleted(path);
      else store.reload(path);
    }, IMAGE_SYNC_DEBOUNCE_MS),
  );
}
