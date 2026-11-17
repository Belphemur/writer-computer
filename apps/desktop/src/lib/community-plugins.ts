// Which Obsidian community plugins are running, as far as core needs to know. A built-in feature
// can yield to a plugin that does the same job (the tables feature stands down for Advanced
// Tables) without importing the plugin host. The Obsidian host feature publishes the set while it
// runs and clears it when it stops; with the feature off nothing is "running".
let running: ReadonlySet<string> = new Set();

/** Replaces the set of running (enabled and loaded) community plugin ids. */
export function setRunningCommunityPlugins(ids: Iterable<string>): void {
  running = new Set(ids);
}

export function isCommunityPluginRunning(id: string): boolean {
  return running.has(id);
}
