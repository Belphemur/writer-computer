// Hovering a cluster's area shows its hull: one geometry for drawing and hit testing, the smallest
// hull wins where they overlap, a note under the pointer wins over the area, a click fits the
// cluster (SPECs/graph-view-spec.md 16.6).
import { describe, expect, it } from "vite-plus/test";
import { fitTarget } from "../web/camera-fit";
import {
  activeGroupKeys,
  computeHulls,
  groupPoints,
  hullContains,
  PAD,
  pickHull,
  type HullGroup,
  type HullShape,
} from "../web/hulls";
import { applySpec, createModel, type NodeSpec } from "../web/model";
import { nodeStyle, DIM_OPACITY, type ViewState } from "../web/reducers";
import { FALLBACK_THEME } from "../web/theme";

const note = (key: string): NodeSpec => ({
  key,
  kind: "note",
  label: key,
  path: key,
  folder: "",
  tags: [],
  degree: 1,
  cardValue: null,
});

const shape = (key: string, hull: [number, number][]): HullShape => ({
  key,
  hull,
  center: hull[0]!,
  top: 0,
  area: 0,
});

function model(groups: Record<string, [number, number]>, group: Record<string, string>) {
  const m = createModel();
  applySpec(m, { nodes: Object.keys(groups).map(note), edges: [] });
  for (const [k, [x, y]] of Object.entries(groups)) {
    m.mergeNodeAttributes(k, { x, y, group: group[k]! });
  }
  return m;
}
const ident = (x: number, y: number) => ({ x, y });
const G = (key: string): HullGroup => ({ key, color: "#ff0000" });

describe("hull hit test", () => {
  const square = shape("sq", [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ]);

  it("holds the points inside and within the padding, not beyond it", () => {
    expect(hullContains(square, 50, 50)).toBe(true);
    expect(hullContains(square, 100 + PAD - 1, 50)).toBe(true);
    expect(hullContains(square, 100 + PAD + 1, 50)).toBe(false);
    expect(hullContains(square, -PAD + 1, -1)).toBe(true);
    // the rounded corner: farther than PAD from the corner point
    expect(hullContains(square, 100 + PAD, 100 + PAD)).toBe(false);
  });

  it("pads a lone note and a pair", () => {
    expect(hullContains(shape("one", [[10, 10]]), 10 + PAD - 1, 10)).toBe(true);
    expect(hullContains(shape("one", [[10, 10]]), 10 + PAD + 1, 10)).toBe(false);
    const two = shape("two", [
      [0, 0],
      [100, 0],
    ]);
    expect(hullContains(two, 50, PAD - 1)).toBe(true);
    expect(hullContains(two, 50, PAD + 1)).toBe(false);
  });

  it("picks the smallest hull where several contain the point", () => {
    const m = model(
      { a: [0, 0], b: [200, 0], c: [200, 200], d: [0, 200], e: [90, 90], f: [110, 110] },
      { a: "big", b: "big", c: "big", d: "big", e: "small", f: "small" },
    );
    const shapes = computeHulls(m, ident, [G("big"), G("small")]);
    expect(pickHull(shapes.values(), 100, 100)).toBe("small");
    expect(pickHull(shapes.values(), 20, 100)).toBe("big");
    expect(pickHull(shapes.values(), 900, 900)).toBeNull();
  });
});

describe("hovered cluster", () => {
  const m = model({ a1: [0, 0], b1: [50, 0] }, { a1: "A", b1: "B" });
  const s = (p: Partial<Parameters<typeof activeGroupKeys>[1]> = {}) => ({
    hovered: null,
    hoveredCluster: null,
    focus: null,
    selection: new Set<string>(),
    ...p,
  });

  it("is active with no note hovered, and leaving clears it", () => {
    expect([...activeGroupKeys(m, s({ hoveredCluster: "A" }))]).toEqual(["A"]);
    expect(activeGroupKeys(m, s({ hoveredCluster: null })).size).toBe(0);
  });

  it("joins the clusters of the hovered, focused and selected notes", () => {
    const out = activeGroupKeys(m, s({ hoveredCluster: "A", selection: new Set(["b1"]) }));
    expect([...out].sort()).toEqual(["A", "B"]);
  });

  it("fades the other clusters' notes, but a hovered note's own dim wins", () => {
    const view = (p: Partial<ViewState>): ViewState => ({
      hovered: null,
      hoveredCluster: null,
      hoverNeighbors: new Set(),
      focus: null,
      center: null,
      matches: null,
      selection: new Set(),
      level: "detail",
      labelMode: "zoom",
      groupedOverview: false,
      hubRank: new Map(),
      order: 2,
      cardKeys: new Set(),
      fade: 1,
      hubs: new Set(),
      theme: FALLBACK_THEME,
      propertyLabels: [],
      ...p,
    });
    const a = m.getNodeAttributes("a1");
    const b = m.getNodeAttributes("b1");
    const v = view({ hoveredCluster: "A" });
    expect(nodeStyle("a1", a, v).opacity).toBe(1);
    expect(nodeStyle("b1", b, v).opacity).toBeCloseTo(DIM_OPACITY);
    const noteHover = view({ hoveredCluster: "A", hovered: "b1" });
    expect(nodeStyle("b1", b, noteHover).opacity).toBe(1);
  });
});

describe("click on a hull fits the cluster", () => {
  it("targets the bounding box of that cluster's notes only", () => {
    const m = model({ a: [0, 0], b: [0.2, 0.1], c: [5, 5] }, { a: "A", b: "A", c: "B" });
    const t = fitTarget(groupPoints(m, "A", ident))!;
    expect(t.x).toBeCloseTo(0.1);
    expect(t.y).toBeCloseTo(0.05);
    expect(t.ratio).toBeLessThan(0.5);
    expect(groupPoints(m, "none", ident)).toEqual([]);
  });
});
