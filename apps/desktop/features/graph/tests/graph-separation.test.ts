// The layout keeps clusters apart and finite (SPECs/graph-view-spec.md, "Layout"). A synthetic
// vault of planted communities runs through the real ForceAtlas2 iterations with the shipped
// settings; the metric is the separation ratio: the mean over clusters of the distance to the
// nearest other cluster's centroid divided by the cluster's mean radius. Above 1 the nearest
// neighbours are more than a radius apart; hulls (about 1.5 radii wide) stop overlapping near 2.
// Measured with the shipped settings: about 10 at 90% intra links and 4.5 at 60%; unseeded starts
// with equal weights gave 2.1 at 60%, which is the overlapping mud of the bug report.
import { describe, expect, it } from "vite-plus/test";
import { computeGroups, syncGroups } from "../web/groups";
import { DEFAULT_FORCES, forcesToSettings } from "../web/layout";
import { PPN, buildMatrices, INTER_GROUP_WEIGHT } from "../web/layout-protocol";
import { createLayoutHandler } from "../web/layout-worker-core";
import { applySpec, createModel, type EdgeSpec, type NodeSpec } from "../web/model";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function planted(n: number, k: number, intra: number) {
  const r = rng(7);
  const nodes: NodeSpec[] = Array.from({ length: n }, (_, i) => ({
    key: `n${i}.md`,
    kind: "note",
    label: `n${i}`,
    path: `n${i}.md`,
    folder: "",
    tags: [],
    degree: 3,
    cardValue: null,
  }));
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) {
      let t = Math.floor(r() * n);
      if (r() < intra) t = t - (t % k) + (i % k);
      if (t >= n) t = i % k;
      if (t === i) continue;
      const part = {
        kind: "link" as const,
        label: null,
        from: `n${i}.md`,
        to: `n${t}.md`,
        count: 1,
      };
      edges.push({
        key: `e${i}-${j}`,
        source: part.from,
        target: part.to,
        ...part,
        parts: [part],
        directed: true,
      });
    }
  }
  const model = createModel();
  applySpec(model, { nodes, edges });
  const assign = new Map(nodes.map((nd, i) => [nd.path, `c${i % k}`]));
  const groups = computeGroups(nodes, {
    rules: [],
    groupBy: { property: null, nestedLevel: 1 },
    props: {},
    assign,
  });
  syncGroups(model, groups, DEFAULT_FORCES.groupPull);
  return model;
}

function layoutAndMeasure(n: number, k: number, intra: number, batches: number) {
  const model = planted(n, k, intra);
  const m = buildMatrices(model);
  let last = m.nodes;
  const handle = createLayoutHandler((msg) => {
    last = (msg as { nodes: Float32Array }).nodes;
  });
  handle({
    type: "init",
    nodes: m.nodes,
    edges: m.edges,
    settings: forcesToSettings(DEFAULT_FORCES, model.order),
  });
  for (let b = 1; b < batches; b++) handle({ type: "step", nodes: last });
  const byGroup = new Map<string, [number, number][]>();
  let finite = true;
  m.keys.forEach((key, i) => {
    const x = last[i * PPN]!;
    const y = last[i * PPN + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) finite = false;
    const a = model.getNodeAttributes(key);
    if (a.anchor || !a.group) return;
    (byGroup.get(a.group) ?? byGroup.set(a.group, []).get(a.group)!).push([x, y]);
  });
  const cs = [...byGroup.values()].map((ps) => {
    const cx = ps.reduce((s, p) => s + p[0], 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p[1], 0) / ps.length;
    return { cx, cy, r: ps.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / ps.length };
  });
  let sum = 0;
  for (const c of cs) {
    const near = Math.min(
      ...cs.filter((o) => o !== c).map((o) => Math.hypot(c.cx - o.cx, c.cy - o.cy)),
    );
    sum += near / c.r;
  }
  return { finite, separation: sum / cs.length };
}

describe("layout separation", () => {
  it("keeps 6 planted communities of 249 notes apart and finite (90% links inside)", () => {
    const { finite, separation } = layoutAndMeasure(249, 6, 0.9, 150);
    expect(finite).toBe(true);
    expect(separation).toBeGreaterThan(5);
  });

  it("still separates them when only 60% of the links stay inside", () => {
    const { finite, separation } = layoutAndMeasure(249, 6, 0.6, 150);
    expect(finite).toBe(true);
    expect(separation).toBeGreaterThan(3);
  });

  it("holds at 1,000 notes", () => {
    const { finite, separation } = layoutAndMeasure(1000, 6, 0.8, 60);
    expect(finite).toBe(true);
    expect(separation).toBeGreaterThan(3);
  }, 30_000);

  it("pulls across-group links lighter than links inside a group", () => {
    const model = planted(60, 3, 0.5);
    const { edges } = buildMatrices(model);
    const weights = new Set(Array.from({ length: edges.length / 3 }, (_, i) => edges[i * 3 + 2]));
    expect(weights.has(INTER_GROUP_WEIGHT)).toBe(true);
    expect(weights.has(1)).toBe(true);
  });
});
