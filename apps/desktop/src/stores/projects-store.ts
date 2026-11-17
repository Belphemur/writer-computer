import { create } from "zustand";
import { projectClient, type ProjectDetail } from "@/lib/agent/project-client";
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
      console.error("[projects] list failed:", error);
    }
  },
  clear: () => set({ projects: [], folderPaths: new Set(), loadedRoot: null }),
}));

/** Does the sidebar folder at this absolute path hold a project? */
export function useIsProjectFolder(path: string, isDir: boolean): boolean {
  return useProjectsStore((s) => isDir && s.folderPaths.has(path));
}

// Keep the list in step with the open workspace: load on open/switch, drop on close.
useWorkspaceStore.subscribe((state, prev) => {
  if (state.root === prev.root) return;
  if (state.root) void useProjectsStore.getState().refresh();
  else useProjectsStore.getState().clear();
});
