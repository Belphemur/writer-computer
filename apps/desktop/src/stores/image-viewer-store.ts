import { create } from "zustand";
import { IMAGE_ZOOM_FIT } from "@/lib/image-zoom";

/**
 * What the image viewer knows about each open image, by path: its pixel size once loaded and the
 * zoom the user chose. The viewer is the only writer; its footer (a separate chrome slot in the
 * page-kind view registry) reads it. Entries live as long as the tab's viewer is mounted.
 */
export interface ImageViewState {
  width: number;
  height: number;
  zoom: number;
}

interface ImageViewerStore {
  views: Record<string, ImageViewState>;
  setSize: (path: string, width: number, height: number) => void;
  setZoom: (path: string, zoom: number) => void;
  forget: (path: string) => void;
}

const blank: ImageViewState = { width: 0, height: 0, zoom: IMAGE_ZOOM_FIT };

export const useImageViewerStore = create<ImageViewerStore>((set) => ({
  views: {},
  setSize: (path, width, height) =>
    set((s) => ({ views: { ...s.views, [path]: { ...(s.views[path] ?? blank), width, height } } })),
  setZoom: (path, zoom) =>
    set((s) => ({ views: { ...s.views, [path]: { ...(s.views[path] ?? blank), zoom } } })),
  forget: (path) =>
    set((s) => {
      const { [path]: _gone, ...rest } = s.views;
      return { views: rest };
    }),
}));
