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
}

/** Iterations the worker runs before it posts positions (one frame's worth of work). */
export const BATCH_ITERATIONS = 4;

export type WorkerRequest =
  /** First message: both matrices and the settings; the worker keeps the edges. */
  | { type: "init"; nodes: Float32Array; edges: Float32Array; settings: FA2Settings }
  /** Next batch: the node matrix handed back after the main thread read the positions. */
  | { type: "step"; nodes: Float32Array };

export interface WorkerResponse {
  nodes: Float32Array;
}

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
    nodes[s + 6] += a.weight;
    nodes[t + 6] += a.weight;
    edges[j] = s;
    edges[j + 1] = t;
    edges[j + 2] = a.weight;
    j += PPE;
  });
  return { nodes, edges, keys };
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
