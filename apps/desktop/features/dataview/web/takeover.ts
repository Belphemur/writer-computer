// The Obsidian Dataview plugin and Writer's own blocks render the same ```dataview fences (ADR
// 2026-11-18, plugin coexistence): native takes over, asked once, through the shared prompt.
import { offerPluginTakeover } from "@/lib/plugin-takeover";

export const PLUGIN_ID = "dataview";
export const ASKED_KEY = "writer.dataview.takeoverAsked";

/** Offer to turn the Dataview plugin off in Writer; resolves to whether it was turned off. */
export function offerDataviewTakeover(): Promise<boolean> {
  return offerPluginTakeover({
    pluginId: PLUGIN_ID,
    askedKey: ASKED_KEY,
    message:
      "The Dataview plugin is on. Writer now runs dataview blocks itself. Turn the plugin off in Writer? Obsidian is not affected.",
    title: "Dataview",
  });
}
