// The agent's file tree decoration: the badge on a folder that holds a project (a folder with a
// `project.md` carrying a project id). Contributed through `fileTreeDecorations`; core draws it.
import { SparklesIcon } from "@hugeicons/core-free-icons";
import type { FileTreeBadge } from "@/lib/features/types";
import type { DirEntry } from "@/types/fs";
import { useIsProjectFolder } from "@features/agent/web/stores/projects-store";

const PROJECT_BADGE: FileTreeBadge = {
  label: "Agent project",
  icon: SparklesIcon,
  testId: "project-badge",
};

/** A React hook (called once per tree row): the badge for a project folder, else nothing. */
export function useProjectBadge(entry: DirEntry): FileTreeBadge | null {
  return useIsProjectFolder(entry.path, entry.is_dir) ? PROJECT_BADGE : null;
}
