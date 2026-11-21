// "Resolve conflicts" (the palette, spec `SPECs/git-sync-spec.md` "Merge view"): the merge view of
// the open note when it is in conflict, else of the first conflicted file; binaries are settled in
// the panel, which this opens when there is no text conflict.
import { openGitMergeTab } from "@/hooks/editor-api";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { PANEL_ID } from "./state";
import { useGitStatus } from "./status-store";

/** The absolute path of a vault-relative one (a tab's location is absolute). */
export function absolutePath(root: string | null, rel: string): string | null {
  return root ? `${root.replace(/\/$/, "")}/${rel}` : null;
}

/** Opens the merge view of the conflicted file at vault-relative `rel` (the one entry the panel,
 *  the palette and the note's bar share). */
export function openMerge(rel: string, options?: { activate?: boolean }) {
  const path = absolutePath(useWorkspaceStore.getState().root, rel);
  if (path) openGitMergeTab({ path }, options);
}

/** `activePath` is the absolute path of the active file, if any. */
export function resolveConflicts(activePath: string | null) {
  const status = useGitStatus.getState().status;
  const conflicts = status?.conflicts ?? [];
  const root = useWorkspaceStore.getState().root?.replace(/\/$/, "");
  const active =
    activePath && root ? conflicts.find((c) => `${root}/${c.path}` === activePath) : null;
  const target = active ?? conflicts[0];
  if (target) openMerge(target.path);
  else useUIStore.getState().selectSidebarPanel(PANEL_ID);
}
