/**
 * Where a pointer drag of vault files from the sidebar can land besides the editor and the tree
 * itself: a component that takes dropped vault files and folders by reference (the agent composer
 * mentions them) registers while it is mounted, and the sidebar's drag asks by screen position on
 * release. Core names no feature; with the feature off nothing is mounted, so nothing registers.
 */
export type VaultDrop = { path: string; isDir: boolean };

export type VaultDropTarget = {
  /** Is the screen point (CSS pixels) over the target? */
  contains(x: number, y: number): boolean;
  /** Takes the dropped vault files and folders (absolute paths, as the tree has them). */
  attachVaultFiles(entries: readonly VaultDrop[]): void;
};

let target: VaultDropTarget | null = null;

/** Registers the mounted target; returns the unregister function. */
export function registerVaultDropTarget(t: VaultDropTarget): () => void {
  target = t;
  return () => {
    if (target === t) target = null;
  };
}

/** Hands `entries` to the target under the point; false when there is none. */
export function dropVaultFilesOnTarget(
  x: number,
  y: number,
  entries: readonly VaultDrop[],
): boolean {
  if (!target?.contains(x, y)) return false;
  target.attachVaultFiles(entries);
  return true;
}
