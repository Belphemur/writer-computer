/**
 * Where a pointer drag of vault files from the sidebar can land besides the editor and the tree
 * itself: a component that takes dropped vault files by reference (the agent composer takes
 * images) registers while it is mounted, and the sidebar's drag asks by screen position on
 * release. Core names no feature; with the feature off nothing is mounted, so nothing registers.
 */
export type VaultDropTarget = {
  /** Is the screen point (CSS pixels) over the target? */
  contains(x: number, y: number): boolean;
  /** Takes the vault-relative paths of the dropped files. */
  attachVaultFiles(paths: readonly string[]): void;
};

let target: VaultDropTarget | null = null;

/** Registers the mounted target; returns the unregister function. */
export function registerVaultDropTarget(t: VaultDropTarget): () => void {
  target = t;
  return () => {
    if (target === t) target = null;
  };
}

/** Hands `paths` to the target under the point; false when there is none. */
export function dropVaultFilesOnTarget(x: number, y: number, paths: readonly string[]): boolean {
  if (!target?.contains(x, y)) return false;
  target.attachVaultFiles(paths);
  return true;
}
