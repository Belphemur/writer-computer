// Level of detail: the level function with hysteresis, the aggregation for the overview, the
// reducer outputs per level and the close-up card cap.
import { describe, expect, it } from "vite-plus/test";
import { aggregate } from "../web/aggregate";
import { CardsLayer, MAX_CARD_TAGS, pickCards } from "../web/cards-layer";
import { DEFAULT_FILTERS } from "../web/config";
import {
  CARD_CAP,
  LOD_HYSTERESIS,
  LOD_TABLE,
  fadeAt,
  hubLimit,
  hubRanks,
  levelFor,
  ratioForSpacing,
  spacingPx,
  type LodLevel,
} from "../web/lod";
import { applySpec, buildSpec, createModel, type NodeAttrs } from "../web/model";
import { bubbleGeometry, bubbleRadius, hitBubble, linkWidth } from "../web/overview";
import { edgeStyle, nodeStyle, type ViewState } from "../web/reducers";
import { FALLBACK_THEME } from "../web/theme";
import { bigSlice, smallSlice } from "./fixtures";

const [, STRUCTURE, DETAIL, CLOSEUP] = LOD_TABLE.map((r) => r.minSpacing) as [
  number,
  number,
  number,
  number,
];

describe("levelFor", () => {
  it("picks the level of the spacing from the one table", () => {
    expect(levelFor(2, "overview")).toBe("overview");
    expect(levelFor(STRUCTURE * 1.5, "overview")).toBe("structure");
    expect(levelFor(DETAIL * 1.5, "structure")).toBe("detail");
    expect(levelFor(CLOSEUP * 1.5, "detail")).toBe("closeup");
    expect(levelFor(CLOSEUP * 5, "overview")).toBe("closeup");
    expect(levelFor(0, "closeup")).toBe("overview");
  });

  it("does not flicker at a boundary: crossing needs the hysteresis margin each way", () => {
    const edge = DETAIL;
    // Just above the boundary is not enough to enter detail, just below does not leave it.
    expect(levelFor(edge * (1 + LOD_HYSTERESIS / 2), "structure")).toBe("structure");
    expect(levelFor(edge * (1 + LOD_HYSTERESIS) + 0.01, "structure")).toBe("detail");
    expect(levelFor(edge * (1 - LOD_HYSTERESIS / 2), "detail")).toBe("detail");
    expect(levelFor(edge * (1 - LOD_HYSTERESIS) - 0.01, "detail")).toBe("structure");
    // A jittering zoom around the boundary settles on one level.
    let level: LodLevel = "structure";
    const seen = new Set<LodLevel>();
    for (const f of [0.98, 1.02, 0.99, 1.03, 1.0, 0.97]) {
      level = levelFor(edge * f, level);
      seen.add(level);
    }
    expect(seen.size).toBe(1);
  });

  it("scales every boundary with the label zoom factor", () => {
    expect(levelFor(DETAIL, "structure", 2)).toBe("detail");
    expect(levelFor(DETAIL, "structure", 1)).toBe("structure");
  });

  it("measures spacing so a big graph is zoomed out at fit and a small one is not", () => {
    expect(levelFor(spacingPx(1, 10_000, 800, 600), "detail")).toBe("overview");
    expect(levelFor(spacingPx(1, 40, 800, 600), "overview")).toBe("detail");
    const ratio = ratioForSpacing(50, 400, 800, 600);
    expect(spacingPx(ratio, 400, 800, 600)).toBeCloseTo(50);
  });

  it("fades in over the change and is instant without motion", () => {
    expect(fadeAt(0, true)).toBeLessThan(1);
    expect(fadeAt(1000, true)).toBe(1);
    expect(fadeAt(0, false)).toBe(1);
  });

  it("ranks hubs by degree and limits them to a share with a floor", () => {
    const ranks = hubRanks([
      { key: "a", degree: 1 },
      { key: "b", degree: 9 },
      { key: "c", degree: 5 },
    ]);
    expect(ranks.get("b")).toBe(0);
    expect(ranks.get("a")).toBe(2);
    expect(hubLimit("overview", 10_000)).toBe(150);
    expect(hubLimit("overview", 100)).toBe(5);
    expect(hubLimit("overview", 3)).toBe(3);
  });
});

describe("aggregate", () => {
  const spec = buildSpec(smallSlice(), DEFAULT_FILTERS);
  const byFolder = (p: string) => (p.includes("/") ? p.split("/")[0]! : null);

  it("counts notes per group and sums links between groups, ignoring links inside one", () => {
    const o = aggregate(spec, byFolder, () => "#123456");
    expect(o.mode).toBe("groups");
    expect(Object.fromEntries(o.bubbles.map((b) => [b.key, b.count]))).toEqual({
      People: 2,
      Notes: 1,
      Other: 1,
    });
    // Ana -> Ben (x2 links, same group) is inside People; Ana embeds Plan and Ben's property
    // edge points back at Ana (inside).
    expect(o.links).toEqual([{ a: "Notes", b: "People", count: 1 }]);
  });

  it("falls back to the hubs mode with fewer than two groups", () => {
    expect(
      aggregate(
        spec,
        () => "one",
        () => "#fff",
      ).mode,
    ).toBe("hubs");
  });

  it("aggregates a 10,000-note vault quickly", () => {
    const big = buildSpec(bigSlice(10_000), DEFAULT_FILTERS);
    const start = performance.now();
    const o = aggregate(
      big,
      (p) => p.split("/")[0]!,
      () => "#fff",
    );
    expect(o.bubbles).toHaveLength(50);
    expect(o.bubbles.reduce((n, b) => n + b.count, 0)).toBe(10_000);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("places bubbles at the member centroid, sized by count, with width by link count", () => {
    const model = createModel();
    applySpec(model, spec);
    const o = aggregate(spec, byFolder, () => "#123456");
    const geoms = bubbleGeometry(o, model, (x, y) => ({ x: x * 10, y: y * 10 }));
    const people = geoms.find((g) => g.key === "People")!;
    const ana = model.getNodeAttributes("People/Ana.md");
    const ben = model.getNodeAttributes("People/Ben.md");
    expect(people.x).toBeCloseTo(((ana.x + ben.x) / 2) * 10);
    expect(bubbleRadius(100)).toBeGreaterThan(bubbleRadius(4));
    expect(linkWidth(9, 9)).toBeGreaterThan(linkWidth(1, 9));
    const apart = [
      { key: "big", count: 9, color: "#fff", x: 0, y: 0, r: 40 },
      { key: "small", count: 1, color: "#fff", x: 10, y: 0, r: 12 },
      { key: "far", count: 1, color: "#fff", x: 300, y: 0, r: 12 },
    ];
    expect(hitBubble(apart, -30, 0)).toBe("big");
    expect(hitBubble(apart, 10, 0)).toBe("small"); // the smaller one wins where they overlap
    expect(hitBubble(apart, 150, 0)).toBeNull();
  });
});

describe("reducers per level", () => {
  const model = createModel();
  applySpec(model, buildSpec(smallSlice(), DEFAULT_FILTERS));
  const attrs = (k: string): NodeAttrs => model.getNodeAttributes(k);
  const view = (patch: Partial<ViewState> = {}): ViewState => ({
    hovered: null,
    hoverNeighbors: new Set(),
    focus: null,
    center: null,
    matches: null,
    selection: new Set(),
    level: "detail",
    groupedOverview: false,
    hubRank: hubRanks(
      [...model.nodes()].map((k) => ({ key: k, degree: model.getNodeAttribute(k, "degree") })),
    ),
    order: 100,
    cardKeys: new Set(),
    fade: 1,
    theme: FALLBACK_THEME,
    propertyLabels: ["manager"],
    ...patch,
  });
  const edge = (kind: string) => {
    const key = model.edges().find((e) => model.getEdgeAttribute(e, "kind") === kind)!;
    return { a: model.getEdgeAttributes(key), s: model.source(key), t: model.target(key) };
  };

  it("overview with groups hides every node and note-level edge", () => {
    const v = view({ level: "overview", groupedOverview: true });
    expect(nodeStyle("People/Ana.md", attrs("People/Ana.md"), v).visibility).toBe("hidden");
    const e = edge("link");
    expect(edgeStyle(e.a, e.s, e.t, v).visibility).toBe("hidden");
  });

  it("flat overview keeps only hubs at full weight, faint dots for the rest, hub-to-hub edges", () => {
    const v = view({
      level: "overview",
      hubRank: new Map([
        ["People/Ana.md", 0],
        ["People/Ben.md", 1],
      ]),
      order: 10_000,
    });
    // hubLimit floors at 5, so with two ranked nodes both are hubs; Lonely has no rank.
    expect(nodeStyle("People/Ana.md", attrs("People/Ana.md"), v).labelVisibility).toBe("visible");
    const faint = nodeStyle("Lonely.md", attrs("Lonely.md"), v);
    expect(faint.opacity).toBeLessThan(0.5);
    expect(faint.labelVisibility).toBe("hidden");
    const hubEdge = edge("link");
    expect(edgeStyle(hubEdge.a, hubEdge.s, hubEdge.t, v).visibility).toBeUndefined();
    const other = edge("embed");
    expect(edgeStyle(other.a, other.s, other.t, v).visibility).toBe("hidden");
  });

  it("structure: dots by degree, thin faint edges, kinds by color only, labels for hubs", () => {
    const v = view({ level: "structure", hubRank: new Map([["People/Ana.md", 0]]) });
    expect(nodeStyle("People/Ana.md", attrs("People/Ana.md"), v).labelVisibility).toBe("visible");
    expect(nodeStyle("People/Ben.md", attrs("People/Ben.md"), v).labelVisibility).toBe("hidden");
    const embed = edge("embed");
    const s = edgeStyle(embed.a, embed.s, embed.t, v);
    expect(s.size).toBeLessThan(0.5);
    expect(s.opacity).toBeLessThan(0.5);
    expect(s.dash).toBe(100000);
    expect(s.head).toBeUndefined();
    const prop = edge("property");
    expect(edgeStyle(prop.a, prop.s, prop.t, v).color).not.toBe(
      edgeStyle(embed.a, embed.s, embed.t, v).color,
    );
  });

  it("detail: all labels, dashed embeds, arrows; close-up adds property labels on edges", () => {
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), view()).labelVisibility).toBe("auto");
    const embed = edge("embed");
    const d = edgeStyle(embed.a, embed.s, embed.t, view());
    expect(d).toMatchObject({ dash: 5, gap: 4, head: "arrow" });
    expect(d.label).toBeUndefined();
    const prop = edge("property");
    expect(edgeStyle(prop.a, prop.s, prop.t, view({ level: "closeup" }))).toMatchObject({
      label: "manager",
      labelVisibility: "visible",
    });
  });

  it("close-up hides the sigma label of a node that has a card, and the fade scales opacity", () => {
    const v = view({ level: "closeup", cardKeys: new Set(["Lonely.md"]) });
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), v).labelVisibility).toBe("hidden");
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), view({ fade: 0.5 })).opacity).toBe(0.5);
    const link = edge("link");
    expect(edgeStyle(link.a, link.s, link.t, view({ fade: 0.5 })).opacity).toBeCloseTo(0.425);
  });
});

describe("close-up cards", () => {
  const attrs = (i: number, extra: Partial<NodeAttrs> = {}): NodeAttrs =>
    ({
      key: `n${i}`,
      kind: "note",
      label: `Note ${i}`,
      path: `n${i}.md`,
      folder: "",
      tags: ["a", "b", "c", "d"],
      degree: i,
      cardValue: "active",
      x: 0,
      y: 0,
      size: 3,
      color: null,
      group: null,
      groupExtra: [],
      ...extra,
    }) as NodeAttrs;

  it("draws at most 150 cards, priority nodes first, then by degree, only in view", () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({
      key: `n${i}`,
      attrs: attrs(i),
      x: i % 100,
      y: 10,
    }));
    nodes.push({ key: "far", attrs: attrs(999), x: 5000, y: 5000 });
    const cards = pickCards(nodes, 200, 200, new Set(["n0"]));
    expect(cards).toHaveLength(CARD_CAP);
    expect(cards[0]!.key).toBe("n0");
    expect(cards.some((c) => c.key === "far")).toBe(false);
    expect(cards[1]!.degree).toBeGreaterThan(cards[100]!.degree);
  });

  it("shows the title, up to 3 tags, the type or status, and Create note on a missing note", () => {
    const cards = pickCards(
      [
        { key: "a", attrs: attrs(1), x: 10, y: 10 },
        { key: "m", attrs: attrs(2, { kind: "missing", cardValue: null }), x: 20, y: 20 },
        { key: "t", attrs: attrs(3, { kind: "tag" }), x: 30, y: 30 },
      ],
      100,
      100,
      new Set(),
    );
    expect(cards.map((c) => c.key).sort()).toEqual(["a", "m"]);
    const a = cards.find((c) => c.key === "a")!;
    expect(a).toMatchObject({ title: "Note 1", cardValue: "active" });
    expect(a.tags).toHaveLength(MAX_CARD_TAGS);
    expect(cards.find((c) => c.key === "m")!.missing).toBe(true);
    expect(typeof CardsLayer).toBe("function");
  });
});
