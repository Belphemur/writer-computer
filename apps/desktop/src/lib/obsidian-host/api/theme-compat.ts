// Obsidian's public CSS variable names (the ones the developer docs list and plugin stylesheets
// build on, e.g. `var(--size-4-4)`, `var(--text-muted)`), mapped onto Writer's own theme tokens.
// Values are Writer's, chosen from the variable names only; nothing here comes from Obsidian's
// stylesheet. Without them plugin CSS collapses (unsized icons, transparent surfaces).
// Installed while at least one plugin is loaded, like the DOM helpers.

export const OBSIDIAN_THEME_CSS = `:root {
  --size-2-1: 2px; --size-2-2: 4px; --size-2-3: 6px;
  --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --size-4-4: 16px; --size-4-5: 20px;
  --size-4-6: 24px; --size-4-8: 32px; --size-4-9: 36px; --size-4-12: 48px;
  --icon-xs: 14px; --icon-s: 16px; --icon-m: 18px; --icon-l: 20px;
  --radius-s: 4px; --radius-m: 8px; --radius-l: 10px; --radius-xl: 16px;
  --border-width: 1px;
  --font-ui-smaller: 12px; --font-ui-small: 13px; --font-ui-medium: 15px;
  --font-ui-large: 20px; --font-ui-larger: 22px;
  --font-smallest: 0.8em; --font-smaller: 0.875em; --font-small: 0.933em;
  --font-normal: 1em; --font-text-size: 16px;
  --font-medium: 500; --font-semibold: 600; --font-bold: 700;
  --line-height-normal: 1.5; --line-height-tight: 1.3;
  --p-spacing: 1rem; --file-line-width: 700px; --file-margins: 1rem;
  --layer-popover: 30; --layer-modal: 50; --cursor-link: pointer;
  --keyboard-height: 0px; --safe-area-inset-bottom: 0px; --view-bottom-spacing: 0px;

  --background-primary: var(--bg-base);
  --background-primary-alt: color-mix(in srgb, var(--fg-base) 4%, var(--bg-base));
  --background-secondary: color-mix(in srgb, var(--fg-base) 6%, var(--bg-base));
  --background-secondary-alt: color-mix(in srgb, var(--fg-base) 8%, var(--bg-base));
  --background-modifier-border: var(--border-color);
  --background-modifier-border-hover: var(--focus-border);
  --background-modifier-border-focus: var(--focus-border);
  --background-modifier-hover: var(--item-hover-bg);
  --background-modifier-active-hover: var(--item-active-bg);
  --background-modifier-message: color-mix(in srgb, var(--fg-base) 12%, var(--bg-base));
  --background-modifier-error-rgb: 229, 72, 77;
  --background-modifier-error: rgb(var(--background-modifier-error-rgb));
  --background-modifier-error-hover: color-mix(in srgb, var(--background-modifier-error) 85%, white);
  --background-modifier-success: #30a46c;

  --text-normal: var(--text-primary);
  /* --text-muted: Writer's token of the same name already has the same meaning. */
  --text-faint: var(--text-icon-muted);
  --text-on-accent: #fff;
  --text-accent: var(--accent);
  --text-accent-hover: color-mix(in srgb, var(--accent) 85%, white);
  --text-error: #e5484d; --text-warning: #f5a524; --text-success: #30a46c;

  --interactive-accent: var(--accent);
  --interactive-accent-hover: color-mix(in srgb, var(--accent) 85%, white);
  --interactive-accent-hsl: 25, 100%, 50%;
  --interactive-hover: var(--item-hover-bg);

  --color-base-100: #fff;
  --color-red: #e5484d; --color-red-rgb: 229, 72, 77;
  --color-green: #30a46c; --color-green-rgb: 48, 164, 108;
  --color-blue: #3e63dd; --color-blue-rgb: 62, 99, 221;
  --color-yellow-rgb: 226, 163, 54;
  --callout-warning: 236, 117, 0;

  --code-background: var(--code-bg); --code-normal: var(--text-secondary);
  --dropdown-background: var(--surface-input);
  --checkbox-size: 16px;
  --toggle-s-width: 36px; --toggle-s-thumb-width: 15px; --toggle-s-thumb-height: 15px;
  --toggle-s-border-width: 2px; --toggle-radius: 18px; --toggle-thumb-radius: 18px;
  --toggle-thumb-color: #fff;
  --table-header-weight: 600; --table-header-background: transparent;
  --table-border-width: 1px; --table-border-color: var(--border-color);
}

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
`;

/** Adds the variable sheet once; returns the remover. */
export function installObsidianTheme(doc: Document = document): () => void {
  const existing = doc.querySelector("style[data-writer-obsidian-theme]");
  if (existing) return () => {};
  const el = doc.createElement("style");
  el.dataset.writerObsidianTheme = "";
  el.textContent = OBSIDIAN_THEME_CSS;
  doc.head.appendChild(el);
  return () => el.remove();
}
