import { ConfirmDialog } from "@/components/confirm-dialog";
import { useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { projectClient, type ProjectClient } from "@features/agent/web/lib/project-client";
import { leaveArchivedProject } from "@features/agent/web/lib/project-actions";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";

/**
 * "Archive project?" (spec 4.6): the one confirmation behind every Archive entry point (project
 * rows, the palette), rendered from the projects store's `archiveTarget`. Archive is the one
 * `client.archive` call; the dialog stays open with the backend's message when it refuses (a busy
 * chat). It never switches project, starts a chat or navigates.
 */
export function ArchiveProjectDialog({ client = projectClient }: { client?: ProjectClient }) {
  const path = useProjectsStore((s) => s.archiveTarget);
  const name = useProjectsStore((s) => s.projects.find((p) => p.path === path)?.name);
  const folder =
    String(useSetting("agent.projects-archive-folder") ?? "").trim() || "Archive/Projects";
  const root = useWorkspaceRoot();
  if (!path || !root) return null;
  return (
    <ConfirmDialog
      key={path}
      title="Archive project?"
      confirmLabel="Archive"
      destructive
      onClose={() => useProjectsStore.getState().setArchiveTarget(null)}
      onConfirm={async () => {
        await client.archive(path, true);
        await useProjectsStore.getState().refresh();
        leaveArchivedProject(path);
      }}
    >
      <p>
        Moves <strong>{name ?? path.split("/").pop()}</strong> ({path}) to {folder} and hides it
        from the project pickers. Notes and chats move with it; Unarchive brings it back.
      </p>
    </ConfirmDialog>
  );
}
