// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { OBSIDIAN_THEME_CSS, installObsidianTheme } from "../web/host/api/theme-compat";

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
