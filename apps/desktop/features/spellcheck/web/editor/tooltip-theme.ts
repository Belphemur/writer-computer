// The look of the spelling and grammar tooltip: a compact opaque card (design.md section 5), the
// editor's UI size, no wider than 320px, with theme tokens only. It is still CodeMirror's lint
// tooltip (no new overlay layer, design.md section 4). `!important` on the surface because
// `@codemirror/view`'s base theme paints `.cm-tooltip` after the app stylesheet.
import { EditorView } from "@codemirror/view";

export const spellTooltipTheme = EditorView.baseTheme({
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
  ".cm-spell-card": { display: "flex", flexDirection: "column", gap: "6px" },
  // `source` carries the kind and rule for grouping (`encodeSource`); the card title already
  // names the kind, so CodeMirror's printed source line is hidden on our cards.
  ".cm-diagnostic:has(.cm-spell-card) .cm-diagnosticSource": { display: "none" },
  ".cm-spell-head": { display: "flex", alignItems: "center", gap: "6px" },
  ".cm-spell-kind": { display: "inline-flex", flex: "none" },
  ".cm-spell-kind-warning": { color: "var(--warning)" },
  ".cm-spell-kind-info": { color: "var(--accent)" },
  ".cm-spell-kind-error": { color: "var(--danger)" },
  ".cm-spell-title": { fontWeight: "600", letterSpacing: "-0.01em" },
  ".cm-spell-message": { color: "var(--text-secondary)", overflowWrap: "anywhere" },
  ".cm-spell-actions": { display: "flex", flexWrap: "wrap", gap: "4px", paddingTop: "2px" },
  ".cm-spell-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    font: "inherit",
    fontSize: "12px",
    lineHeight: "20px",
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    borderRadius: "6px",
    cursor: "pointer",
  },
  ".cm-spell-chip:first-child": {
    background: "color-mix(in srgb, var(--accent) 20%, transparent)",
    fontWeight: "600",
  },
  ".cm-spell-chip:hover, .cm-spell-chip:focus-visible": {
    background: "color-mix(in srgb, var(--accent) 32%, transparent)",
    outline: "none",
  },
  ".cm-spell-chip-secondary": {
    color: "var(--text-muted)",
    background: "transparent",
    borderColor: "var(--border-color)",
    fontWeight: "400",
  },
  ".cm-spell-chip-secondary:hover, .cm-spell-chip-secondary:focus-visible": {
    color: "var(--text-primary)",
    background: "var(--surface-subtle)",
  },
  ".cm-lintRange-warning:hover": {
    background: "color-mix(in srgb, var(--warning) 14%, transparent)",
  },
  ".cm-lintRange-info:hover": {
    background: "color-mix(in srgb, var(--accent) 12%, transparent)",
  },
});
