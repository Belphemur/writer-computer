// The Markdown lint feature (spec `SPECs/markdown-lint-spec.md`, ADR 2026-11-19 "lint Markdown
// with rumdl in a built-in lint feature, safe fixes on save"): warnings in the editor with a Fix
// action, safe fixes when a note is saved, the "Fix Markdown formatting" command and the
// Settings > Lint page. The linting is the Rust half (`../rust/`, the engine in `crate::lint`).
// This file is loaded at startup, so it imports only `defineFeature`, the manifest and `import()`
// thunks: the linter, the fix code and the page are lazy chunks.
import { openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";

export const LINT_SECTION_ID = "lint";

const fixModule = () => import("./lib/fix");
const hasNote = (c: { hasWorkspace: boolean; isCompactFileMode: boolean }) =>
  c.hasWorkspace && !c.isCompactFileMode;

export default defineFeature({
  id: manifest.id,
  contributes: {
    commands: [
      {
        id: "lint.fix-all",
        label: "Fix Markdown formatting",
        description: "Fix every lint warning in the note",
        when: (ctx) =>
          hasNote(ctx) &&
          ctx.activeFilePath !== null &&
          /\.(md|markdown)$/i.test(ctx.activeFilePath),
        run: async () => {
          const [{ findEditorView }, { getActiveFilePath }, { fixView }] = await Promise.all([
            import("@/lib/editor-views"),
            import("@/hooks/editor-api"),
            fixModule(),
          ]);
          const view = findEditorView(getActiveFilePath());
          if (view) await fixView(view, "all");
        },
      },
      {
        id: "lint.settings",
        label: "Lint settings",
        description: "Choose the rules",
        when: hasNote,
        run: () => openSettings(LINT_SECTION_ID),
      },
    ],
    editorExtensions: [
      { id: "lint.linter", load: () => import("./editor/linter").then((m) => m.default()) },
    ],
    beforeSave: [
      { id: "lint.fix-on-save", run: (path) => fixModule().then((m) => m.fixOnSave(path)) },
    ],
    settingsSection: {
      id: LINT_SECTION_ID,
      label: "Lint",
      order: 43,
      load: () => import("./components/lint-section").then((m) => ({ default: m.LintSection })),
    },
  },
});
