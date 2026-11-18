// Batch 2 of the graph view (SPECs/graph-view-spec.md 16): collapsed clusters with drill-down and
// stubs, hubs on demand, the strongest links per note, search labels from the theme, hulls only on
// hover or selection, the Exclude presets and the depth hint.
import { describe, expect, it } from "vite-plus/test";
import { aggregate } from "../web/aggregate";
import { coversMostOfVault } from "../web/config";
import { clusterKey, collapsedSpec, drilledSpec } from "../web/drill";
import { detectPresets, excludes, isPattern, toggleEntry } from "../web/exclude";
import { activeGroupKeys } from "../web/hulls";
import { hubSet } from "../web/lod";
import {
  applySpec,
  createModel,
  mergePairs,
  type EdgeSpec,
  type GraphSpec,
  type NodeSpec,
  type RawEdge,
} from "../web/model";
import { edgeStyle, nodeStyle, type ViewState } from "../web/reducers";
import { edgeStrength, topLinks } from "../web/strength";
import { FALLBACK_THEME } from "../web/theme";

const note = (key: string, degree = 1): NodeSpec => ({
  key,
  kind: "note",
  label: key,
  path: key,
  folder: "",
  tags: [],
  degree,
  cardValue: null,
});
const raw = (a: string, b: string, count = 1): RawEdge => ({
  key: `${a}>${b}`,
  source: a,
  target: b,
  from: a,
  to: b,
  kind: "link",
  label: null,
  count,
});
const edges = (...r: RawEdge[]): EdgeSpec[] => mergePairs(r);

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
  hubs: new Set(),
  order: 10,
  cardKeys: new Set(),
  fade: 1,
  theme: {
    ...FALLBACK_THEME,
    label: "rgb(1,2,3)",
    text: "rgb(250,250,250)",
    labelBackground: "rgb(30,30,30)",
  },
  propertyLabels: [],
  ...patch,
});

// Two clusters: A (a1..a3) and B (b1, b2), a1-b1 linked twice.
const spec: GraphSpec = {
  nodes: ["a1", "a2", "a3", "b1", "b2"].map((k) => note(k)),
  edges: edges(
    raw("a1", "a2"),
    raw("a2", "a3"),
    raw("a1", "b1", 2),
    raw("a3", "b2"),
    raw("b1", "b2"),
  ),
};
const groupOf = (k: string) => (k.startsWith("a") ? "A" : "B");
const color = (g: string) => (g === "A" ? "#111111" : "#222222");

describe("collapsed clusters and drill-down", () => {
  const overview = aggregate(spec, groupOf, color);

  it("is one node per cluster sized by its notes, one edge per pair of clusters by link count", () => {
    const c = collapsedSpec(overview);
    expect(c.nodes.map((n) => [n.key, n.kind, n.label, n.degree])).toEqual([
      ["cluster:A", "cluster", "A (3)", 3],
      ["cluster:B", "cluster", "B (2)", 2],
    ]);
    expect(c.edges).toHaveLength(1);
    expect(c.edges[0]!.count).toBe(3); // a1-b1 x2 and a3-b2
    expect(c.nodes[0]!.tint).toBe("#111111");
  });

  it("opens one cluster with its notes, its links and a stub per other cluster", () => {
    const d = drilledSpec(spec, groupOf, color, "A");
    expect(d.nodes.filter((n) => n.kind === "note").map((n) => n.key)).toEqual(["a1", "a2", "a3"]);
    const stub = d.nodes.find((n) => n.kind === "cluster")!;
    expect(stub).toMatchObject({ key: clusterKey("B"), cluster: "B", label: "→ B (3)" });
    // Inside links stay; the bundle joins each note that links out to the stub (a1 twice, a3 once).
    const toStub = d.edges.filter((e) => e.target === stub.key);
    expect(toStub.map((e) => [e.source, e.count]).sort()).toEqual([
      ["a1", 2],
      ["a3", 1],
    ]);
    expect(d.edges.filter((e) => e.target !== stub.key)).toHaveLength(2);
    expect(d.nodes.some((n) => n.key === "b1")).toBe(false);
  });

  it("stubs open the other cluster, and the way back is the collapsed spec again", () => {
    const stub = drilledSpec(spec, groupOf, color, "A").nodes.find((n) => n.kind === "cluster")!;
    const d = drilledSpec(spec, groupOf, color, stub.cluster!);
    expect(d.nodes.find((n) => n.kind === "cluster")!.cluster).toBe("A");
    expect(collapsedSpec(overview).nodes.map((n) => n.cluster)).toEqual(["A", "B"]);
  });

  it("cluster nodes load into the model with their tint and always show their label", () => {
    const model = createModel();
    applySpec(model, collapsedSpec(overview));
    expect(model.getNodeAttribute("cluster:A", "color")).toBe("#111111");
    const s = nodeStyle("cluster:A", model.getNodeAttributes("cluster:A"), view());
    expect(s.labelVisibility).toBe("visible");
    expect(s.labelColor).toBe("rgb(250,250,250)");
  });
});

describe("hubs on demand", () => {
  it("a hub is a note with more links than the threshold; 0 and clusters are never hubs", () => {
    const nodes = [
      note("big", 60),
      note("small", 3),
      { ...note("c", 900), kind: "cluster" as const },
    ];
    expect([...hubSet(nodes, 50)]).toEqual(["big"]);
    expect(hubSet(nodes, 0).size).toBe(0);
  });

  it("hides a hub's links until the hub is hovered, focused or selected", () => {
    const [e] = edges(raw("hub", "x"));
    const a = { ...e!, weight: 1 };
    const hubs = new Set(["hub"]);
    expect(edgeStyle(a, "hub", "x", view({ hubs })).visibility).toBe("hidden");
    expect(edgeStyle(a, "hub", "x", view({ hubs, hovered: "x" })).visibility).toBe("hidden");
    expect(edgeStyle(a, "hub", "x", view({ hubs, hovered: "hub" })).visibility).toBeUndefined();
    expect(
      edgeStyle(a, "hub", "x", view({ hubs, selection: new Set(["hub"]) })).visibility,
    ).toBeUndefined();
    expect(edgeStyle(a, "hub", "x", view()).visibility).toBeUndefined();
  });
});

describe("links per note", () => {
  const star: GraphSpec = {
    nodes: ["hub", "p", "q", "r", "s"].map((k) => note(k)),
    edges: edges(
      raw("hub", "p", 5),
      raw("hub", "q", 3),
      raw("hub", "r"),
      raw("hub", "s"),
      raw("p", "q"),
    ),
  };
  const none = () => null;

  it("scores count, reciprocity and the same cluster", () => {
    const [one] = edges(raw("a", "b", 2));
    const [both] = edges(raw("a", "b"), raw("b", "a"));
    expect(edgeStrength(one!, false)).toBe(2);
    expect(edgeStrength(one!, true)).toBe(3);
    expect(edgeStrength(both!, false)).toBe(3);
  });

  it("keeps an edge that is in the top k of either endpoint", () => {
    const kept = topLinks(star, 1, none).edges.map((e) => e.key);
    // hub keeps hub-p; p keeps hub-p; q keeps hub-q (strongest of q's two); r and s keep their only link,
    // the weak hub-r and hub-s survive through r and s; p-q is in neither top 1.
    expect(kept.sort()).toEqual(["hub\u0000p", "hub\u0000q", "hub\u0000r", "hub\u0000s"].sort());
    expect(topLinks(star, 0, none)).toBe(star);
    expect(topLinks(star, 10, none).edges).toHaveLength(5);
  });

  it("prefers a link inside the cluster when counts tie", () => {
    const s: GraphSpec = {
      nodes: ["a", "b", "c"].map((k) => note(k)),
      edges: edges(raw("a", "b"), raw("a", "c")),
    };
    const kept = topLinks(s, 1, (k) => (k === "c" ? "other" : "same"));
    expect(kept.edges.map((e) => e.key)).toContain("a\u0000b");
  });
});

describe("search labels and hulls", () => {
  it("takes the label colours from the theme, never sigma's black", () => {
    const n = { ...note("m"), x: 0, y: 0, size: 3, color: null, group: null, groupExtra: [] };
    const plain = nodeStyle("m", n, view());
    expect(plain.labelColor).toBe("rgb(1,2,3)");
    const matched = nodeStyle("m", n, view({ matches: new Set(["m"]) }));
    expect(matched).toMatchObject({
      labelVisibility: "visible",
      labelColor: "rgb(250,250,250)",
      labelBackgroundColor: "rgb(30,30,30)",
    });
    const other = nodeStyle("o", { ...n, key: "o" }, view({ matches: new Set(["m"]) }));
    expect(other.opacity).toBeLessThan(0.5); // everything else fades
  });

  it("draws a hull only for the clusters of the hovered, focused or selected notes", () => {
    const model = createModel();
    applySpec(model, spec);
    for (const k of model.nodes()) model.setNodeAttribute(k, "group", groupOf(k));
    const none = activeGroupKeys(model, { hovered: null, focus: null, selection: new Set() });
    expect(none.size).toBe(0);
    expect([
      ...activeGroupKeys(model, { hovered: "a1", focus: null, selection: new Set() }),
    ]).toEqual(["A"]);
    const both = activeGroupKeys(model, { hovered: "a1", focus: null, selection: new Set(["b2"]) });
    expect([...both].sort()).toEqual(["A", "B"]);
  });
});

describe("exclude presets", () => {
  const n = (name: string, folder = "") => ({ name: `${name}.md`, folder });
  const many = (fmt: (i: number) => string, folder = "") =>
    Array.from({ length: 6 }, (_, i) => n(fmt(i), folder));

  it("matches folders and name patterns in one list", () => {
    expect(isPattern("agent__*")).toBe(true);
    expect(isPattern("Archive/Old")).toBe(false);
    expect(excludes("agent__*", n("agent__run-1"))).toBe(true);
    expect(excludes("agent__*", n("My agent__note"))).toBe(false);
    expect(excludes("####-##-##*", n("2026-11-18 standup"))).toBe(true);
    expect(excludes("####-##-##*", n("Notes 2026-11-18"))).toBe(false);
    expect(excludes("Archive", n("x", "Archive/2020"))).toBe(true);
    expect(excludes("Archive", n("x", "Archives"))).toBe(false);
    expect(excludes("*recap*", n("Weekly RECAP"))).toBe(true);
  });

  it("detects generated notes, daily and weekly notes, recaps and quiet folders by count", () => {
    const notes = [
      ...many((i) => `agent__task-${i}`),
      ...many((i) => `2026-11-0${i + 1}`),
      ...many((i) => `2026-W0${i + 1}`),
      ...many((i) => `Sprint ${i} recap`),
      ...many((i) => `entry ${i}`, "Journal"),
      n("Plan"),
      n("other__a"),
    ];
    const presets = detectPresets(notes);
    expect(presets.map((p) => p.entry).sort()).toEqual(
      ["####-##-##*", "####-W##*", "*recap*", "Journal", "agent__*"].sort(),
    );
    expect(presets.every((p) => p.count === 6)).toBe(true);
    expect(detectPresets([n("agent__a"), n("agent__b")])).toEqual([]); // too few to offer
  });

  it("one click adds the entry, the next removes it", () => {
    expect(toggleEntry(["Archive"], "agent__*")).toEqual(["Archive", "agent__*"]);
    expect(toggleEntry(["Archive", "agent__*"], "agent__*")).toEqual(["Archive"]);
  });
});

describe("depth hint", () => {
  it("shows when a depth reaches more than 60% of the vault, never while the size is unknown", () => {
    expect(coversMostOfVault(70, 100)).toBe(true);
    expect(coversMostOfVault(60, 100)).toBe(false);
    expect(coversMostOfVault(70, null)).toBe(false);
    expect(coversMostOfVault(5, 0)).toBe(false);
  });
});
