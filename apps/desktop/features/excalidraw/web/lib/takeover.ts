// The Obsidian Excalidraw plugin and Writer's own drawing view want the same files (ADR
// 2026-11-18, point 4): native takes over. The first time a drawing opens while the plugin is
// running in Writer, ask once whether to turn the plugin off in Writer's own plugin state (the
// vault's `.obsidian` folder is never written). The answer is remembered, whichever it is; the
// setting `excalidraw.handle-files` hands the files back at any time.
import { communityPluginControl, isCommunityPluginRunning } from "@/lib/community-plugins";
import { logger } from "@/lib/logger";
import { confirmAction } from "@/lib/tauri";

export const PLUGIN_ID = "obsidian-excalidraw-plugin";
const ASKED_KEY = "writer.excalidraw.takeoverAsked";

function asked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // no storage: the question may come back next launch, which is harmless
  }
}

/** Offer the takeover when it applies. Resolves to whether the plugin was turned off. */
export async function offerTakeover(): Promise<boolean> {
  if (!isCommunityPluginRunning(PLUGIN_ID) || asked()) return false;
  const control = communityPluginControl();
  if (!control) return false;
  markAsked();
  const yes = await confirmAction(
    "The Excalidraw plugin is on. Writer now opens drawings itself. Turn the plugin off in Writer? Obsidian is not affected.",
    "Excalidraw",
  );
  if (!yes) return false;
  try {
    await control.setEnabled(PLUGIN_ID, false);
    return true;
  } catch (e) {
    logger.warn("excalidraw", `could not turn the plugin off: ${String(e)}`);
    return false;
  }
}

export const __testTakeover = { ASKED_KEY };
