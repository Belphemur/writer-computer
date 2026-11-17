/**
 * Entry points shared by the sidebar menu, the palette and the pane: all of them end in the one
 * `openNewProjectDialog` store action (spec 4.4). Paths given to the dialog are vault-relative.
 */
import { getRelativePath } from "@/lib/paths";
import { folderOfFile } from "@features/agent/web/lib/project-sources";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** "Make project" on an absolute folder path inside the open workspace. */
export function openMakeProjectForFolder(absFolder: string): void {
  const root = useWorkspaceStore.getState().root;
  if (!root) return;
  const rel = getRelativePath(absFolder, root);
  if (!rel || rel === absFolder) return;
  useAgentStore.getState().openNewProjectDialog({ folder: rel });
}

export function openNewProject(): void {
  useAgentStore.getState().openNewProjectDialog();
}

export function openMakeProjectForActiveFile(activeFilePath: string | null): void {
  const rel = folderOfFile(activeFilePath, useWorkspaceStore.getState().root);
  if (rel) useAgentStore.getState().openNewProjectDialog({ folder: rel });
}
