import { useWorkspaceStore } from "@/stores/workspace-store";
import type { WorkspaceIdentity } from "@/lib/workspace-events";

export function getWorkspaceRoot() {
  return useWorkspaceStore.getState().root;
}

export function getWorkspaceIdentity() {
  const { root, workspaceGeneration } = useWorkspaceStore.getState();
  return { root, workspaceGeneration };
}

export function isCurrentWorkspaceIdentity(identity: ReturnType<typeof getWorkspaceIdentity>) {
  const current = getWorkspaceIdentity();
  return (
    current.root === identity.root && current.workspaceGeneration === identity.workspaceGeneration
  );
}

/** The `{root, epoch}` identity workspace events (`fs:*`, `index://changed`) are matched against,
 *  or `null` without a workspace. */
export function getWorkspaceEventIdentity(): WorkspaceIdentity | null {
  const { root, workspaceEpoch } = useWorkspaceStore.getState();
  return root !== null && workspaceEpoch !== null ? { root, epoch: workspaceEpoch } : null;
}
