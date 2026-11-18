// What the layout worker and its supervisor share: the flat matrices ForceAtlas2 iterates (the same
// layout `graphology-layout-forceatlas2` builds: 10 floats per node, 3 per edge), the messages, and
// the two conversions between a graphology graph and the matrices. Pure, so it is tested without a
// worker.
import type { GraphModel } from "./model";

export const PPN = 10;
export const PPE = 3;
const NODE_FIXED = 9;

export interface FA2Settings {
  gravity: number;
  scalingRatio: number;
  edgeWeightInfluence: number;
  barnesHutOptimize: boolean;
  slowDown: number;
  /** Attraction grows with the log of the distance: tight clusters, wide gaps between them. */
  linLogMode: boolean;
  /** Hubs pull their neighbours less (attraction shared by degree). */
  outboundAttractionDistribution: boolean;
}

/** Layout weight of an edge between two different groups, against 1 within a group (the count
 *  still multiplies it): links inside a cluster pull harder than links across clusters. */
export const INTER_GROUP_WEIGHT = 0.25;

/** Iterations the worker runs before it posts positions (one frame's worth of work). */
export const BATCH_ITERATIONS = 4;

export type WorkerRequest =
  /** First message: both matrices and the settings; the worker keeps the edges. */
  | { type: "init"; nodes: Float32Array; edges: Float32Array; settings: FA2Settings }
  /** Next batch: the node matrix handed back after the main thread read the positions. */
  | { type: "step"; nodes: Float32Array }
  /** One-shot community detection over `order` nodes (`PPE` floats per edge). */
  | { type: "cluster"; order: number; edges: Float32Array };

export type WorkerResponse = { nodes: Float32Array } | { communities: Int32Array };

export interface Matrices {
  nodes: Float32Array;
  edges: Float32Array;
  /** Node keys in matrix order, to apply positions back. */
  keys: string[];
}

/** The graph as matrices: positions, mass (weighted degree), size and the pinned (`fixed`) flag
 *  per node, source, target and weight per edge. Group anchors are ordinary nodes here. */
export function buildMatrices(graph: GraphModel): Matrices {
  const nodes = new Float32Array(graph.order * PPN);
  const edges = new Float32Array(graph.size * PPE);
  const index = new Map<string, number>();
  const keys: string[] = [];
  let j = 0;
  graph.forEachNode((key, a) => {
    index.set(key, j);
    keys.push(key);
    nodes[j] = a.x;
    nodes[j + 1] = a.y;
    nodes[j + 6] = 1; // mass
    nodes[j + 7] = 1; // convergence
    nodes[j + 8] = a.size || 1;
    nodes[j + NODE_FIXED] = a.fixed ? 1 : 0;
    j += PPN;
  });
  j = 0;
  graph.forEachEdge((_key, a, source, target) => {
    const s = index.get(source)!;
    const t = index.get(target)!;
    const gs = graph.getNodeAttribute(source, "group");
    const gt = graph.getNodeAttribute(target, "group");
    const w =
      a.kind !== "group" && gs !== null && gt !== null && gs !== gt
        ? a.weight * INTER_GROUP_WEIGHT
        : a.weight;
    nodes[s + 6] += w;
    nodes[t + 6] += w;
    edges[j] = s;
    edges[j + 1] = t;
    edges[j + 2] = w;
    j += PPE;
  });
  return { nodes, edges, keys };
}

/** How many nodes of `matrix` have a non-finite position. */
export function nonFinitePositions(matrix: Float32Array): number {
  let bad = 0;
  for (let i = 0; i < matrix.length; i += PPN) {
    if (!Number.isFinite(matrix[i]) || !Number.isFinite(matrix[i + 1])) bad++;
  }
  return bad;
}

/** Writes the positions of `matrix` back into the graph; pinned nodes keep theirs. Returns false
 *  (and writes nothing) when the matrix no longer matches the graph. */
export function applyPositions(
  graph: GraphModel,
  keys: readonly string[],
  matrix: Float32Array,
): boolean {
  if (matrix.length !== keys.length * PPN || graph.order !== keys.length) return false;
  keys.forEach((key, i) => {
    if (!graph.hasNode(key)) return;
    const a = graph.getNodeAttributes(key);
    if (a.fixed) return;
    graph.mergeNodeAttributes(key, { x: matrix[i * PPN]!, y: matrix[i * PPN + 1]! });
  });
  return true;
}
