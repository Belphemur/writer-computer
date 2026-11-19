// The Obsidian Tasks plugin and Writer's own tasks work on the same task lines (ADR 2026-11-18,
// plugin coexistence): native takes over, asked once, through the shared prompt. The vault's
// `.obsidian` folder is never written; only Writer's own plugin state changes.
import { offerPluginTakeover } from "@/lib/plugin-takeover";

export const PLUGIN_ID = "obsidian-tasks-plugin";
export const ASKED_KEY = "writer.tasks.takeoverAsked";

/** Offer to turn the Tasks plugin off in Writer; resolves to whether it was turned off. */
export function offerTasksTakeover(): Promise<boolean> {
  return offerPluginTakeover({
    pluginId: PLUGIN_ID,
    askedKey: ASKED_KEY,
    message:
      "The Tasks plugin is on. Writer now handles tasks itself: dates, recurrence and task bases. Turn the plugin off in Writer? Obsidian is not affected.",
    title: "Tasks",
  });
}
