// The Obsidian Excalidraw plugin and Writer's own drawing view want the same files (ADR
// 2026-11-18, point 4): native takes over, through the one shared prompt. The setting
// `excalidraw.handle-files` hands the files back at any time.
import { offerPluginTakeover } from "@/lib/plugin-takeover";

export const PLUGIN_ID = "obsidian-excalidraw-plugin";
const ASKED_KEY = "writer.excalidraw.takeoverAsked";

/** Offer the takeover when it applies. Resolves to whether the plugin was turned off. */
export function offerTakeover(): Promise<boolean> {
  return offerPluginTakeover({
    pluginId: PLUGIN_ID,
    askedKey: ASKED_KEY,
    message:
      "The Excalidraw plugin is on. Writer now opens drawings itself. Turn the plugin off in Writer? Obsidian is not affected.",
    title: "Excalidraw",
  });
}

export const __testTakeover = { ASKED_KEY };
