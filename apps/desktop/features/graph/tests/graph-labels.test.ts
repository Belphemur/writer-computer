// The label modes (lod.ts is the one place that decides what is drawn): `hover` labels only the
// hovered node and its neighbours, the selected, focused and centered notes and search matches;
// `zoom` is the level-driven behaviour; `always` labels what the label grid has room for. Edge
// labels follow the mode, and so do the close-up cards.
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_LABEL_MODE,
  cardPriorityKeys,
  cardsInView,
  edgeLabelShown,
  edgeLabelsRendered,
  nodeLabel,
  type LabelMode,
  type LodLevel,
} from "../web/lod";
import { applySpec, buildSpec, createModel, type NodeAttrs } from "../web/model";
import { edgeStyle, nodeStyle, type ViewState } from "../web/reducers";
import { FALLBACK_THEME } from "../web/theme";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

const model = createModel();
applySpec(model, buildSpec(smallSlice(), WITH_PROPERTIES));
const attrs = (k: string): NodeAttrs => model.getNodeAttributes(k);
const view = (patch: Partial<ViewState> = {}): ViewState => ({
  hovered: null,
  hoverNeighbors: new Set(),
  focus: null,
  center: null,
  matches: null,
  selection: new Set(),
  level: "detail",
  labelMode: "hover",
  groupedOverview: false,
  hubRank: new Map(),
  order: 4,
  cardKeys: new Set(),
  fade: 1,
  theme: FALLBACK_THEME,
  propertyLabels: ["manager"],
  ...patch,
});
const labelOf = (key: string, patch: Partial<ViewState>) =>
  nodeStyle(key, attrs(key), view(patch)).labelVisibility;
const NAMES = ["People/Ana.md", "People/Ben.md", "Notes/Plan.md", "Lonely.md"];

describe("the default", () => {
  it("is hover", () => expect(DEFAULT_LABEL_MODE).toBe("hover"));
});

describe("hover mode", () => {
  it("labels no plain node at any zoom level", () => {
    for (const level of ["overview", "structure", "detail", "closeup"] as LodLevel[]) {
      for (const k of NAMES) expect(labelOf(k, { level })).toBe("hidden");
    }
  });

  it("labels the hovered node and its neighbours only", () => {
    const hoverNeighbors = new Set(["People/Ben.md"]);
    const patch = { hovered: "People/Ana.md", hoverNeighbors };
    expect(labelOf("People/Ana.md", patch)).toBe("visible");
    expect(labelOf("People/Ben.md", patch)).toBe("visible");
    expect(labelOf("Lonely.md", patch)).toBe("hidden");
    expect(labelOf("Notes/Plan.md", patch)).toBe("hidden");
  });

  it("labels selected, focused and centered notes, and search matches", () => {
    expect(labelOf("Lonely.md", { selection: new Set(["Lonely.md"]) })).toBe("visible");
    expect(labelOf("Lonely.md", { focus: "Lonely.md" })).toBe("visible");
    expect(labelOf("Lonely.md", { center: "Lonely.md" })).toBe("visible");
    expect(labelOf("Lonely.md", { matches: new Set(["Lonely.md"]) })).toBe("visible");
    expect(labelOf("Notes/Plan.md", { matches: new Set(["Lonely.md"]) })).toBe("hidden");
  });
});

describe("zoom mode keeps the level-driven behaviour", () => {
  it("auto from detail, hub labels in structure, cards replace labels in close-up", () => {
    const hubRank = new Map([["People/Ana.md", 0]]);
    expect(labelOf("Lonely.md", { labelMode: "zoom", level: "detail" })).toBe("auto");
    expect(labelOf("Lonely.md", { labelMode: "zoom", level: "structure", hubRank })).toBe("hidden");
    expect(labelOf("People/Ana.md", { labelMode: "zoom", level: "structure", hubRank })).toBe(
      "visible",
    );
    const cardKeys = new Set(["Lonely.md"]);
    expect(labelOf("Lonely.md", { labelMode: "zoom", level: "closeup", cardKeys })).toBe("hidden");
  });
});

describe("always mode", () => {
  it("lets the label grid place every node, hubs first", () => {
    expect(nodeLabel("always", "overview", false, false)).toBe("auto");
    expect(nodeLabel("always", "overview", true, false)).toBe("visible");
    expect(nodeLabel("always", "structure", false, false)).toBe("auto");
    expect(nodeLabel("always", "detail", false, false)).toBe("auto");
  });
});

describe("edge labels", () => {
  const prop = () => {
    const key = model.edges().find((e) => model.getEdgeAttribute(e, "kind") === "property")!;
    return { a: model.getEdgeAttributes(key), s: model.source(key), t: model.target(key) };
  };

  it("hover mode: only on edges touching the hovered, focused or selected node", () => {
    const { a, s, t } = prop();
    expect(edgeStyle(a, s, t, view()).label).toBeUndefined();
    expect(edgeStyle(a, s, t, view({ hovered: s })).label).toBe(a.label);
    expect(edgeStyle(a, s, t, view({ focus: t })).label).toBe(a.label);
    expect(edgeStyle(a, s, t, view({ selection: new Set([s]) })).label).toBe(a.label);
    expect(edgeStyle(a, s, t, view({ hovered: "Lonely.md" })).label).toBeUndefined();
  });

  it("zoom mode: every property edge, in close-up only", () => {
    const { a, s, t } = prop();
    expect(edgeStyle(a, s, t, view({ labelMode: "zoom", level: "closeup" })).label).toBe(a.label);
    expect(edgeStyle(a, s, t, view({ labelMode: "zoom", level: "detail" })).label).toBeUndefined();
  });

  it("sigma draws edge labels from detail in hover mode, in close-up otherwise", () => {
    expect(edgeLabelsRendered("hover", "detail")).toBe(true);
    expect(edgeLabelsRendered("hover", "structure")).toBe(false);
    expect(edgeLabelsRendered("zoom", "detail")).toBe(false);
    expect(edgeLabelsRendered("always", "closeup")).toBe(true);
    expect(edgeLabelShown("hover", "detail", false)).toBe(false);
  });
});

describe("close-up cards", () => {
  const nodes = [
    { key: "a", x: 10, y: 10, degree: 9, priority: false },
    { key: "b", x: 20, y: 20, degree: 1, priority: true },
  ];

  it("hover mode: only the hovered, focused and selected notes, not the center", () => {
    const keys = cardPriorityKeys("hover", {
      center: "c",
      hovered: "h",
      focus: "f",
      selection: new Set(["s"]),
    });
    expect([...keys].sort()).toEqual(["f", "h", "s"]);
    expect(cardsInView(nodes, 100, 100, 150, 40, true).map((n) => n.key)).toEqual(["b"]);
  });

  it("zoom and always modes keep the center and the cap", () => {
    for (const mode of ["zoom", "always"] as LabelMode[]) {
      expect(
        cardPriorityKeys(mode, { center: "c", hovered: null, focus: null, selection: new Set() }),
      ).toEqual(new Set(["c"]));
    }
    expect(cardsInView(nodes, 100, 100).map((n) => n.key)).toEqual(["b", "a"]);
    expect(cardsInView(nodes, 100, 100, 1)).toHaveLength(1);
  });
});
