// Coordination between a cell write and an editor tab that has the same note open. The editor
// store owns the open document; a write to disk must neither clobber unsaved edits nor leave a
// clean editor showing stale frontmatter. The reload goes through the same store action the file
// watcher uses (`reloadFromDisk`).
import * as editorApi from "@/hooks/editor-api";
import { isSaveInFlight } from "@/lib/save";
import * as tauri from "@/lib/tauri";

/** Is `absPath` open in an editor with unsaved changes (or a failed or running save)? */
export function hasUnsavedEditorChanges(absPath: string): boolean {
  const file = editorApi.getOpenFile(absPath);
  if (!file) return false;
  return file.isDirty || file.saveError !== null || isSaveInFlight(absPath);
}

/**
 * After a successful write: when the note is open in an editor and clean, reload it from disk.
 * Throws when the editor picked up unsaved changes while the write ran (its next save would
 * overwrite the cell) or when the reload read fails.
 */
export async function reloadOpenNoteAfterWrite(absPath: string): Promise<void> {
  const file = editorApi.getOpenFile(absPath);
  if (!file) return;
  if (file.isDirty || isSaveInFlight(absPath)) {
    throw new Error(
      "The note was edited in its tab while the cell was written. Its next save will overwrite the new value.",
    );
  }
  const raw = await tauri.readFile(absPath);
  const latest = editorApi.getOpenFile(absPath);
  if (!latest) return;
  if (latest.isDirty) {
    throw new Error(
      "The note was edited in its tab while the cell was written. Its next save will overwrite the new value.",
    );
  }
  if (raw.content !== latest.diskContent) editorApi.reloadFromDisk(absPath, raw.content);
}
