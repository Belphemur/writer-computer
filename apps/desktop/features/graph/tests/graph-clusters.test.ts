// Clusters: Louvain is deterministic (same graph, same clusters, with a fixed seed), the naming
// rules (most-linked note, most common tag, "Other" under three notes), folder mode and the
// precedence of an explicit Group by, the worker message and the 10,000-node budget.
import { describe, expect, it } from "vite-plus/test";
import { OTHER_GROUP } from "../web/aggregate";
import { clusterEdges, nameClusters, surfaceGroups, MIN_CLUSTER } from "../web/clusters";
import { COMMUNITY_SEED, detectCommunities, seededRng } from "../web/communities";
import { DEFAULT_DISPLAY, DEFAULT_FILTERS, DEFAULT_SURFACE } from "../web/config";
import { detectInWorker, type WorkerLike } from "../web/layout-worker-client";
import { createLayoutHandler } from "../web/layout-worker-core";
import type { WorkerResponse } from "../web/layout-protocol";
import { buildSpec, type GraphSpec } from "../web/model";
import { bigSlice, edge, node } from "./fixtures";

/** Two dense groups of `size` notes joined by one bridge, in two folders. */
function twoCliques(size: number) {
  const nodes = [];
  const edges = [];
  let id = 1;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < size; i++) {
      nodes.push(
        node(c * size + i + 1, `${c ? "Beta" : "Alpha"}/n${i}.md`, {
          tags: [c ? "#beta" : "#alpha"],
          degreeOut: i === 0 ? size : 1,
        }),
      );
    }
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) edges.push(edge(id++, c * size + i + 1, c * size + j + 1));
    }
  }
  edges.push(edge(id++, 1, size + 1));
  return buildSpec(
    { nodes, edges, truncated: false, limit: 10_000, epoch: 1 },
    DEFAULT_FILTERS,
  ) as GraphSpec;
}

const communitiesOf = (spec: GraphSpec) => {
  const { order, edges } = clusterEdges(spec);
  return detectCommunities(order, edges);
};

describe("detectCommunities", () => {
  it("finds the two dense groups and is the same on every run", () => {
    const spec = twoCliques(6);
    const a = communitiesOf(spec);
    const b = communitiesOf(spec);
    expect([...a]).toEqual([...b]);
    expect(new Set(a).size).toBe(2);
    expect(new Set([...a].slice(0, 6)).size).toBe(1);
    expect(new Set([...a].slice(6)).size).toBe(1);
    expect(a[0]).toBe(0);
  });

  it("numbers communities by first appearance and gives edgeless nodes their own", () => {
    expect([...detectCommunities(3, new Float32Array(0))]).toEqual([0, 1, 2]);
  });

  it("the generator is seeded", () => {
    const a = seededRng(COMMUNITY_SEED);
    const b = seededRng(COMMUNITY_SEED);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("naming", () => {
  it("names a cluster by its most-linked note and subtitles it with its most common tag", () => {
    const spec = twoCliques(4);
    const { assign, subtitles } = nameClusters(spec, communitiesOf(spec));
    expect(new Set(assign.values())).toEqual(new Set(["n0", "n0 (2)"]));
    expect(assign.get("Alpha/n1.md")).toBe(assign.get("Alpha/n0.md"));
    expect(subtitles.get(assign.get("Alpha/n0.md")!)).toBe("#alpha");
    expect(subtitles.get(assign.get("Beta/n0.md")!)).toBe("#beta");
  });

  it("puts clusters under three notes in Other", () => {
    expect(MIN_CLUSTER).toBe(3);
    const spec = twoCliques(2);
    const { assign } = nameClusters(spec, communitiesOf(spec));
    expect(new Set(assign.values())).toEqual(new Set([OTHER_GROUP]));
  });
});

describe("surfaceGroups", () => {
  const spec = twoCliques(4);
  const config = (patch: Partial<typeof DEFAULT_SURFACE>) => ({ ...DEFAULT_SURFACE, ...patch });

  it("communities by default; nothing until the worker answers", () => {
    expect(surfaceGroups(spec, DEFAULT_SURFACE, {}, null).groups).toEqual([]);
    const groups = surfaceGroups(spec, DEFAULT_SURFACE, {}, communitiesOf(spec));
    expect(groups.groups.map((g) => g.size)).toEqual([4, 4]);
    expect(groups.groups.every((g) => g.subtitle !== undefined)).toBe(true);
  });

  it("ignores an answer for another graph", () => {
    expect(surfaceGroups(spec, DEFAULT_SURFACE, {}, new Int32Array(3)).groups).toEqual([]);
  });

  it("folder mode groups by top-level folder", () => {
    const groups = surfaceGroups(
      spec,
      config({ display: { ...DEFAULT_DISPLAY, clusterBy: "folder" } }),
      {},
      null,
    );
    expect(groups.groups.map((g) => g.key)).toEqual(["Alpha", "Beta"]);
  });

  it("an explicit Group by wins over both", () => {
    for (const clusterBy of ["communities", "folder"] as const) {
      const groups = surfaceGroups(
        spec,
        config({
          display: { ...DEFAULT_DISPLAY, clusterBy },
          groupBy: { property: "tags", nestedLevel: 1 },
        }),
        {},
        communitiesOf(spec),
      );
      expect(groups.groups.map((g) => g.key)).toEqual(["alpha", "beta"]);
    }
  });
});

describe("in the worker", () => {
  it("the handler answers a cluster request with the communities", () => {
    const posted: WorkerResponse[] = [];
    const handle = createLayoutHandler((m) => posted.push(m));
    const spec = twoCliques(4);
    const { order, edges } = clusterEdges(spec);
    handle({ type: "cluster", order, edges });
    expect([...(posted[0] as { communities: Int32Array }).communities]).toEqual([
      ...communitiesOf(spec),
    ]);
  });

  it("detectInWorker resolves with the reply and ends the worker", async () => {
    let listener: (e: MessageEvent<WorkerResponse>) => void = () => {};
    let terminated = 0;
    const fake: WorkerLike = {
      postMessage: () =>
        listener({ data: { communities: Int32Array.of(0, 1) } } as MessageEvent<WorkerResponse>),
      terminate: () => terminated++,
      addEventListener: (_t, l) => (listener = l),
    };
    const { result } = detectInWorker(2, new Float32Array(0), () => fake);
    expect([...(await result)]).toEqual([0, 1]);
    expect(terminated).toBe(1);
  });
});

describe("10,000 notes", () => {
  it("detects communities within the budget (it runs in a worker, off the main thread)", () => {
    const spec = buildSpec(bigSlice(10_000), DEFAULT_FILTERS);
    const { order, edges } = clusterEdges(spec);
    const t0 = performance.now();
    const c = detectCommunities(order, edges);
    const ms = performance.now() - t0;
    expect(c).toHaveLength(order);
    // Loose on purpose (shared CI machines); the real figure is reported by the spec's table.
    expect(ms).toBeLessThan(15_000);
  });
});
