/**
 * Entry points shared by the sidebar menu, the palette and the pane: all of them end in the one
 * `openNewProjectDialog` store action (spec 4.4). Paths given to the dialog are vault-relative.
 */
import { getRelativePath } from "@/lib/paths";
import { folderOfFile } from "@features/agent/web/lib/project-sources";
import { startNewAgentChat } from "@features/agent/web/hooks/agent-api";
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

function showProjectsList(): void {
  const a = useAgentStore.getState();
  if (a.order.length === 0) a.newChat();
  usePaneStore.getState().setOpen(true);
  a.setView("projects");
}

/** Palette "Agent: Projects", the header's folder button, "Show all projects": the Projects list. */
export function openProjectsList(): void {
  showProjectsList();
}

/** Makes `path` (null = the vault root) the pane's project and starts a chat in it: what picking
 *  a project in the switcher, a row of the list or the new-project dialog does. */
export function chooseProject(path: string | null): void {
  useAgentStore.setState({ currentProjectPath: path, view: "chat" });
  startNewAgentChat(path);
}

/** The detail view of one project (a list row, the switcher's "Project home"). It shows that
 *  project only; the pane's current project does not change. */
export function openProjectDetail(path: string): void {
  useProjectsStore.getState().setDetailPath(path);
  useAgentStore.getState().setView("project");
}

/** "Archive project" (palette, project menus): opens the confirmation dialog for `path` (default:
 *  the current project) where the user is; nothing else changes until the dialog's Archive
 *  succeeds. Without a project there is nothing to archive. */
export function openArchiveProject(path: string | null = currentProject()): void {
  if (path) useProjectsStore.getState().setArchiveTarget(path);
}

/** After `path` was archived: if it was the pane's project, fall back to no project (the
 *  vault-root default); if its detail was showing, return to the Projects list. */
export function leaveArchivedProject(path: string): void {
  const a = useAgentStore.getState();
  const projects = useProjectsStore.getState();
  const shown = projects.detailPath ?? currentProject();
  if (currentProject() === path) useAgentStore.setState({ currentProjectPath: null });
  if (a.view === "project" && shown === path) {
    projects.setDetailPath(null);
    a.setView("projects");
  }
}

/** Palette "Unarchive project...": the Projects list with its Archived group expanded. */
export function openArchivedProjects(): void {
  useProjectsStore.getState().setArchivedExpanded(true);
  showProjectsList();
}
