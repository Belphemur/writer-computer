// Community detection (docs/decisions/2026-11-18-cluster-the-graph-...): Louvain over the notes
// and links of the slice, run in the layout worker's module (`layout-worker-core.ts`) so the main
// thread never does it. A fixed seed and a stable node order make the result a function of the
// graph alone: the same vault gives the same clusters on every open. Pure; the only importer of
// `graphology-communities-louvain`.
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { PPE } from "./layout-protocol";

export const COMMUNITY_SEED = 0x5eed;

/** mulberry32: a tiny seeded generator returning floats in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The community of each of `order` nodes (ids from 0, in order of first appearance, so equal
 *  partitions give equal arrays). `edges` holds source, target and weight per edge (`PPE`
 *  floats): parallel and opposite edges add their weights, self-loops are skipped. */
export function detectCommunities(order: number, edges: Float32Array, seed = COMMUNITY_SEED) {
  const out = new Int32Array(order);
  const graph = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
  for (let i = 0; i < order; i++) graph.addNode(i);
  for (let j = 0; j + PPE <= edges.length; j += PPE) {
    const s = edges[j]!;
    const t = edges[j + 1]!;
    const w = edges[j + 2]!;
    if (s === t) continue;
    graph.updateEdge(s, t, (a) => ({ weight: ((a.weight as number | undefined) ?? 0) + w }));
  }
  if (graph.size === 0) {
    out.forEach((_, i) => (out[i] = i));
    return out;
  }
  const raw = louvain(graph, { rng: seededRng(seed), getEdgeWeight: "weight" });
  const renumber = new Map<number, number>();
  for (let i = 0; i < order; i++) {
    const c = raw[String(i)] ?? i;
    if (!renumber.has(c)) renumber.set(c, renumber.size);
    out[i] = renumber.get(c)!;
  }
  return out;
}
