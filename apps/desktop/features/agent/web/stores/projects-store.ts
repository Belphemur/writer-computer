import { create } from "zustand";
import { projectClient, type ProjectDetail } from "@features/agent/web/lib/project-client";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace-store";

interface ProjectsState {
  /** Non-archived projects of the open workspace, most recently used first. */
  projects: ProjectDetail[];
  /** Absolute folder paths of those projects, for the sidebar badge (one Set lookup per row). */
  folderPaths: Set<string>;
  loadedRoot: string | null;
  refresh: () => Promise<void>;
  clear: () => void;
}

let refreshSeq = 0;

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  folderPaths: new Set(),
  loadedRoot: null,
  refresh: async () => {
    const root = useWorkspaceStore.getState().root;
    const seq = ++refreshSeq;
    if (!root) {
      set({ projects: [], folderPaths: new Set(), loadedRoot: null });
      return;
    }
    try {
      const projects = await projectClient.list(false);
      // A newer refresh or a workspace switch wins over this answer.
      if (seq !== refreshSeq || useWorkspaceStore.getState().root !== root) return;
      set({
        projects,
        folderPaths: new Set(projects.map((p) => `${root}/${p.path}`)),
        loadedRoot: root,
      });
    } catch (error) {
      logger.warn("agent", `could not list the projects: ${String(error)}`);
    }
  },
  clear: () => set({ projects: [], folderPaths: new Set(), loadedRoot: null }),
}));

/** Does the sidebar folder at this absolute path hold a project? */
export function useIsProjectFolder(path: string, isDir: boolean): boolean {
  return useProjectsStore((s) => isDir && s.folderPaths.has(path));
}

/** Keeps the list in step with the open workspace: load on open and switch, drop on close.
 *  Started by the feature's activation (`dock-sync.ts`), so a turned-off feature asks the backend
 *  for nothing. Returns the stop function. */
export function watchProjects(): () => void {
  if (useWorkspaceStore.getState().root) void useProjectsStore.getState().refresh();
  return useWorkspaceStore.subscribe((state, prev) => {
    if (state.root === prev.root) return;
    if (state.root) void useProjectsStore.getState().refresh();
    else useProjectsStore.getState().clear();
  });
}
