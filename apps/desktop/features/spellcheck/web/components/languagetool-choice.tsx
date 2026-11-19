// The one-time question when the LanguageTool plugin is running next to Writer's own checker
// (ADR point 9): Writer's checker, the plugin, or both. Mounted once while the feature is on
// (the `overlays` point); it draws nothing, it only owns the side effect: it offers the choice
// now and whenever the plugin host publishes a change (plugins load after the workspace opens).
// The mechanism is core's (`lib/plugin-takeover.ts`, shared with Excalidraw); the answer is the
// setting `spellcheck.provider-with-languagetool`, changeable in Settings > Spelling.
import { useEffect } from "react";
import { subscribeCommunityPlugins } from "@/lib/community-plugins";
import { offerTakeover } from "@/lib/plugin-takeover";
import { chooseAction } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settings-store";
import {
  KEYS,
  LANGUAGETOOL_PLUGIN_ID,
  languageToolChoice,
  type LanguageToolChoice,
} from "../lib/settings";
import { useSpellStore } from "../lib/spell-store";

export const CHOICE_ORDER: readonly [LanguageToolChoice, LanguageToolChoice, LanguageToolChoice] = [
  "writer",
  "languagetool",
  "both",
];

export async function offerLanguageToolChoice(): Promise<void> {
  await offerTakeover<LanguageToolChoice>({
    pluginId: LANGUAGETOOL_PLUGIN_ID,
    scope: "spellcheck",
    remembered: () => {
      const choice = languageToolChoice();
      return choice === "ask" ? null : choice;
    },
    remember: (answer) => {
      void useSettingsStore.getState().setSetting(KEYS.languageTool, answer);
      useSpellStore.getState().bump();
    },
    ask: async () =>
      CHOICE_ORDER[
        await chooseAction(
          "The LanguageTool plugin is on. Writer now checks spelling and grammar itself, on this computer. Which checker should run?",
          "Spelling and grammar",
          ["Writer's checker", "LanguageTool plugin", "Both"],
        )
      ],
    // choosing Writer's checker turns the plugin off in Writer; Obsidian is not affected
    turnsPluginOff: (answer) => answer === "writer",
  });
}

export default function LanguageToolChoice() {
  useEffect(() => {
    void offerLanguageToolChoice();
    return subscribeCommunityPlugins(() => void offerLanguageToolChoice());
  }, []);
  return null;
}
