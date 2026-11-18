import { create } from "zustand";
import { useMemo } from "react";
import { projectClient, type ProjectDetail } from "@features/agent/web/lib/project-client";
import { appearanceOf, type ProjectAppearance } from "@features/agent/web/lib/project-appearance";
import { splitProjects } from "@features/agent/web/lib/project-archive";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace-store";

interface ProjectsState {
  /** Non-archived projects of the open workspace, most recently used first. */
  projects: ProjectDetail[];
  /** Archived projects (they live in the archive folder), most recently used first. */
  archived: ProjectDetail[];
  /** Absolute folder path of each of those projects with its icon and color, for the sidebar
   *  badge (one Map lookup per row). */
  folderPaths: Map<string, ProjectAppearance>;
  loadedRoot: string | null;
  refresh: () => Promise<void>;
  /** Palette intents: "Archive project" asks the project home to show its confirm step,
   *  "Unarchive project..." asks the project browser to expand its Archived section. The view
   *  that owns the control reads and clears them. */
  archiveRequested: boolean;
  archivedExpanded: boolean;
  setArchiveRequested: (v: boolean) => void;
  setArchivedExpanded: (v: boolean) => void;
  /** The one write of a project's icon and color (spec 4.8): `project.md` through
   *  `agent_update_project`, then the list entry is replaced by what was written. `null` removes
   *  the key. Rejects with the backend's message. */
  setAppearance: (path: string, next: ProjectAppearance) => Promise<void>;
  clear: () => void;
}

let refreshSeq = 0;

function folderPathsOf(root: string, projects: ProjectDetail[]): Map<string, ProjectAppearance> {
  return new Map(projects.map((p) => [`${root}/${p.path}`, appearanceOf(p)]));
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  archived: [],
  folderPaths: new Map(),
  loadedRoot: null,
  archiveRequested: false,
  archivedExpanded: false,
  setArchiveRequested: (archiveRequested) => set({ archiveRequested }),
  setArchivedExpanded: (archivedExpanded) => set({ archivedExpanded }),
  refresh: async () => {
    const root = useWorkspaceStore.getState().root;
    const seq = ++refreshSeq;
    if (!root) {
      set({ projects: [], archived: [], folderPaths: new Map(), loadedRoot: null });
      return;
    }
    try {
      const { active: projects, archived } = splitProjects(await projectClient.list(true));
      // A newer refresh or a workspace switch wins over this answer.
      if (seq !== refreshSeq || useWorkspaceStore.getState().root !== root) return;
      set({
        projects,
        archived,
        folderPaths: folderPathsOf(root, projects),
        loadedRoot: root,
      });
    } catch (error) {
      logger.warn("agent", `could not list the projects: ${String(error)}`);
    }
  },
  setAppearance: async (path, next) => {
    const written = await projectClient.update(path, {
      icon: next.icon ?? "",
      color: next.color ?? "",
    });
    const root = useWorkspaceStore.getState().root;
    set((s) => {
      const projects = s.projects.map((p) => (p.path === path ? written : p));
      return { projects, folderPaths: root ? folderPathsOf(root, projects) : s.folderPaths };
    });
  },
  clear: () => set({ projects: [], archived: [], folderPaths: new Map(), loadedRoot: null }),
}));

/** The icon and color of the project at a vault-relative path (none for a path that is not a
 *  listed project, such as the vault root). Selects the two strings, so a rename re-renders no
 *  icon. */
export function useProjectAppearance(path: string | null): ProjectAppearance {
  const icon = useProjectsStore((s) => appearanceOf(s.projects.find((p) => p.path === path)).icon);
  const color = useProjectsStore(
    (s) => appearanceOf(s.projects.find((p) => p.path === path)).color,
  );
  return useMemo(() => ({ icon, color }), [icon, color]);
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
