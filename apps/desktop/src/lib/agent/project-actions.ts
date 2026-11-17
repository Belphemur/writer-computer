/**
 * Entry points shared by the sidebar menu, the palette and the pane: all of them end in the one
 * `openNewProjectDialog` store action (spec 4.4). Paths given to the dialog are vault-relative.
 */
import { getParentDir, getRelativePath } from "@/lib/paths";
import { useAgentStore } from "@/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** "Make project" on an absolute folder path inside the open workspace. */
export function openMakeProjectForFolder(absFolder: string): void {
  const root = useWorkspaceStore.getState().root;
  if (!root) return;
  const rel = getRelativePath(absFolder, root);
  if (!rel || rel === absFolder) return;
  useAgentStore.getState().openNewProjectDialog({ folder: rel });
}

/** The folder that holds the active file, relative to the vault; null at the vault root. */
export function folderOfFile(filePath: string | null, root: string | null): string | null {
  if (!filePath || !root) return null;
  const rel = getRelativePath(getParentDir(filePath), root);
  if (!rel || rel === "/" || rel.startsWith("/")) return null;
  return rel;
}

export function openNewProject(): void {
  useAgentStore.getState().openNewProjectDialog();
}

export function openMakeProjectForActiveFile(activeFilePath: string | null): void {
  const rel = folderOfFile(activeFilePath, useWorkspaceStore.getState().root);
  if (rel) useAgentStore.getState().openNewProjectDialog({ folder: rel });
}
