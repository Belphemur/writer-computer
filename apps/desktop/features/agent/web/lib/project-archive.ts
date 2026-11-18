/**
 * The one "archived" rule of the web side (spec 4.6): a project is archived when its
 * `project.md` carries `copilot-project-archived-at`, which the backend reports as `archivedAt`.
 * Every list of projects (switcher, new-chat choice, tree badge, the Archived section) comes from
 * `splitProjects`, so no surface tests the field itself.
 */
import type { ProjectDetail } from "@features/agent/web/lib/project-client";

export const isArchivedProject = (p: Pick<ProjectDetail, "archivedAt">): boolean =>
  typeof p.archivedAt === "number";

export function splitProjects(all: readonly ProjectDetail[]): {
  active: ProjectDetail[];
  archived: ProjectDetail[];
} {
  return {
    active: all.filter((p) => !isArchivedProject(p)),
    archived: all.filter(isArchivedProject),
  };
}
