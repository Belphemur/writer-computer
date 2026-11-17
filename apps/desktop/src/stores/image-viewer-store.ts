import { create } from "zustand";
import { IMAGE_ZOOM_FIT } from "@/lib/image-zoom";

/**
 * What the image viewer knows about each open image, by path: its pixel size once loaded and the
 * zoom the user chose, plus the disk-sync state: `version` is the cache key of the asset URL (bumped
 * when the file changes on disk) and `deleted` is set when the file is gone. The viewer and
 * `lib/image-disk-sync.ts` are the only writers; the footer (a separate chrome slot in the
 * page-kind view registry) reads it. An entry exists as long as the tab's viewer is mounted, which
 * is also how the watcher feed knows which paths are open images.
 */
export interface ImageViewState {
  width: number;
  height: number;
  zoom: number;
  version: number;
  deleted: boolean;
}

interface ImageViewerStore {
  views: Record<string, ImageViewState>;
  /** Register an open viewer (idempotent). */
  track: (path: string) => void;
  /** Record the loaded size; a size different from the previous one resets zoom to fit. Returns
   *  whether the size changed (the first load counts). */
  setSize: (path: string, width: number, height: number) => boolean;
  /** The file changed on disk: new cache key, no longer deleted. */
  reload: (path: string) => void;
  markDeleted: (path: string) => void;
  setZoom: (path: string, zoom: number) => void;
  forget: (path: string) => void;
}

const blank: ImageViewState = {
  width: 0,
  height: 0,
  zoom: IMAGE_ZOOM_FIT,
  version: 0,
  deleted: false,
};

export const useImageViewerStore = create<ImageViewerStore>((set, get) => ({
  views: {},
  track: (path) => set((s) => (s.views[path] ? s : { views: { ...s.views, [path]: blank } })),
  setSize: (path, width, height) => {
    const prev = get().views[path] ?? blank;
    const changed = prev.width !== width || prev.height !== height;
    set((s) => ({
      views: {
        ...s.views,
        [path]: { ...prev, width, height, zoom: changed ? IMAGE_ZOOM_FIT : prev.zoom },
      },
    }));
    return changed;
  },
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
  setZoom: (path, zoom) =>
    set((s) => ({ views: { ...s.views, [path]: { ...(s.views[path] ?? blank), zoom } } })),
  forget: (path) =>
    set((s) => {
      const { [path]: _gone, ...rest } = s.views;
      return { views: rest };
    }),
}));
