// The sigma reducers are pure: style per edge kind and property label, size by degree, hover and
// search dimming, the center ring, labels by zoom.
import { describe, expect, it } from "vite-plus/test";
import { applySpec, buildSpec, createModel, type EdgeAttrs, type NodeAttrs } from "../web/model";
import {
  CENTER_SCALE,
  DASHED,
  DIM_OPACITY,
  SOLID,
  edgeStyle,
  neighborsOf,
  nodeStyle,
  type ViewState,
} from "../web/reducers";
import { FALLBACK_THEME, labelColor } from "../web/theme";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

const model = createModel();
applySpec(model, buildSpec(smallSlice(), WITH_PROPERTIES));

const view = (patch: Partial<ViewState> = {}): ViewState => ({
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
  hubs: new Set(),
  order: 4,
  cardKeys: new Set(),
  fade: 1,
  theme: FALLBACK_THEME,
  propertyLabels: ["manager"],
  ...patch,
});
const attrs = (k: string): NodeAttrs => model.getNodeAttributes(k);
const edgeAttrs = (kind: string): { a: EdgeAttrs; s: string; t: string } => {
  const key = model.edges().find((e) => model.getEdgeAttribute(e, "kind") === kind)!;
  return { a: model.getEdgeAttributes(key), s: model.source(key), t: model.target(key) };
};

describe("node style", () => {
  it("sizes by degree and colors by rule or accent", () => {
    const hub = nodeStyle("People/Ana.md", attrs("People/Ana.md"), view());
    const leaf = nodeStyle("Lonely.md", attrs("Lonely.md"), view());
    expect(hub.size).toBeGreaterThan(leaf.size!);
    expect(leaf.color).toBe(FALLBACK_THEME.accent);
    model.mergeNodeAttributes("Lonely.md", { color: "#ff0000" });
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), view()).color).toBe("#ff0000");
    model.mergeNodeAttributes("Lonely.md", { color: null });
  });

  it("hides labels below the detail level and shows them from it", () => {
    expect(
      nodeStyle("Lonely.md", attrs("Lonely.md"), view({ level: "structure" })).labelVisibility,
    ).toBe("hidden");
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), view()).labelVisibility).toBe("auto");
  });

  it("always labels the hovered, focused, searched and center nodes", () => {
    const hover = view({ hovered: "Lonely.md" });
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), hover).labelVisibility).toBe("visible");
    expect(
      nodeStyle("Lonely.md", attrs("Lonely.md"), view({ focus: "Lonely.md" })).labelVisibility,
    ).toBe("visible");
    expect(
      nodeStyle("Lonely.md", attrs("Lonely.md"), view({ matches: new Set(["Lonely.md"]) }))
        .labelVisibility,
    ).toBe("visible");
    const center = nodeStyle("Lonely.md", attrs("Lonely.md"), view({ center: "Lonely.md" }));
    expect(center.labelVisibility).toBe("visible");
    expect(center.size).toBeCloseTo(attrs("Lonely.md").size * CENTER_SCALE);
    expect(center.backdropVisibility).toBe("visible");
  });

  it("dims everything but the hovered node and its neighbours", () => {
    const v = view({
      hovered: "People/Ana.md",
      hoverNeighbors: neighborsOf(model, "People/Ana.md"),
    });
    expect(nodeStyle("People/Ben.md", attrs("People/Ben.md"), v).opacity).toBe(1);
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), v).opacity).toBe(DIM_OPACITY);
  });

  it("dims non-matches during a search", () => {
    const v = view({ matches: new Set(["People/Ana.md"]) });
    expect(nodeStyle("Lonely.md", attrs("Lonely.md"), v).opacity).toBe(DIM_OPACITY);
    expect(nodeStyle("People/Ana.md", attrs("People/Ana.md"), v).opacity).toBe(1);
  });

  it("anchor nodes are invisible", () => {
    expect(nodeStyle("g", { ...attrs("Lonely.md"), anchor: true }, view()).visibility).toBe(
      "hidden",
    );
  });
});

describe("edge style", () => {
  it("solid and thin for links, dashed for embeds, colored per property label", () => {
    const link = edgeAttrs("link");
    const embed = edgeAttrs("embed");
    const prop = edgeAttrs("property");
    expect(edgeStyle(link.a, link.s, link.t, view())).toMatchObject({
      ...SOLID,
      color: FALLBACK_THEME.edge,
    });
    expect(edgeStyle(embed.a, embed.s, embed.t, view())).toMatchObject(DASHED);
    expect(edgeStyle(prop.a, prop.s, prop.t, view()).color).toBe(
      labelColor("manager", ["manager"]),
    );
  });

  it("widens with the link count and shows arrows only when zoomed in", () => {
    const link = edgeAttrs("link");
    const single = edgeStyle({ ...link.a, count: 1 }, link.s, link.t, view());
    const many = edgeStyle({ ...link.a, count: 4 }, link.s, link.t, view());
    expect(many.size).toBeGreaterThan(single.size!);
    expect(edgeStyle(link.a, link.s, link.t, view({ level: "structure" })).head).toBeUndefined();
    expect(edgeStyle(link.a, link.s, link.t, view({ level: "detail" })).head).toBe("arrow");
  });

  it("highlights edges of the hovered node and dims the rest", () => {
    const link = edgeAttrs("link");
    expect(edgeStyle(link.a, link.s, link.t, view({ hovered: link.s })).opacity).toBe(1);
    expect(edgeStyle(link.a, link.s, link.t, view({ hovered: "Lonely.md" })).opacity).toBeLessThan(
      0.1,
    );
  });

  it("hides the helper edges of groups", () => {
    expect(
      edgeStyle(
        { kind: "group", label: null, count: 1, parts: [], directed: false, weight: 1 },
        "a",
        "b",
        view(),
      ).visibility,
    ).toBe("hidden");
  });
});
