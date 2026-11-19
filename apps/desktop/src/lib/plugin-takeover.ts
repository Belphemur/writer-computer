// A built-in feature and the Obsidian plugin it replaces want the same files or blocks: native
// takes over. The first time the feature's content shows up while the plugin is running in Writer,
// ask once whether to turn the plugin off in Writer's own plugin state (the vault's `.obsidian`
// folder is never written). The answer is remembered, whichever it is. One implementation for
// every feature that replaces a plugin (Excalidraw, Dataview).
import { communityPluginControl, isCommunityPluginRunning } from "@/lib/community-plugins";
import { logger } from "@/lib/logger";
import { confirmAction } from "@/lib/tauri";

export interface PluginTakeover {
  /** The community plugin's id. */
  pluginId: string;
  /** The `localStorage` key that remembers the question was asked. */
  askedKey: string;
  /** The question; names what Writer now does itself. */
  message: string;
  /** Dialog title, also the log source. */
  title: string;
}

function asked(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markAsked(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // no storage: the question may come back next launch, which is harmless
  }
}

/** Offer the takeover when it applies. Resolves to whether the plugin was turned off. */
export async function offerPluginTakeover(t: PluginTakeover): Promise<boolean> {
  if (!isCommunityPluginRunning(t.pluginId) || asked(t.askedKey)) return false;
  const control = communityPluginControl();
  if (!control) return false;
  markAsked(t.askedKey);
  if (!(await confirmAction(t.message, t.title))) return false;
  try {
    await control.setEnabled(t.pluginId, false);
    return true;
  } catch (e) {
    logger.warn(t.title.toLowerCase(), `could not turn the plugin off: ${String(e)}`);
    return false;
  }
}
