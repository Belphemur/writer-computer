/**
 * Chat notes live in hidden folders the file watcher never sees, so after the pane writes one it
 * reloads the note itself when it is open in an editor tab (spec section 9, "Autosave").
 */
import { getOpenFile, reloadFromDisk } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { readFile } from "@/lib/tauri";

export async function reloadChatNoteIfOpen(relativePath: string): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;
  const abs = `${root.replace(/\/+$/, "")}/${relativePath}`;
  if (!getOpenFile(abs)) return false;
  const file = await readFile(abs);
  reloadFromDisk(abs, file.content);
  return true;
}
