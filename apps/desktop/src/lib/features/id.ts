/** A feature id: kebab-case, the folder name, the Tauri plugin name and the prefix of everything it owns. */
export const FEATURE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function assertFeatureId(id: string): void {
  if (!FEATURE_ID.test(id)) throw new Error(`invalid feature id: ${id}`);
}
