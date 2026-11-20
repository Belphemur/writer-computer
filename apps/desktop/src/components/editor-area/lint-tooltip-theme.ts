// The surface of CodeMirror's lint tooltip, shared by every feature that draws diagnostics
// (spelling, lint): a compact opaque card (design.md section 5), the editor's UI size, no wider
// than 320px, theme tokens only. It is still the library's tooltip (no new overlay layer,
// design.md section 4). `!important` on the surface because `@codemirror/view`'s base theme
// paints `.cm-tooltip` after the app stylesheet. A feature adds its own card content rules.
import { EditorView } from "@codemirror/view";

export const lintTooltipTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-lint": {
    background: "var(--bg-base) !important",
    border: "1px solid var(--border-color) !important",
    borderRadius: "10px !important",
    boxShadow: "0 8px 24px color-mix(in srgb, var(--fg-base) 16%, transparent)",
    maxWidth: "320px",
    overflow: "hidden",
  },
  ".cm-tooltip-lint .cm-diagnostic": {
    padding: "8px 10px",
    margin: "0",
    borderLeft: "none",
    fontSize: "13px",
    lineHeight: "1.4",
    color: "var(--text-primary)",
  },
});
