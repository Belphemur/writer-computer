// One drawn edge per pair of notes (SPECs/graph-view-spec.md 3.2): every kind and both directions
// merge into it, the hover line says what makes the link, the arrow needs one direction, and the
// edges that do not touch the hovered, focused or selected note are dimmed.
import { describe, expect, it } from "vite-plus/test";
import { EDGE_DIM, EDGE_LOOK, edgeOpacity } from "../web/lod";
import { applySpec, buildSpec, createModel, mergePairs, type RawEdge } from "../web/model";
import { edgeStyle, edgeTitle, type ViewState } from "../web/reducers";
import { FALLBACK_THEME } from "../web/theme";
import { DEFAULT_FILTERS } from "../web/config";
import { edge, node } from "./fixtures";

const raw = (
  from: string,
  to: string,
  kind: RawEdge["kind"],
  label: string | null = null,
  count = 1,
): RawEdge => ({
  key: `${from}>${to}:${kind}:${label}`,
  source: from,
  target: to,
  from,
  to,
  kind,
  label,
  count,
});

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
  order: 10,
  cardKeys: new Set(),
  fade: 1,
  theme: FALLBACK_THEME,
  propertyLabels: ["owner"],
  ...patch,
});

describe("merging a pair", () => {
  const mixed = [
    raw("a", "b", "link", null, 2),
    raw("b", "a", "embed"),
    raw("a", "b", "property", "owner"),
  ];

  it("collapses three kinds in both directions into one edge that keeps every part", () => {
    const merged = mergePairs(mixed);
    expect(merged).toHaveLength(1);
    const [e] = merged;
    expect(e!.count).toBe(4);
    expect(e!.parts.map((p) => p.kind)).toEqual(["link", "embed", "property"]);
    expect(e!.kind).toBe("link"); // neutral: not one property
    expect(e!.label).toBeNull();
    expect(e!.directed).toBe(false);
  });

  it("the hover line lists each kind once, terse", () => {
    const [e] = mergePairs([...mixed, raw("a", "b", "link")]);
    expect(edgeTitle(e!)).toBe("links to · embeds · owner");
  });

  it("is directed, and coloured by its property, only when every part agrees", () => {
    const [one] = mergePairs([
      raw("a", "b", "property", "owner"),
      raw("a", "b", "property", "owner"),
    ]);
    expect(one).toMatchObject({ kind: "property", label: "owner", directed: true, count: 2 });
    const [both] = mergePairs([raw("a", "b", "link"), raw("b", "a", "link")]);
    expect(both!.directed).toBe(false);
  });

  it("buildSpec yields one edge per pair of the slice", () => {
    const slice = {
      nodes: [node(1, "A.md"), node(2, "B.md")],
      edges: [
        edge(1, 1, 2),
        edge(2, 2, 1),
        edge(3, 1, 2, "embed"),
        edge(4, 2, 1, "property", "owner"),
      ],
      truncated: false,
      limit: 100,
      epoch: 1,
    };
    const spec = buildSpec(slice, { ...DEFAULT_FILTERS, properties: true });
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]!.parts).toHaveLength(4);
    const model = createModel();
    applySpec(model, spec);
    expect(model.size).toBe(1);
    expect(model.getEdgeAttribute(model.edges()[0]!, "weight")).toBe(4); // layout weight = count
  });

  it("a pair whose first direction flips is rebuilt, not left pointing the old way", () => {
    const model = createModel();
    const n = (key: string) => ({
      key,
      kind: "note" as const,
      label: key,
      path: key,
      folder: "",
      tags: [],
      degree: 1,
      cardValue: null,
    });
    const nodes = [n("a"), n("b")];
    const mk = (from: string, to: string) =>
      mergePairs([raw(from, to, "link")]).map((e) => ({ ...e, key: "a\u0000b" }));
    applySpec(model, { nodes, edges: mk("a", "b") });
    expect(model.source("a\u0000b")).toBe("a");
    applySpec(model, { nodes, edges: mk("b", "a") });
    expect(model.source("a\u0000b")).toBe("b");
  });
});

describe("what an edge shows", () => {
  const [directed] = mergePairs([raw("a", "b", "link")]);
  const [both] = mergePairs([raw("a", "b", "link"), raw("b", "a", "link")]);
  const attrs = (e: NonNullable<typeof directed>) => ({ ...e, weight: e.count });

  it("draws an arrow only when every link runs one way, and only from detail", () => {
    expect(edgeStyle(attrs(directed!), "a", "b", view()).head).toBe("arrow");
    expect(edgeStyle(attrs(both!), "a", "b", view()).head).toBeUndefined();
    expect(
      edgeStyle(attrs(directed!), "a", "b", view({ level: "structure" })).head,
    ).toBeUndefined();
  });

  it("labels the merged edge with what makes it only when it touches the hovered note", () => {
    const [e] = mergePairs([raw("a", "b", "link"), raw("a", "b", "embed")]);
    expect(edgeStyle(attrs(e!), "a", "b", view()).label).toBeUndefined();
    expect(edgeStyle(attrs(e!), "a", "b", view({ hovered: "b" })).label).toBe("links to · embeds");
    expect(edgeStyle(attrs(e!), "a", "b", view({ hovered: "z" })).label).toBeUndefined();
  });

  it("is faint and thin zoomed out, stronger zoomed in", () => {
    const far = edgeStyle(attrs(directed!), "a", "b", view({ level: "structure" }));
    const near = edgeStyle(attrs(directed!), "a", "b", view({ level: "closeup" }));
    expect(far.opacity).toBe(EDGE_LOOK.structure.opacity);
    expect(near.opacity!).toBeGreaterThan(far.opacity!);
    expect(far.size!).toBeLessThan(near.size!);
  });

  it("dims every edge but those of the hovered, focused or selected note", () => {
    const e = attrs(directed!);
    expect(edgeStyle(e, "a", "b", view({ hovered: "a" })).opacity).toBe(1);
    expect(edgeStyle(e, "c", "d", view({ hovered: "a" })).opacity).toBe(EDGE_DIM);
    expect(edgeStyle(e, "c", "d", view({ selection: new Set(["a"]) })).opacity).toBe(EDGE_DIM);
    expect(edgeStyle(e, "a", "b", view({ focus: "b" })).opacity).toBe(1);
    expect(edgeOpacity("overview", false, false)).toBe(EDGE_LOOK.overview.opacity);
  });
});
