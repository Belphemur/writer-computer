// The model: slice to spec (filters), and the in-place update keyed by path.
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_FILTERS, type GraphFilters } from "../web/config";
import { applySpec, buildSpec, createModel, nodeKindOf, sizeForDegree } from "../web/model";
import { bigSlice, smallSlice } from "./fixtures";

const filters = (patch: Partial<GraphFilters> = {}): GraphFilters => ({
  ...DEFAULT_FILTERS,
  properties: true,
  ...patch,
});
const keys = (spec: { nodes: { key: string }[] }) => spec.nodes.map((n) => n.key).sort();

describe("buildSpec", () => {
  it("shows notes only by default: no bases, attachments, tags or missing notes", () => {
    const spec = buildSpec(smallSlice(), filters());
    expect(keys(spec)).toEqual(["Lonely.md", "Notes/Plan.md", "People/Ana.md", "People/Ben.md"]);
  });

  it("draws one edge per pair, kind and label, counting repeats", () => {
    const spec = buildSpec(smallSlice(), filters());
    const link = spec.edges.find((e) => e.kind === "link");
    expect(link).toMatchObject({ source: "People/Ana.md", target: "People/Ben.md", count: 2 });
    expect(spec.edges.map((e) => e.kind).sort()).toEqual(["embed", "link", "property"]);
    expect(spec.edges.find((e) => e.kind === "property")?.label).toBe("manager");
  });

  it("hides edge kinds and property labels", () => {
    expect(
      buildSpec(smallSlice(), filters({ embeds: false })).edges.map((e) => e.kind),
    ).not.toContain("embed");
    const hidden = buildSpec(smallSlice(), filters({ hiddenLabels: ["manager"] }));
    expect(hidden.edges.map((e) => e.kind)).not.toContain("property");
    expect(
      buildSpec(smallSlice(), filters({ properties: false })).edges.some(
        (e) => e.kind === "property",
      ),
    ).toBe(false);
  });

  it("drops orphans on request but keeps the center", () => {
    const spec = buildSpec(smallSlice(), filters({ orphans: false }), { center: "Lonely.md" });
    expect(keys(spec)).toContain("Lonely.md");
    expect(keys(buildSpec(smallSlice(), filters({ orphans: false })))).not.toContain("Lonely.md");
  });

  it("adds bases, attachments and tag nodes (nested tags link child to parent) on request", () => {
    expect(keys(buildSpec(smallSlice(), filters({ bases: true })))).toContain("Team.base");
    const tags = buildSpec(smallSlice(), filters({ tags: true }));
    expect(keys(tags)).toEqual(expect.arrayContaining(["#person", "#team", "#team/eng"]));
    expect(tags.edges.some((e) => e.source === "#team/eng" && e.target === "#team")).toBe(true);
    expect(tags.nodes.find((n) => n.key === "#person")?.degree).toBe(2);
  });

  it("filters by folder include and exclude", () => {
    expect(keys(buildSpec(smallSlice(), filters({ includeFolders: ["People"] })))).toEqual([
      "People/Ana.md",
      "People/Ben.md",
    ]);
    expect(keys(buildSpec(smallSlice(), filters({ excludeFolders: ["People"] })))).toEqual([
      "Lonely.md",
      "Notes/Plan.md",
    ]);
  });

  it("search keeps matches and the notes they link with", () => {
    const spec = buildSpec(smallSlice(), filters({ query: "plan" }));
    expect(keys(spec)).toEqual(["Notes/Plan.md", "People/Ana.md"]);
    expect(
      buildSpec(smallSlice(), filters({ query: "tag:team" })).nodes.some(
        (n) => n.key === "People/Ana.md",
      ),
    ).toBe(true);
  });

  it("classifies kinds and sizes by degree with a cap", () => {
    expect(nodeKindOf({ ext: "md" })).toBe("note");
    expect(nodeKindOf({ ext: "base" })).toBe("base");
    expect(nodeKindOf({ ext: "png" })).toBe("attachment");
    expect(nodeKindOf({ ext: "", unresolved: true })).toBe("missing");
    expect(sizeForDegree(4)).toBeGreaterThan(sizeForDegree(1));
    expect(sizeForDegree(1e9)).toBeLessThanOrEqual(18);
  });
});

describe("applySpec (in place, keyed by path)", () => {
  it("keeps the position and pin of nodes that stay, drops the removed, adds near neighbours", () => {
    const model = createModel();
    applySpec(model, buildSpec(smallSlice(), filters()));
    model.mergeNodeAttributes("People/Ana.md", { x: 10, y: 20, fixed: true });
    const ben = model.getNodeAttributes("People/Ben.md");

    const next = smallSlice();
    next.nodes = next.nodes.filter((n) => n.path !== "Notes/Plan.md");
    next.edges = next.edges.filter((e) => e.dst !== 3);
    next.nodes.push({ ...next.nodes[0]!, id: 9, path: "People/Cy.md", name: "Cy.md" });
    next.edges.push({ id: 9, src: 9, dst: 1, kind: "link", target: "Ana" });
    const result = applySpec(model, buildSpec(next, filters()));

    expect(result.removed).toEqual(["Notes/Plan.md"]);
    expect(result.added).toEqual(["People/Cy.md"]);
    expect(result.structural).toBe(true);
    expect(model.hasNode("Notes/Plan.md")).toBe(false);
    expect(model.getNodeAttributes("People/Ana.md")).toMatchObject({ x: 10, y: 20, fixed: true });
    expect(model.getNodeAttributes("People/Ben.md")).toMatchObject({ x: ben.x, y: ben.y });
    const cy = model.getNodeAttributes("People/Cy.md");
    expect(Math.hypot(cy.x - 10, cy.y - 20)).toBeLessThan(2);
  });

  it("an unchanged slice is not structural and moves nothing", () => {
    const model = createModel();
    const spec = buildSpec(smallSlice(), filters());
    applySpec(model, spec);
    const before = model.getNodeAttributes("People/Ana.md");
    const again = applySpec(model, buildSpec(smallSlice(), filters()));
    expect(again.structural).toBe(false);
    expect(model.getNodeAttributes("People/Ana.md")).toMatchObject({ x: before.x, y: before.y });
  });

  it("keys are paths, not index ids", () => {
    const model = createModel();
    applySpec(model, buildSpec(smallSlice(), filters()));
    const renumbered = smallSlice();
    renumbered.nodes = renumbered.nodes.map((n) => ({ ...n, id: n.id + 100 }));
    renumbered.edges = renumbered.edges.map((e) => ({
      ...e,
      src: e.src + 100,
      dst: e.dst && e.dst + 100,
    }));
    expect(applySpec(model, buildSpec(renumbered, filters())).structural).toBe(false);
  });
});

describe("scale", () => {
  it("builds the model of a 10,000-node slice within budget", () => {
    const slice = bigSlice(10_000);
    const start = performance.now();
    const model = createModel();
    applySpec(model, buildSpec(slice, filters()));
    const ms = performance.now() - start;
    expect(model.order).toBe(10_000);
    expect(model.size).toBeGreaterThan(20_000);
    expect(ms).toBeLessThan(4000);
  });
});
