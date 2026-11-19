// A built-in feature that does the job of an Obsidian community plugin (Excalidraw, Dataview,
// Tasks) asks the user once whether to turn the plugin off in Writer. This is that one mechanism:
// it applies only while the plugin runs in Writer's plugin host and the host lets core control
// it, asks once however many times it is called (a call while the question is open, or after an
// answer, does nothing), and turns the plugin off only in Writer's own plugin state, never in the
// vault's `.obsidian` folder. Where the answer is kept is `localStorage`.
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
  /** Dialog title, also the log scope. */
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

const open = new Set<string>();

/**
 * "Turn the plugin off in Writer?", asked once, remembered in `localStorage`. Resolves to
 * whether the plugin was turned off.
 */
export async function offerPluginTakeover(t: PluginTakeover): Promise<boolean> {
  if (!isCommunityPluginRunning(t.pluginId) || asked(t.askedKey)) return false;
  const control = communityPluginControl();
  const scope = t.title.toLowerCase();
  if (!control || open.has(scope)) return false;
  open.add(scope);
  try {
    const yes = await confirmAction(t.message, t.title);
    markAsked(t.askedKey);
    if (!yes) return false;
    try {
      await control.setEnabled(t.pluginId, false);
      return true;
    } catch (e) {
      logger.warn(scope, `could not turn the plugin off: ${String(e)}`);
      return false;
    }
  } finally {
    open.delete(scope);
  }
}
