// Which Obsidian community plugins are running, as far as core needs to know. A built-in feature
// can yield to a plugin that does the same job (the tables feature stands down for Advanced
// Tables) without importing the plugin host. The Obsidian host feature publishes the set while it
// runs and clears it when it stops; with the feature off nothing is "running".
let running: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the running set or the control changes (a feature that offers a
 *  choice when a plugin shows up listens, since plugins load after the workspace opens). */
export function subscribeCommunityPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Replaces the set of running (enabled and loaded) community plugin ids. */
export function setRunningCommunityPlugins(ids: Iterable<string>): void {
  running = new Set(ids);
  notify();
}

export function isCommunityPluginRunning(id: string): boolean {
  return running.has(id);
}

/** What the host lets core do to a plugin: turn it on or off in Writer's own plugin state (never
 *  the vault's `.obsidian` folder). Published with the running set; absent while the host is. */
export interface CommunityPluginControl {
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

let control: CommunityPluginControl | null = null;

export function setCommunityPluginControl(next: CommunityPluginControl | null): void {
  control = next;
  notify();
}

export function communityPluginControl(): CommunityPluginControl | null {
  return control;
}
