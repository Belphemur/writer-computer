// The project accent colors: `shared/project-colors.json` is the one list (names plus a light and
// a dark value each); the theme applier turns the active mode's values into the
// `--project-color-<name>` variables the agent's icon and swatches read.
// @vitest-environment jsdom
import projectColors from "@shared/project-colors.json";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { applyProjectColors, applyTheme } from "@/lib/theme";

const HEX = /^#[0-9a-f]{6}$/i;
const varOf = (name: string) =>
  document.documentElement.style.getPropertyValue(`--project-color-${name}`);

afterEach(() => document.documentElement.removeAttribute("style"));

describe("project colors", () => {
  it("name each color once and give it a light and a dark value", () => {
    const names = projectColors.colors.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
    for (const c of projectColors.colors) {
      expect(c.light, c.name).toMatch(HEX);
      expect(c.dark, c.name).toMatch(HEX);
    }
  });

  it("set one variable per color for the active mode", () => {
    applyProjectColors("dark");
    for (const c of projectColors.colors) expect(varOf(c.name)).toBe(c.dark);
    applyProjectColors("light");
    for (const c of projectColors.colors) expect(varOf(c.name)).toBe(c.light);
  });

  it("follow the theme the app applies", () => {
    applyTheme("light", {});
    expect(varOf("blue")).toBe(projectColors.colors.find((c) => c.name === "blue")!.light);
    applyTheme("dark", {});
    expect(varOf("blue")).toBe(projectColors.colors.find((c) => c.name === "blue")!.dark);
  });
});
