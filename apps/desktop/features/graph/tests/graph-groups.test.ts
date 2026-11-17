// Query syntax, color rules, Group by, anchors, hull geometry, keyboard picking, the config file.
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseConfig,
  serializeConfig,
  DEFAULT_FILTERS,
} from "../web/config";
import {
  ANCHOR_PREFIX,
  centroid,
  computeGroups,
  convexHull,
  groupValues,
  syncGroups,
} from "../web/groups";
import { pickNeighbor } from "../web/keyboard";
import { applySpec, buildSpec, createModel } from "../web/model";
import { matches, parseQuery } from "../web/query";
import { smallSlice } from "./fixtures";

const note = (extra = {}) => ({
  path: "People/Ana.md",
  name: "Ana",
  tags: ["person", "team/eng"],
  ...extra,
});

describe("query", () => {
  it("parses words, path:, tag: and [property:value]", () => {
    expect(parseQuery('ana path:People tag:#person [status:done] [due] "two words"')).toEqual([
      { kind: "word", value: "ana" },
      { kind: "path", value: "People" },
      { kind: "tag", value: "person" },
      { kind: "prop", name: "status", value: "done" },
      { kind: "prop", name: "due", value: null },
      { kind: "word", value: "two words" },
    ]);
  });

  it("matches all terms; tags include nested ones; properties unwrap wiki links and lists", () => {
    expect(matches(parseQuery("ana tag:team"), note())).toBe(true);
    expect(matches(parseQuery("tag:tea"), note())).toBe(false);
    expect(
      matches(parseQuery("[manager:Priya]"), note({ props: { Manager: "[[Priya|P]]" } })),
    ).toBe(true);
    expect(matches(parseQuery("[role:lead]"), note({ props: { role: ["dev", "Lead"] } }))).toBe(
      true,
    );
    expect(matches(parseQuery("[role:lead]"), note())).toBe(false);
    expect(matches(parseQuery(""), note())).toBe(true);
  });
});

describe("groups", () => {
  const spec = buildSpec(smallSlice(), DEFAULT_FILTERS);

  it("first matching color rule wins, over the group color", () => {
    const r = computeGroups(spec.nodes, {
      rules: [
        { id: "a", query: "tag:team", color: "#111111" },
        { id: "b", query: "tag:person", color: "#222222" },
      ],
      groupBy: { property: "folder", nestedLevel: 1 },
      props: {},
    });
    expect(r.nodes.get("People/Ana.md")?.color).toBe("#111111");
    expect(r.nodes.get("People/Ben.md")?.color).toBe("#222222");
    expect(r.nodes.get("Notes/Plan.md")?.group).toBe("Notes");
  });

  it("groups by tags (nested level), folder or any frontmatter key; extras are kept", () => {
    const n = { path: "People/Ana.md", folder: "People/Sub", tags: ["team/eng/core", "person"] };
    expect(groupValues(n, { property: "tags", nestedLevel: 1 }, {})).toEqual(["team", "person"]);
    expect(groupValues(n, { property: "tags", nestedLevel: 2 }, {})).toEqual([
      "team/eng",
      "person",
    ]);
    expect(groupValues(n, { property: "folder", nestedLevel: 1 }, {})).toEqual(["People"]);
    expect(
      groupValues(
        n,
        { property: "Team", nestedLevel: 1 },
        { "People/Ana.md": { team: ["[[Red]]", "Blue"] } },
      ),
    ).toEqual(["Red", "Blue"]);
    expect(groupValues(n, { property: null, nestedLevel: 1 }, {})).toEqual([]);
  });

  it("anchors: one hidden node per group with weighted edges, kept in step", () => {
    const model = createModel();
    applySpec(model, spec);
    const result = computeGroups(spec.nodes, {
      rules: [],
      groupBy: { property: "folder", nestedLevel: 1 },
      props: {},
    });
    expect(syncGroups(model, result, 40)).toBe(true);
    expect(model.hasNode(`${ANCHOR_PREFIX}People`)).toBe(true);
    const groupEdges = model.filterEdges((_, a) => a.kind === "group");
    expect(groupEdges).toHaveLength(3);
    expect(model.getEdgeAttribute(groupEdges[0]!, "weight")).toBe(1);
    expect(syncGroups(model, result, 80)).toBe(false);
    expect(model.getEdgeAttribute(groupEdges[0]!, "weight")).toBe(2);
    const none = computeGroups(spec.nodes, {
      rules: [],
      groupBy: { property: null, nestedLevel: 1 },
      props: {},
    });
    syncGroups(model, none, 40);
    expect(model.hasNode(`${ANCHOR_PREFIX}People`)).toBe(false);
    // applySpec leaves anchors alone
    syncGroups(model, result, 40);
    expect(applySpec(model, spec).structural).toBe(false);
  });

  it("convex hull and centroid", () => {
    const hull = convexHull([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [2, 2],
      [1, 3],
    ]);
    expect(hull).toHaveLength(4);
    expect(
      centroid([
        [0, 0],
        [2, 2],
      ]),
    ).toEqual([1, 1]);
    expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
  });
});

describe("keyboard", () => {
  it("picks the neighbour most in the arrow direction", () => {
    const from = { x: 0, y: 0 };
    const c = [
      { key: "right", at: { x: 10, y: 1 } },
      { key: "up", at: { x: 1, y: -10 } },
      { key: "far-right", at: { x: 100, y: 0 } },
    ];
    expect(pickNeighbor(from, c, "right")).toBe("right");
    expect(pickNeighbor(from, c, "up")).toBe("up");
    expect(pickNeighbor(from, c, "left")).toBeNull();
  });
});

describe("config file", () => {
  it("defaults when missing and survives junk", () => {
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    const c = normalizeConfig({
      global: {
        filters: { tags: "yes", orphans: false },
        rules: [{ query: 1 }, { query: "tag:a", color: "#fff" }],
        groupBy: { property: "tags", nestedLevel: 9 },
      },
    });
    expect(c.global.filters.tags).toBe(false);
    expect(c.global.filters.orphans).toBe(false);
    expect(c.global.rules).toHaveLength(1);
    expect(c.global.groupBy).toEqual({ property: "tags", nestedLevel: 1 });
    expect(c.local).toEqual(DEFAULT_CONFIG.local);
    expect(() => parseConfig("{nope")).toThrow();
    expect(parseConfig(serializeConfig(c))).toEqual(c);
  });
});
