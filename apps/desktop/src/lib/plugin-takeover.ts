// A built-in feature that does the job of an Obsidian community plugin asks the user once what
// to do when both are on (Excalidraw, Dataview, Tasks: Writer's own view or the plugin; spelling:
// Writer's checker, LanguageTool or both). This is that one mechanism: it applies only while the plugin runs in
// Writer's plugin host and the host lets core control it, asks once however many times it is
// called (a call while the question is open, or after an answer, does nothing), and turns the
// plugin off only in Writer's own plugin state, never in the vault's `.obsidian` folder. How the
// question looks and where the answer is kept belong to the feature.
import { communityPluginControl, isCommunityPluginRunning } from "@/lib/community-plugins";
import { logger } from "@/lib/logger";
import { confirmAction } from "@/lib/tauri";

export interface TakeoverOffer<A extends string> {
  /** The community plugin's id. */
  pluginId: string;
  /** Names the log channel and keeps the one question per feature from opening twice. */
  scope: string;
  /** The answer remembered from before, `null` when the user has not been asked. */
  remembered: () => A | null;
  remember: (answer: A) => void;
  ask: () => Promise<A>;
  /** Whether this answer turns the plugin off in Writer. */
  turnsPluginOff: (answer: A) => boolean;
}

const open = new Set<string>();

export interface TakeoverResult<A extends string> {
  answer: A;
  /** The plugin was turned off in Writer (false when the answer did not ask for it or it failed). */
  pluginOff: boolean;
}

/** Asks when it applies. Resolves to what happened, or `null` when nothing was asked. */
export async function offerTakeover<A extends string>(
  offer: TakeoverOffer<A>,
): Promise<TakeoverResult<A> | null> {
  if (!isCommunityPluginRunning(offer.pluginId) || offer.remembered() !== null) return null;
  const control = communityPluginControl();
  if (!control || open.has(offer.scope)) return null;
  open.add(offer.scope);
  try {
    const answer = await offer.ask();
    offer.remember(answer);
    let pluginOff = false;
    if (offer.turnsPluginOff(answer)) {
      try {
        await control.setEnabled(offer.pluginId, false);
        pluginOff = true;
      } catch (e) {
        logger.warn(offer.scope, `could not turn the plugin off: ${String(e)}`);
      }
    }
    return { answer, pluginOff };
  } finally {
    open.delete(offer.scope);
  }
}

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

/**
 * The yes/no takeover most features need (Excalidraw, Dataview, Tasks), over
 * [`offerTakeover`]: "turn the plugin off in Writer?", asked once, remembered in
 * `localStorage`. Resolves to whether the plugin was turned off.
 */
export async function offerPluginTakeover(t: PluginTakeover): Promise<boolean> {
  const result = await offerTakeover<"yes" | "no">({
    pluginId: t.pluginId,
    scope: t.title.toLowerCase(),
    remembered: () => (asked(t.askedKey) ? "no" : null),
    remember: () => markAsked(t.askedKey),
    ask: async () => ((await confirmAction(t.message, t.title)) ? "yes" : "no"),
    turnsPluginOff: (answer) => answer === "yes",
  });
  return result?.pluginOff ?? false;
}
