// The agent's file tree decoration: the badge on a folder that holds a project (a folder with a
// `project.md` carrying a project id), drawn with the project's icon and color. Contributed
// through `fileTreeDecorations`; core draws it.
import { useMemo } from "react";
import type { FileTreeBadge } from "@/lib/features/types";
import type { DirEntry } from "@/types/fs";
import { projectColorVar, useProjectIcon } from "@features/agent/web/lib/project-appearance";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";

/** A React hook (called once per tree row): the badge for a project folder, else nothing. */
export function useProjectBadge(entry: DirEntry): FileTreeBadge | null {
  const appearance = useProjectsStore((s) =>
    entry.is_dir ? s.folderPaths.get(entry.path) : undefined,
  );
  const icon = useProjectIcon(appearance?.icon);
  const color = appearance ? projectColorVar(appearance.color) : null;
  return useMemo(
    () => (color ? { label: "Agent project", icon, color, testId: "project-badge" } : null),
    [icon, color],
  );
}
