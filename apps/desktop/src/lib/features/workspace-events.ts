// What core tells features about the open workspace: files that changed on disk and the secret
// store. A feature (the Obsidian host mirrors both into its vault and `SecretStorage`) registers a
// listener while it is on; core emits through the functions below and imports no feature, so the
// watcher and the secrets store have no host dependency. A throwing listener is reported to its
// feature's health and never stops the others.
import { OwnedRegistry } from "@/lib/owned-registry";
import { reportOwnerFailure } from "./health";

/** A watcher event as features see it. A rename reports the new path as `create`. */
export type FileChangeKind = "create" | "modify" | "delete";

export interface WorkspaceListenerContribution {
  /** `<feature id>.<name>`. */
  id: string;
  onFileChanged?: (kind: FileChangeKind, absPath: string) => void | Promise<void>;
  /** A secret was saved (`value`) or removed (`null`) in Settings > Secrets. */
  onSecretChanged?: (id: string, value: string | null) => void;
  /** The secrets document became readable (after a failed first read). */
  onSecretsReady?: () => void | Promise<void>;
}

export type OwnedWorkspaceListener = WorkspaceListenerContribution & { owner: string };

export const workspaceListeners = new OwnedRegistry<OwnedWorkspaceListener>();

async function each(
  call: (l: OwnedWorkspaceListener) => void | Promise<void> | undefined,
): Promise<void> {
  await Promise.all(
    workspaceListeners.list().map(async (l) => {
      try {
        await call(l);
      } catch (e) {
        reportOwnerFailure(l.owner, "workspace-listener", e);
      }
    }),
  );
}

export const emitFileChanged = (kind: FileChangeKind, absPath: string) =>
  each((l) => l.onFileChanged?.(kind, absPath));
export const emitSecretChanged = (id: string, value: string | null) =>
  each((l) => l.onSecretChanged?.(id, value));
export const emitSecretsReady = () => each((l) => l.onSecretsReady?.());
