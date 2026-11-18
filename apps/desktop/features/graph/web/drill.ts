// Collapsed clusters with drill-down (spec 13.1): the whole-vault graph first draws one node per
// cluster (sized by its note count, joined by lines whose width follows the link count between the
// two clusters), so a heavily linked vault is six bubbles instead of a ball. A click opens one
// cluster alone: its notes and links, plus one small stub per other cluster it links to ("-> Name
// (n)", n the links), which opens that cluster. Both are ordinary `GraphSpec`s of `cluster` nodes
// and notes, so layout, camera fit, hover and labels are the graph's own. Pure.
import type { Overview } from "./aggregate";
import type { GraphSpec, NodeSpec, EdgeSpec } from "./model";

export const CLUSTER_PREFIX = "cluster:";
export const clusterKey = (group: string) => `${CLUSTER_PREFIX}${group}`;

function clusterNode(group: string, label: string, count: number, color: string): NodeSpec {
  return {
    key: clusterKey(group),
    kind: "cluster",
    label,
    path: "",
    folder: "",
    tags: [],
    degree: count,
    cardValue: null,
    cluster: group,
    tint: color,
  };
}

function link(a: string, b: string, count: number): EdgeSpec {
  const part = { kind: "link" as const, label: null, from: a, to: b, count };
  return {
    key: `${a}\u0000${b}`,
    source: a,
    target: b,
    kind: "link",
    label: null,
    count,
    parts: [part],
    directed: false,
  };
}

/** One node per bubble and one edge per pair of clusters (`aggregate.ts` did the counting). */
export function collapsedSpec(overview: Overview): GraphSpec {
  return {
    nodes: overview.bubbles.map((b) =>
      clusterNode(b.key, `${b.key} (${b.count})`, b.count, b.color),
    ),
    edges: overview.links.map((l) => link(clusterKey(l.a), clusterKey(l.b), l.count)),
  };
}

/** The notes of cluster `group` with their links, and a stub for every other cluster they link
 *  to, joined to each note that links there (the bundle of cross-cluster links). */
export function drilledSpec(
  spec: GraphSpec,
  groupOf: (key: string) => string | null,
  colorOf: (group: string) => string,
  group: string,
): GraphSpec {
  const inside = new Set(spec.nodes.filter((n) => groupOf(n.key) === group).map((n) => n.key));
  const nodes = spec.nodes.filter((n) => inside.has(n.key));
  const edges: EdgeSpec[] = [];
  const stubs = new Map<string, { links: number; notes: Map<string, number> }>();
  for (const e of spec.edges) {
    const a = inside.has(e.source);
    const b = inside.has(e.target);
    if (a && b) {
      edges.push(e);
      continue;
    }
    if (!a && !b) continue;
    const note = a ? e.source : e.target;
    const other = groupOf(a ? e.target : e.source);
    if (other === null) continue;
    const stub = stubs.get(other) ?? stubs.set(other, { links: 0, notes: new Map() }).get(other)!;
    stub.links += e.count;
    stub.notes.set(note, (stub.notes.get(note) ?? 0) + e.count);
  }
  for (const [other, stub] of [...stubs].sort((x, y) => y[1].links - x[1].links)) {
    nodes.push(clusterNode(other, `→ ${other} (${stub.links})`, 1, colorOf(other)));
    for (const [note, count] of stub.notes) edges.push(link(note, clusterKey(other), count));
  }
  return { nodes, edges };
}
