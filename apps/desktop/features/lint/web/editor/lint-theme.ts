// The look of the lint warning card; the tooltip surface is core's shared `lintTooltipTheme`.
import { EditorView } from "@codemirror/view";
import { lintTooltipTheme } from "@/components/editor-area/lint-tooltip-theme";

const lintCardTheme = EditorView.baseTheme({
  ".cm-lint-card": { display: "flex", flexDirection: "column", gap: "4px" },
  // `source` carries the rule id for the library; the card title already shows it
  ".cm-diagnostic:has(.cm-lint-card) .cm-diagnosticSource": { display: "none" },
  ".cm-lint-title": { fontWeight: "600", letterSpacing: "-0.01em" },
  ".cm-lint-message": { color: "var(--text-secondary)", overflowWrap: "anywhere" },
  ".cm-lint-actions": { display: "flex", flexWrap: "wrap", gap: "4px", paddingTop: "2px" },
  ".cm-lint-chip": {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    font: "inherit",
    fontSize: "12px",
    lineHeight: "20px",
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 20%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "600",
  },
  ".cm-lint-chip:hover, .cm-lint-chip:focus-visible": {
    background: "color-mix(in srgb, var(--accent) 32%, transparent)",
    outline: "none",
  },
  ".cm-lint-chip-quiet": {
    color: "var(--text-muted)",
    background: "transparent",
    borderColor: "var(--border-color)",
    fontWeight: "400",
  },
  ".cm-lint-chip-quiet:hover, .cm-lint-chip-quiet:focus-visible": {
    color: "var(--text-primary)",
    background: "var(--surface-subtle)",
  },
});

export const lintTheme = [lintTooltipTheme, lintCardTheme];
