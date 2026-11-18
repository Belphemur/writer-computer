// "Links per note" (spec 3.2): each note keeps its strongest `k` merged links, and a link stays
// when it is in the top `k` of either end, so a quiet note keeps its few links to a hub while the
// hub's hundreds fall away. Strength is the link count, plus one for a pair that links both ways
// and one for a pair inside the same cluster. Computed once per spec (never per frame). Pure.
import type { EdgeSpec, GraphSpec } from "./model";

export const edgeStrength = (e: EdgeSpec, sameGroup: boolean): number =>
  e.count + (new Set(e.parts.map((p) => p.from)).size > 1 ? 1 : 0) + (sameGroup ? 1 : 0);

/** `spec` with only the edges in the top `k` of either endpoint; `k` of 0 keeps everything.
 *  `groupOf` maps a node key to its cluster (null for none). Nodes are never dropped. */
export function topLinks(
  spec: GraphSpec,
  k: number,
  groupOf: (key: string) => string | null,
): GraphSpec {
  if (k <= 0) return spec;
  const strength = new Map<string, number>();
  const incident = new Map<string, EdgeSpec[]>();
  for (const e of spec.edges) {
    const g = groupOf(e.source);
    strength.set(e.key, edgeStrength(e, g !== null && g === groupOf(e.target)));
    for (const end of [e.source, e.target]) {
      (incident.get(end) ?? incident.set(end, []).get(end)!).push(e);
    }
  }
  const keep = new Set<string>();
  for (const edges of incident.values()) {
    edges.sort((a, b) => strength.get(b.key)! - strength.get(a.key)! || a.key.localeCompare(b.key));
    for (const e of edges.slice(0, k)) keep.add(e.key);
  }
  return keep.size === spec.edges.length
    ? spec
    : { nodes: spec.nodes, edges: spec.edges.filter((e) => keep.has(e.key)) };
}
