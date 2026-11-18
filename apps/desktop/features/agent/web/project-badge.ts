// The agent's file tree decoration: the badge on a folder that holds a project (a folder with a
// `project.md` carrying a project id), drawn with the project's icon and color. Contributed
// through `fileTreeDecorations`; core draws it.
import { useMemo } from "react";
import type { FileTreeBadge } from "@/lib/features/types";
import type { DirEntry } from "@/types/fs";
import {
  isProjectColor,
  projectColorVar,
  useProjectIcon,
} from "@features/agent/web/lib/project-appearance";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";

/** A React hook (called once per tree row): the badge for a project folder, else nothing. A
 *  project without a color keeps the tree's muted grey (no `color`), not the accent. */
export function useProjectBadge(entry: DirEntry): FileTreeBadge | null {
  const appearance = useProjectsStore((s) =>
    entry.is_dir ? s.folderPaths.get(entry.path) : undefined,
  );
  const icon = useProjectIcon(appearance?.icon);
  const isProject = !!appearance;
  const color = isProjectColor(appearance?.color) ? projectColorVar(appearance.color) : undefined;
  return useMemo(
    () => (isProject ? { label: "Agent project", icon, color, testId: "project-badge" } : null),
    [isProject, icon, color],
  );
}
