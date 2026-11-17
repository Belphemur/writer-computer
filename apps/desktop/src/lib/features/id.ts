/** A feature id: kebab-case, the folder name, the Tauri plugin name and the prefix of everything it owns. */
export const FEATURE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function assertFeatureId(id: string): void {
  if (!FEATURE_ID.test(id)) throw new Error(`invalid feature id: ${id}`);
}

/** The owner string a feature's contributions are registered under (`OwnedRegistry` groups). */
export const ownerOf = (id: string) => `builtin:${id}`;

/** The feature id behind an owner string, or null for an owner that is not a built-in feature. */
export function featureOfOwner(owner: string): string | null {
  return owner.startsWith("builtin:") ? owner.slice("builtin:".length) : null;
}
