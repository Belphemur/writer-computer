// Obsidian's public CSS variable names (the ones the developer docs list and plugin stylesheets
// build on, e.g. `var(--size-4-4)`, `var(--text-muted)`), mapped onto Writer's own theme tokens.
// Values are Writer's, chosen from the variable names only; nothing here comes from Obsidian's
// stylesheet. Without them plugin CSS collapses (unsized icons, transparent surfaces).
// Installed while at least one plugin is loaded, like the DOM helpers.

/** One row per variable: [name, value, darkValue?]. `value` applies in both modes unless a dark
 *  value is given. Writer's own tokens (`--bg-base`, `--fg-base`, `--accent`, ...) are pushed per
 *  theme by `lib/theme.ts`, so mapping onto them already follows light and dark; a dark value is
 *  only for things that are literal colors or alphas. */
export type ThemeVariable = readonly [name: string, value: string, dark?: string];

const mix = (pct: number): string => `color-mix(in srgb, var(--fg-base) ${pct}%, var(--bg-base))`;
const BASE_SCALE = [5, 10, 20, 25, 30, 35, 40, 50, 60, 70] as const;
const HUES = {
  red: "229, 72, 77",
  orange: "236, 117, 0",
  yellow: "226, 163, 54",
  green: "48, 164, 108",
  cyan: "0, 162, 199",
  blue: "62, 99, 221",
  purple: "142, 78, 198",
  pink: "214, 64, 159",
} as const;

export const OBSIDIAN_VARIABLES: readonly ThemeVariable[] = [
  ["--size-2-1", "2px"],
  ["--size-2-2", "4px"],
  ["--size-2-3", "6px"],
  ["--size-4-1", "4px"],
  ["--size-4-2", "8px"],
  ["--size-4-3", "12px"],
  ["--size-4-4", "16px"],
  ["--size-4-5", "20px"],
  ["--size-4-6", "24px"],
  ["--size-4-8", "32px"],
  ["--size-4-9", "36px"],
  ["--size-4-12", "48px"],
  ["--icon-xs", "14px"],
  ["--icon-s", "16px"],
  ["--icon-m", "18px"],
  ["--icon-l", "20px"],
  ["--icon-xl", "24px"],
  ["--icon-stroke", "2px"],
  ["--icon-opacity", "0.85"],
  ["--icon-color", "var(--text-muted)"],
  ["--icon-color-hover", "var(--text-muted)"],
  ["--icon-color-active", "var(--text-accent)"],
  ["--icon-color-focused", "var(--text-normal)"],
  ["--clickable-icon-radius", "4px"],
  ["--radius-s", "4px"],
  ["--radius-m", "8px"],
  ["--radius-l", "10px"],
  ["--radius-xl", "16px"],
  ["--border-width", "1px"],
  ["--divider-color", "var(--border-color)"],
  ["--divider-width", "1px"],
  ["--input-height", "30px"],
  ["--input-radius", "5px"],
  ["--input-border-width", "1px"],
  ["--font-ui-smaller", "12px"],
  ["--font-ui-small", "13px"],
  ["--font-ui-medium", "15px"],
  ["--font-ui-large", "20px"],
  ["--font-ui-larger", "22px"],
  ["--font-smallest", "0.8em"],
  ["--font-smaller", "0.875em"],
  ["--font-small", "0.933em"],
  ["--font-normal", "1em"],
  ["--font-text-size", "16px"],
  ["--font-medium", "500"],
  ["--font-semibold", "600"],
  ["--font-bold", "700"],
  ["--default-font", "var(--ui-font)"],
  ["--font-interface", "var(--ui-font)"],
  ["--font-interface-theme", "var(--ui-font)"],
  ["--font-text", "var(--editor-font)"],
  ["--font-text-theme", "var(--editor-font)"],
  ["--font-monospace", "var(--mono-font)"],
  ["--font-monospace-theme", "var(--mono-font)"],
  ["--line-height-normal", "1.5"],
  ["--line-height-tight", "1.3"],
  ["--p-spacing", "1rem"],
  ["--file-line-width", "700px"],
  ["--file-margins", "1rem"],
  ["--layer-popover", "30"],
  ["--layer-modal", "50"],
  ["--cursor-link", "pointer"],
  ["--keyboard-height", "0px"],
  ["--safe-area-inset-bottom", "0px"],
  ["--view-bottom-spacing", "0px"],

  // The base scale runs from the app background (00) to the foreground (100) in both modes.
  ["--color-base-00", "var(--bg-base)"],
  ...BASE_SCALE.map((n): ThemeVariable => [`--color-base-${String(n).padStart(2, "0")}`, mix(n)]),
  ["--color-base-100", "var(--fg-base)"],
  ["--color-accent", "var(--accent)"],
  ["--color-accent-1", "color-mix(in srgb, var(--accent) 85%, white)"],
  ["--color-accent-2", "color-mix(in srgb, var(--accent) 70%, white)"],
  ...Object.entries(HUES).flatMap(([hue, rgb]): ThemeVariable[] => [
    [`--color-${hue}`, `rgb(${rgb})`],
    [`--color-${hue}-rgb`, rgb],
  ]),
  ["--callout-warning", "236, 117, 0"],

  ["--background-primary", "var(--bg-base)"],
  ["--background-primary-alt", mix(4)],
  ["--background-secondary", mix(6)],
  ["--background-secondary-alt", mix(8)],
  ["--background-modifier-border", "var(--border-color)"],
  ["--background-modifier-border-hover", "var(--focus-border)"],
  ["--background-modifier-border-focus", "var(--focus-border)"],
  ["--background-modifier-hover", "var(--item-hover-bg)"],
  ["--background-modifier-active-hover", "var(--item-active-bg)"],
  ["--background-modifier-form-field", mix(6)],
  ["--background-modifier-message", mix(12)],
  ["--background-modifier-cover", "color-mix(in srgb, var(--bg-base) 60%, transparent)"],
  ["--background-modifier-box-shadow", "rgb(0 0 0 / 10%)", "rgb(0 0 0 / 30%)"],
  ["--background-modifier-error-rgb", "229, 72, 77"],
  ["--background-modifier-error", "rgb(var(--background-modifier-error-rgb))"],
  [
    "--background-modifier-error-hover",
    "color-mix(in srgb, var(--background-modifier-error) 85%, white)",
  ],
  ["--background-modifier-success", "#30a46c"],

  ["--text-normal", "var(--text-primary)"],
  // --text-muted is not listed: Writer's token of the same name already has the same meaning.
  ["--text-faint", "var(--text-icon-muted)"],
  ["--text-on-accent", "#fff"],
  ["--text-on-accent-inverted", "#000"],
  ["--text-accent", "var(--accent)"],
  ["--text-accent-hover", "color-mix(in srgb, var(--accent) 85%, white)"],
  ["--text-selection", "var(--editor-selection-bg)"],
  ["--text-highlight-bg", "rgb(255 208 0 / 40%)", "rgb(255 208 0 / 25%)"],
  ["--text-error", "#e5484d", "#ff6369"],
  ["--text-warning", "#e08a00", "#ffb224"],
  ["--text-success", "#30a46c", "#3dd68c"],

  ["--interactive-normal", mix(8)],
  ["--interactive-hover", mix(12)],
  ["--interactive-accent", "var(--accent)"],
  ["--interactive-accent-hover", "color-mix(in srgb, var(--accent) 85%, white)"],
  ["--interactive-accent-hsl", "25, 100%, 50%"],

  [
    "--shadow-s",
    "0 1px 2px rgb(0 0 0 / 8%), 0 1px 3px rgb(0 0 0 / 6%)",
    "0 1px 3px rgb(0 0 0 / 40%)",
  ],
  [
    "--shadow-l",
    "0 8px 24px rgb(0 0 0 / 14%), 0 2px 6px rgb(0 0 0 / 8%)",
    "0 12px 32px rgb(0 0 0 / 50%), 0 2px 6px rgb(0 0 0 / 30%)",
  ],

  ["--scrollbar-bg", "transparent"],
  ["--scrollbar-thumb-bg", "var(--scrollbar-thumb)"],
  ["--scrollbar-active-thumb-bg", "var(--scrollbar-thumb)"],

  ["--code-background", "var(--code-bg)"],
  ["--code-normal", "var(--text-secondary)"],
  ["--dropdown-background", "var(--surface-input)"],
  ["--checkbox-size", "16px"],
  ["--toggle-s-width", "36px"],
  ["--toggle-s-thumb-width", "15px"],
  ["--toggle-s-thumb-height", "15px"],
  ["--toggle-s-border-width", "2px"],
  ["--toggle-radius", "18px"],
  ["--toggle-thumb-radius", "18px"],
  ["--toggle-thumb-color", "#fff"],
  ["--table-header-weight", "600"],
  ["--table-header-background", "transparent"],
  ["--table-border-width", "1px"],
  ["--table-border-color", "var(--border-color)"],
];

const declarations = (rows: readonly (readonly [string, string])[]): string =>
  rows.map(([name, value]) => `  ${name}: ${value};`).join("\n");

const VARIABLES_CSS = `:root {
${declarations(OBSIDIAN_VARIABLES.map(([name, value]) => [name, value]))}
}
:root[data-theme="dark"] {
${declarations(OBSIDIAN_VARIABLES.flatMap(([name, , dark]) => (dark === undefined ? [] : [[name, dark] as const])))}
}
`;

/** Class names plugins build on for `Menu` (api/ui.ts). In the `components` layer, below the
 *  plugins layer, so a plugin's own `.menu-item` rules still win. */
const MENU_CSS = `@layer components {
.menu {
  box-sizing: border-box; min-width: 180px; max-width: 360px; padding: var(--size-2-3);
  background: var(--background-secondary); color: var(--text-normal);
  border: var(--border-width) solid var(--background-modifier-border);
  border-radius: var(--radius-m); box-shadow: var(--shadow-l);
  font-family: var(--font-interface); font-size: var(--font-ui-small); line-height: var(--line-height-tight);
  cursor: default; user-select: none; -webkit-user-select: none; outline: none;
}
.menu-item {
  display: flex; align-items: center; gap: var(--size-4-2); position: relative;
  padding: var(--size-2-3) var(--size-4-2); border-radius: var(--radius-s); cursor: pointer;
}
.menu-item-icon {
  display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: var(--icon-s); height: var(--icon-s); color: var(--icon-color);
}
.menu-item-icon > svg { width: 100%; height: 100%; }
.menu.no-icon .menu-item-icon { display: none; }
.menu-item-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.menu-item:hover, .menu-item.is-selected { background: var(--background-modifier-hover); }
.menu-item.is-disabled { opacity: 0.5; cursor: default; background: none; }
.menu-item.is-label { color: var(--text-muted); cursor: default; background: none; }
.menu-item.is-warning, .menu-item.is-warning .menu-item-icon { color: var(--text-error); }
.menu-item.is-checked::after { content: "\\2713"; margin-left: auto; color: var(--text-accent); }
.menu-item.has-submenu::after { content: "\\203A"; margin-left: auto; color: var(--text-muted); }
.menu-separator {
  height: var(--border-width); margin: var(--size-2-3) calc(var(--size-2-3) * -1);
  background: var(--background-modifier-border);
}
}
`;

/** CodeMirror's base theme paints every `.cm-tooltip` light (`background #f5f5f5; border #bbb`) from
 *  an unlayered sheet injected at runtime, which beats the `plugins` layer whatever the plugin's own
 *  specificity. A plugin tooltip (LanguageTool's suggestion card sets `background-color:
 *  var(--background-primary)` and inherits Writer's near-white text) therefore got white text on a
 *  light surface. Give plugin tooltips Writer's surface and text color; the doubled class outranks
 *  CodeMirror's `.ͼ2 .cm-tooltip`. Writer's own autocomplete tooltip has its own rule (App.css). */
const TOOLTIP_SURFACE_CSS = `.cm-tooltip.cm-tooltip:not(.cm-tooltip-autocomplete) {
  background-color: var(--background-secondary);
  color: var(--text-normal);
  border-color: var(--background-modifier-border);
}
`;

export const OBSIDIAN_THEME_CSS =
  VARIABLES_CSS +
  MENU_CSS +
  TOOLTIP_SURFACE_CSS +
  `
/* View structure: .workspace-leaf > .workspace-leaf-content[data-type] > .view-header + .view-content.
   The pane gives the leaf a definite height; every level is a flex column with min-height: 0 so a
   plugin's own flex layout (header / scroller / input pinned at the bottom) and \`height: 100%\`
   children resolve. :where() keeps specificity at zero so plugin stylesheets win. */
:where(.workspace-leaf) { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
:where(.workspace-leaf-content) { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; }
:where(.workspace-leaf-content > .view-header) { flex: 0 0 auto; }
:where(.workspace-leaf-content > .view-content) { flex: 1 1 auto; min-height: 0; min-width: 0; position: relative; overflow: auto; }

/* Modal frame (api/ui.ts Modal). The host owns the layout: without it \`.modal-container\` is a
   static block appended after the app and a plugin's Configure / Install dialogs open off-screen. */
.modal-container {
  position: fixed; inset: 0; z-index: 9000;
  display: flex; align-items: center; justify-content: center;
}
.modal-container > .modal-bg {
  position: absolute; inset: 0; background: rgb(0 0 0 / 50%);
}
.modal-container > .modal {
  position: relative; box-sizing: border-box;
  display: flex; flex-direction: column;
  width: 540px; min-width: 300px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 2rem);
  padding: var(--size-4-4); overflow: auto;
  background: var(--background-primary); color: var(--text-normal);
  border: var(--border-width) solid var(--background-modifier-border);
  border-radius: var(--radius-xl); box-shadow: 0 12px 40px rgb(0 0 0 / 40%);
  font-size: var(--font-ui-medium);
}
.modal-container .modal-close-button {
  position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: var(--text-muted);
}
.modal-container .modal-close-button::before { content: "\\00d7"; font-size: 20px; line-height: 1; }
.modal-container .modal-title { font-size: var(--font-ui-larger); font-weight: var(--font-semibold); }
.modal-container .modal-title:empty { display: none; }
.modal-container .modal-content { min-height: 0; flex: 1 1 auto; }

/* Rendered markdown (api/markdown-render.ts). Scoped under .markdown-rendered so plugin UI
   outside it is untouched; Writer tokens only. */
.markdown-rendered { overflow-wrap: anywhere; line-height: var(--line-height-normal); white-space: normal; }
/* Tailwind preflight (App.css) zeroes margins and list styles on bare elements; restore the
   reading-view rhythm, keyed to the Obsidian variable --p-spacing. */
.markdown-rendered p { margin: 0 0 var(--p-spacing); }
.markdown-rendered ul, .markdown-rendered ol { margin: 0 0 var(--p-spacing); padding-inline-start: 1.6em; }
.markdown-rendered ul { list-style: disc; }
.markdown-rendered ol { list-style: decimal; }
.markdown-rendered ul ul, .markdown-rendered ol ol, .markdown-rendered ul ol, .markdown-rendered ol ul { margin-bottom: 0; }
.markdown-rendered li { margin: 0; }
.markdown-rendered li > p { margin-bottom: var(--size-4-1); }
.markdown-rendered ul:has(> li.task-list-item), .markdown-rendered ul.contains-task-list { list-style: none; padding-inline-start: 0; }
.markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3, .markdown-rendered h4, .markdown-rendered h5, .markdown-rendered h6 { margin: 1.2em 0 0.5em; font-weight: var(--font-semibold); line-height: var(--line-height-tight); }
.markdown-rendered h1 { font-size: 1.6em; } .markdown-rendered h2 { font-size: 1.4em; } .markdown-rendered h3 { font-size: 1.2em; }
.markdown-rendered h4, .markdown-rendered h5, .markdown-rendered h6 { font-size: 1em; }
.markdown-rendered hr { border: 0; border-top: var(--border-width) solid var(--background-modifier-border); margin: var(--size-4-4) 0; }
.markdown-rendered pre, .markdown-rendered blockquote, .markdown-rendered table { margin: 0 0 var(--p-spacing); }
.markdown-rendered pre { white-space: pre; }
.markdown-rendered strong { font-weight: var(--font-bold); } .markdown-rendered em { font-style: italic; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered > :last-child { margin-bottom: 0; }
.markdown-rendered a.internal-link, .markdown-rendered a.external-link { color: var(--text-accent); cursor: var(--cursor-link); text-decoration: none; }
.markdown-rendered a.internal-link:hover, .markdown-rendered a.external-link:hover { text-decoration: underline; }
.markdown-rendered a.internal-link.is-unresolved { opacity: 0.6; text-decoration: underline dotted; }
.markdown-rendered a.tag { color: var(--text-accent); background: var(--background-modifier-hover); border-radius: var(--radius-m); padding: 0 var(--size-4-2); text-decoration: none; }
.markdown-rendered mark { background: color-mix(in srgb, rgb(var(--color-yellow-rgb)) 35%, transparent); color: inherit; border-radius: 2px; }
.markdown-rendered code { background: var(--code-background); border-radius: var(--radius-s); padding: 0.1em 0.35em; font-size: 0.9em; }
.markdown-rendered pre { background: var(--code-background); border-radius: var(--radius-m); padding: var(--size-4-3); overflow-x: auto; }
.markdown-rendered pre code { background: none; padding: 0; }
.markdown-rendered table { border-collapse: collapse; }
.markdown-rendered th, .markdown-rendered td { border: var(--table-border-width) solid var(--table-border-color); padding: var(--size-2-2) var(--size-4-2); }
.markdown-rendered th { font-weight: var(--table-header-weight); }
.markdown-rendered blockquote { margin-left: 0; padding-left: var(--size-4-3); border-left: 3px solid var(--background-modifier-border); color: var(--text-muted); }
.markdown-rendered img { max-width: 100%; }
.markdown-rendered .math { font-family: var(--font-monospace, monospace); }
.markdown-rendered .math-block { display: block; text-align: center; margin: var(--size-4-2) 0; }
/* Callouts (.callout inside .markdown-rendered): src/lib/callouts/callouts.css */
.markdown-rendered .markdown-embed { border-left: 2px solid var(--background-modifier-border); padding-left: var(--size-4-3); margin: var(--size-4-2) 0; }
.markdown-rendered .internal-embed.is-unresolved { color: var(--text-faint); }
.markdown-rendered input.task-list-item-checkbox { margin-right: var(--size-2-3); }
`;

/** Plugins key rules on `body.theme-dark` / `body.theme-light`; mirror Writer's `html[data-theme]`. */
function mirrorThemeClass(doc: Document): () => void {
  const root = doc.documentElement;
  const sync = (): void => {
    const dark = root.getAttribute("data-theme") === "dark";
    doc.body.classList.toggle("theme-dark", dark);
    doc.body.classList.toggle("theme-light", !dark);
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    observer.disconnect();
    doc.body.classList.remove("theme-dark", "theme-light");
  };
}

/** Adds the variable sheet once; returns the remover. */
export function installObsidianTheme(doc: Document = document): () => void {
  const existing = doc.querySelector("style[data-writer-obsidian-theme]");
  if (existing) return () => {};
  const el = doc.createElement("style");
  el.dataset.writerObsidianTheme = "";
  el.textContent = OBSIDIAN_THEME_CSS;
  doc.head.appendChild(el);
  const unmirror = mirrorThemeClass(doc);
  return () => {
    unmirror();
    el.remove();
  };
}
