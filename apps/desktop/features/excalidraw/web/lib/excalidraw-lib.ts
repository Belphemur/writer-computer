// The one door to the Excalidraw package. It is a lazy chunk (several MB with its CSS): nothing
// outside the feature's `load` thunks imports this module statically, and `tests/` pins that
// the startup graph never reaches `@excalidraw/excalidraw`.
//
// No network (ADR 2026-11-18, point 1): Excalidraw fetches its fonts from `EXCALIDRAW_ASSET_PATH`,
// which is the app's own `/excalidraw-assets/` (copied from the package into the bundle by the
// `excalidrawAssets` Vite plugin, `vite.config.ts`); it is set before the package is imported.
// Collaboration and the online library are never wired up, and the view turns the UI for them off.
import type { ComponentType } from "react";
import type { SceneElement, SceneFile } from "./excalidraw-md";

export const ASSET_PATH = "/excalidraw-assets/";

/** The part of Excalidraw's imperative API the feature uses. */
export interface ExcalidrawApi {
  updateScene(data: {
    elements?: readonly SceneElement[];
    appState?: Record<string, unknown>;
    captureUpdate?: unknown;
  }): void;
  getSceneElementsIncludingDeleted(): readonly SceneElement[];
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, SceneFile>;
  addFiles(files: SceneFile[]): void;
}

export interface ExportToSvgOptions {
  elements: readonly SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, SceneFile>;
  exportPadding?: number;
}

export interface ExportToBlobOptions extends ExportToSvgOptions {
  mimeType: "image/png";
  /** The size of the image and its pixel ratio, from the natural size. */
  getDimensions?: (
    width: number,
    height: number,
  ) => { width: number; height: number; scale: number };
}

export interface ExcalidrawLib {
  Excalidraw: ComponentType<Record<string, unknown>>;
  exportToSvg(options: ExportToSvgOptions): Promise<SVGSVGElement>;
  exportToBlob(options: ExportToBlobOptions): Promise<Blob>;
  CaptureUpdateAction: { NEVER: unknown; IMMEDIATELY: unknown };
}

let loading: Promise<ExcalidrawLib> | null = null;

export function loadExcalidraw(): Promise<ExcalidrawLib> {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = ASSET_PATH;
  loading ??= Promise.all([
    import("@excalidraw/excalidraw"),
    import("@excalidraw/excalidraw/index.css"),
  ]).then(([lib]) => lib as unknown as ExcalidrawLib);
  loading.catch(() => {
    loading = null; // a failed load may be tried again
  });
  return loading;
}
