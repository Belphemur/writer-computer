import { getService } from "@/lib/features/services";

/**
 * Drawings (`.excalidraw.md`, `.excalidraw`): core claims the paths for the `drawing` page kind;
 * the built-in feature `excalidraw` supplies the view and this rule. The user can hand the files
 * back to the Obsidian Excalidraw plugin (`excalidraw.handle-files`): the feature then says so
 * through its `excalidraw.files` service. With the feature off there is no service and the kind
 * still claims its paths, so a drawing's tab shows the "turned off" page rather than raw data.
 * Core never imports the feature.
 */

/** The service id the feature registers (`provides` in its manifest). */
export const DRAWING_FILES = "excalidraw.files";

/** What the feature offers core: does Writer itself open drawings? */
export interface DrawingFiles {
  handledNatively(): boolean;
}

export function drawingsHandledNatively(): boolean {
  return getService<DrawingFiles>(DRAWING_FILES)?.handledNatively() ?? true;
}
