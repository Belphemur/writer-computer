// The hotkeys feature (SPECs/hotkeys-spec.md): the Settings > Hotkeys page and its palette command.
// The keys themselves (registry, overrides, `hotkeys.json`) are core and stay in force with the
// feature off. Import-light: the page is a lazy chunk.
import { openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

export const HOTKEYS_SECTION_ID = "hotkeys";

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands: manifest.contributes.commands.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      when: (ctx: { isCompactFileMode: boolean }) => !ctx.isCompactFileMode,
      run: () => openSettings(HOTKEYS_SECTION_ID),
    })),
    settingsSection: {
      id: HOTKEYS_SECTION_ID,
      label: "Hotkeys",
      order: 45,
      load: () => import("./hotkeys-section").then((m) => ({ default: m.HotkeysSection })),
    },
  },
});
