// "New drawing": an empty native `.excalidraw` drawing next to the open note (palette) or in the folder that
// was right-clicked (sidebar), opened in a tab. The text comes from the codec (the one place that
// knows the shape of a new file); the write is core's atomic one.
import { openPath } from "@/lib/link-activation";
import { getParentDir } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { newDrawingText } from "./excalidraw-md";

/** The first free `Drawing.excalidraw`, `Drawing 1.excalidraw`, ... in `dir`. */
export async function freeDrawingPath(
  dir: string,
  exists: (path: string) => Promise<boolean> = tauri.fileExists,
): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const path = `${dir}/${n === 0 ? "Drawing" : `Drawing ${n}`}.excalidraw`;
    if (!(await exists(path))) return path;
  }
  throw new Error("no free drawing name");
}

export async function createDrawing(dir: string): Promise<string> {
  const path = await freeDrawingPath(dir);
  await tauri.writeFile(path, newDrawingText("plain"));
  await useWorkspaceStore.getState().refreshDirectory(dir);
  await openPath(path, "current");
  return path;
}

/** The folder of the open note, else the workspace root. */
export function defaultDrawingDir(): string | null {
  const active = useEditorStore.getState().activeFilePath;
  if (active) return getParentDir(active);
  return useWorkspaceStore.getState().root;
}
