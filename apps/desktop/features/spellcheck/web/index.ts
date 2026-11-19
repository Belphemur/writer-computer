// The spellcheck feature (spec `SPECs/spellcheck-spec.md`, ADR 2026-11-18 "check spelling and
// grammar locally with Harper, Hunspell dictionaries and lingua"): underlines in the editor, the
// language item in the footer, the Settings > Spelling page and the one-time LanguageTool
// question. The checking is the Rust half (`../rust/`, the engine in `crate::spellcheck`). This
// file is loaded at startup, so it imports only `defineFeature`, the manifest and `import()`
// thunks: the linter, the status item and the page are lazy chunks.
import { openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

export const SPELLING_SECTION_ID = "spellcheck";

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands: [
      {
        id: "spellcheck.settings",
        label: "Spelling settings",
        description: "Languages, dictionary and checks",
        when: (ctx) => ctx.hasWorkspace && !ctx.isCompactFileMode,
        run: () => openSettings(SPELLING_SECTION_ID),
      },
    ],
    editorExtensions: [
      { id: "spellcheck.linter", load: () => import("./editor/linter").then((m) => m.default()) },
    ],
    statusItems: [
      {
        id: "spellcheck.language",
        order: 20,
        load: () => import("./components/language-status").then((m) => m.default),
      },
    ],
    overlays: [
      {
        id: "spellcheck.languagetool-choice",
        load: () => import("./components/languagetool-choice").then((m) => m.default),
      },
    ],
    settingsSection: {
      id: SPELLING_SECTION_ID,
      label: "Spelling",
      order: 42,
      load: () =>
        import("./components/spelling-section").then((m) => ({ default: m.SpellingSection })),
    },
  },
});
