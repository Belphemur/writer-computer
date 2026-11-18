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
    expect(DEFAULT_DISPLAY).toEqual({ labels: "hover", clusterBy: "communities", depth: 2 });
    expect(DEFAULT_SURFACE.filters).toMatchObject({ links: true, embeds: true, properties: false });
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
  });
});

describe("normalizeConfig", () => {
  it("keeps valid options, clamps the depth and drops the rest", () => {
    const c = normalizeConfig({
      global: { display: { labels: "always", clusterBy: "folder", depth: 9 } },
      local: { display: { labels: "loud", clusterBy: 3, depth: "x" } },
    });
    expect(c.global.display).toEqual({ labels: "always", clusterBy: "folder", depth: 5 });
    expect(c.local.display).toEqual(DEFAULT_DISPLAY);
    expect(normalizeConfig({ global: { display: { depth: 0 } } }).global.display.depth).toBe(1);
  });

  it("clampDepth keeps the whole vault undefined", () => {
    expect(clampDepth(undefined)).toBeUndefined();
    expect(clampDepth(3.4)).toBe(3);
    expect(clampDepth(12)).toBe(5);
  });
});

describe("slice request", () => {
  const args = { surface: "global" as const, center: "A.md", depth: 2 as const };

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
