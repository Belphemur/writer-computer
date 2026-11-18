// The display options of a surface: defaults (labels on hover, communities, depth 2, property
// edges off), what a hand-edited file normalizes to, and the slice request they imply (a disabled
// edge kind is never asked for).
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CONFIG,
  DEFAULT_DISPLAY,
  DEFAULT_SURFACE,
  clampDepth,
  normalizeConfig,
  parseConfig,
} from "../web/config";
import { sliceArgs } from "../web/use-graph-surface";

describe("defaults", () => {
  it("labels on hover, communities, depth 2, property edges off", () => {
    expect(DEFAULT_DISPLAY).toEqual({
      labels: "hover",
      clusterBy: "communities",
      depth: 2,
      hubThreshold: 50,
      linksPerNote: 0,
    });
    expect(DEFAULT_SURFACE.filters).toMatchObject({ links: true, embeds: true, properties: false });
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
  });
});

describe("normalizeConfig", () => {
  it("keeps the hub threshold and links per note in range, the exclude list under its old name too", () => {
    const d = normalizeConfig({
      global: {
        display: { hubThreshold: 9999, linksPerNote: -2 },
        filters: { excludeFolders: ["A", 3] },
      },
    }).global;
    expect(d.display).toMatchObject({ hubThreshold: 1000, linksPerNote: 0 });
    expect(d.filters.exclude).toEqual(["A"]);
    const e = normalizeConfig({
      global: {
        display: { hubThreshold: 0, linksPerNote: 3.4 },
        filters: { exclude: ["agent__*"] },
      },
    }).global;
    expect(e.display).toMatchObject({ hubThreshold: 0, linksPerNote: 3 });
    expect(e.filters.exclude).toEqual(["agent__*"]);
    expect(
      normalizeConfig({ global: { display: { hubThreshold: "x" } } }).global.display.hubThreshold,
    ).toBe(50);
  });

  it("keeps valid options, clamps the depth and drops the rest", () => {
    const c = normalizeConfig({
      global: { display: { labels: "always", clusterBy: "folder", depth: 9 } },
    });
    expect(c.global.display).toMatchObject({ labels: "always", clusterBy: "folder", depth: 5 });
    expect(
      normalizeConfig({ global: { display: { labels: "loud", clusterBy: 3, depth: "x" } } }).global
        .display,
    ).toEqual(DEFAULT_DISPLAY);
    expect(normalizeConfig({ global: {}, local: { display: { depth: 4 } } })).toEqual(
      DEFAULT_CONFIG,
    );
    expect(normalizeConfig({ global: { display: { depth: 0 } } }).global.display.depth).toBe(1);
  });

  it("clampDepth keeps the whole vault undefined", () => {
    expect(clampDepth(undefined)).toBeUndefined();
    expect(clampDepth(3.4)).toBe(3);
    expect(clampDepth(12)).toBe(5);
  });
});

describe("slice request", () => {
  const args = { center: "A.md", depth: 2 as const };

  it("does not ask for property edges until they are enabled", () => {
    expect(sliceArgs(args, DEFAULT_SURFACE).kinds).toEqual(["link", "embed"]);
    const on = { ...DEFAULT_SURFACE, filters: { ...DEFAULT_SURFACE.filters, properties: true } };
    expect(sliceArgs(args, on).kinds).toEqual(["link", "embed", "property"]);
  });

  it("asks for the neighbourhood of the center at the depth, or the whole vault", () => {
    expect(sliceArgs(args, DEFAULT_SURFACE)).toMatchObject({ center: "A.md", depth: 2 });
    expect(sliceArgs({ ...args, depth: undefined }, DEFAULT_SURFACE)).not.toHaveProperty("center");
  });
});
