/**
 * Entry points shared by the sidebar menu, the palette and the pane: all of them end in the one
 * `openNewProjectDialog` store action (spec 4.4). Paths given to the dialog are vault-relative.
 */
import { getRelativePath } from "@/lib/paths";
import { folderOfFile } from "@features/agent/web/lib/project-sources";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
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

/** The project the pane is on: the active chat's, else the default for new chats. */
function currentProject(): string | null {
  const a = useAgentStore.getState();
  const chat = a.activeChatId ? a.chats[a.activeChatId] : undefined;
  return chat?.projectPath ?? a.currentProjectPath;
}

function showProjectBrowser(): void {
  const a = useAgentStore.getState();
  if (a.order.length === 0) a.newChat();
  usePaneStore.getState().setOpen(true);
  a.setView("project");
}

/** "Archive project" (palette, project menu): the pane's project home with the Archive confirm
 *  step open (the move itself is the home's button, one path). `path` defaults to the current
 *  project; another project becomes the pane's (a fresh chat in it, like picking it in the
 *  switcher). Without a project it only shows the browser. */
export function openArchiveProject(path: string | null = currentProject()): void {
  if (path) {
    const a = useAgentStore.getState();
    if (path !== currentProject()) {
      useAgentStore.setState({ currentProjectPath: path });
      a.newChat(path);
    }
    useProjectsStore.getState().setArchiveRequested(true);
  }
  showProjectBrowser();
}

/** Palette "Unarchive project...": the project browser with its Archived section expanded. */
export function openArchivedProjects(): void {
  useProjectsStore.getState().setArchivedExpanded(true);
  showProjectBrowser();
}
