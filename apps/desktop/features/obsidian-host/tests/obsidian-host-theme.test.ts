// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vite-plus/test";
import {
  OBSIDIAN_THEME_CSS,
  OBSIDIAN_VARIABLES,
  installObsidianTheme,
} from "../web/host/api/theme-compat";

const appCss = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");
/** Tokens Writer itself defines (App.css `:root`), pushed per theme by lib/theme.ts. */
const writerTokens = new Set([...appCss.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));
const tableNames = new Set(OBSIDIAN_VARIABLES.map(([n]) => n));
const block = (selector: string): string => {
  const start = OBSIDIAN_THEME_CSS.indexOf(`${selector} {`);
  return OBSIDIAN_THEME_CSS.slice(start, OBSIDIAN_THEME_CSS.indexOf("\n}", start));
};

describe("Obsidian theme variables", () => {
  it("installs once and removes cleanly", () => {
    const off = installObsidianTheme(document);
    const off2 = installObsidianTheme(document);
    expect(document.querySelectorAll("style[data-writer-obsidian-theme]")).toHaveLength(1);
    off2(); // second install is a no-op remover
    expect(document.querySelectorAll("style[data-writer-obsidian-theme]")).toHaveLength(1);
    off();
    expect(document.querySelectorAll("style[data-writer-obsidian-theme]")).toHaveLength(0);
  });

  it("never defines a variable in terms of itself", () => {
    for (const m of OBSIDIAN_THEME_CSS.matchAll(/(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)/g))
      expect(m[1]).not.toBe(m[2]);
  });

  it("defines the size scale plugins rely on", () => {
    expect(OBSIDIAN_THEME_CSS).toContain("--size-4-4: 16px");
  });

  it("lays modals out as a fixed, centred overlay (a plugin's Configure dialog must be visible)", () => {
    const block = /\.modal-container \{([^}]*)\}/.exec(OBSIDIAN_THEME_CSS)?.[1] ?? "";
    expect(block).toContain("position: fixed");
    expect(block).toContain("inset: 0");
    expect(block).toMatch(/z-index: \d+/);
    expect(OBSIDIAN_THEME_CSS).toContain(".modal-container > .modal-bg");
    expect(OBSIDIAN_THEME_CSS).toContain(".modal-container > .modal {");
  });
});

describe("Obsidian variable mapping (one table)", () => {
  it("has no duplicate names", () => {
    expect(tableNames.size).toBe(OBSIDIAN_VARIABLES.length);
  });

  it("defines every table variable in the light/default block", () => {
    const light = block(":root");
    for (const [name, value] of OBSIDIAN_VARIABLES)
      expect(light, name).toContain(`${name}: ${value};`);
  });

  it("defines every dark override in the dark block, and only those", () => {
    const dark = block(':root[data-theme="dark"]');
    const overrides = OBSIDIAN_VARIABLES.filter(([, , d]) => d !== undefined);
    expect(overrides.length).toBeGreaterThan(0);
    for (const [name, , d] of overrides) expect(dark, name).toContain(`${name}: ${d};`);
    expect([...dark.matchAll(/^\s+(--[a-z0-9-]+):/gm)]).toHaveLength(overrides.length);
  });

  it("every var() a value uses resolves to the table or to a Writer token", () => {
    const known = new Set([...tableNames, ...writerTokens]);
    for (const [name, value, dark] of OBSIDIAN_VARIABLES)
      for (const m of `${value} ${dark ?? ""}`.matchAll(/var\((--[a-z0-9-]+)/g))
        expect(known.has(m[1]!), `${name} uses undefined ${m[1]}`).toBe(true);
  });

  it("covers the public variables the LanguageTool plugin's stylesheet reads", () => {
    // From the plugin's published styles.css. --text-muted is Writer's own token of that name.
    const used = [
      "--background-modifier-border",
      "--background-primary",
      "--default-font",
      "--layer-popover",
      "--size-4-2",
      "--text-error",
      "--text-faint",
      "--text-muted",
    ];
    for (const v of used) expect(tableNames.has(v) || writerTokens.has(v), v).toBe(true);
  });

  it("covers the documented background, text, interactive and font groups", () => {
    for (const n of [
      "--background-primary",
      "--background-primary-alt",
      "--background-secondary",
      "--background-secondary-alt",
      "--background-modifier-border",
      "--background-modifier-hover",
      "--background-modifier-form-field",
      "--background-modifier-cover",
      "--background-modifier-box-shadow",
      "--text-normal",
      "--text-faint",
      "--text-on-accent",
      "--text-accent",
      "--text-selection",
      "--text-error",
      "--text-warning",
      "--text-success",
      "--interactive-normal",
      "--interactive-hover",
      "--interactive-accent",
      "--interactive-accent-hover",
      "--color-base-00",
      "--color-base-100",
      "--font-interface",
      "--font-text",
      "--font-monospace",
      "--icon-color",
      "--shadow-s",
      "--shadow-l",
    ])
      expect(tableNames.has(n), n).toBe(true);
    expect(writerTokens.has("--text-muted")).toBe(true);
  });

  it("builds the base scale from Writer's own bg and fg tokens, so it follows both themes", () => {
    const base = Object.fromEntries(OBSIDIAN_VARIABLES.map(([n, v]) => [n, v]));
    expect(base["--color-base-00"]).toBe("var(--bg-base)");
    expect(base["--color-base-100"]).toBe("var(--fg-base)");
    expect(base["--color-base-50"]).toContain("var(--fg-base) 50%");
    expect(base["--background-primary"]).toBe("var(--bg-base)");
    expect(base["--text-normal"]).toBe("var(--text-primary)");
  });

  it("mirrors html[data-theme] as body.theme-dark / theme-light and cleans up", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const off = installObsidianTheme(document);
    expect(document.body.classList.contains("theme-dark")).toBe(true);
    expect(document.body.classList.contains("theme-light")).toBe(false);
    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(document.body.classList.contains("theme-light")).toBe(true);
    expect(document.body.classList.contains("theme-dark")).toBe(false);
    off();
    expect(document.body.classList.contains("theme-light")).toBe(false);
    document.documentElement.removeAttribute("data-theme");
  });
});

describe("Menu and plugin-layer styles", () => {
  it("styles the documented menu classes in the components layer, below plugins", () => {
    const start = OBSIDIAN_THEME_CSS.indexOf("@layer components {");
    expect(start).toBeGreaterThan(-1);
    const menu = OBSIDIAN_THEME_CSS.slice(
      start,
      OBSIDIAN_THEME_CSS.indexOf(".lt-predictions-container-glass", start),
    );
    for (const cls of [
      ".menu {",
      ".menu-item {",
      ".menu-item-icon {",
      ".menu-item-title {",
      ".menu-separator {",
    ])
      expect(menu, cls).toContain(cls);
    expect(menu).toContain("var(--background-secondary)");
  });

  it("keeps the layered-plugin contract: the host's rules are not wrapped in the plugins layer and add no global .hidden", () => {
    expect(OBSIDIAN_THEME_CSS).not.toContain("@layer plugins");
    expect(OBSIDIAN_THEME_CSS).not.toMatch(/(^|[\s,}])\.hidden\s*[{,]/);
  });

  it("makes LanguageTool's glass popup opaque enough to read, with theme text color", () => {
    const rule = /\.lt-predictions-container-glass \{([^}]*)\}/.exec(OBSIDIAN_THEME_CSS)?.[1] ?? "";
    expect(rule).toContain("var(--background-primary)");
    expect(rule).toContain("color: var(--text-normal)");
  });
});
