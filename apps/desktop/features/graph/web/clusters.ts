// Clusters (docs/decisions/2026-11-18-cluster-the-graph-...): the automatic grouping of the graph.
// `communities` names what Louvain found (`communities.ts`, run in the worker): the most-linked note
// of a cluster is its name, its most common tag the subtitle, and clusters of fewer than three
// notes join "Other". `folder` groups by top-level folder. An explicit Group by wins over both.
// The result is an ordinary `GroupsResult`, so hulls, anchors, the overview and the legend need no
// special case. Pure.
import type { GroupBy, SurfaceConfig } from "./config";
import { computeGroups, type GroupsResult, type PropsByPath } from "./groups";
import type { GraphSpec, NodeSpec } from "./model";
import { OTHER_GROUP } from "./aggregate";

export const MIN_CLUSTER = 3;

const FOLDER_BY: GroupBy = { property: "folder", nestedLevel: 1 };

/** The links of `spec` as the worker's matrix (source index, target index, weight 1). */
export function clusterEdges(spec: GraphSpec): { order: number; edges: Float32Array } {
  const index = new Map(spec.nodes.map((n, i) => [n.key, i]));
  const rows: number[] = [];
  for (const e of spec.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s !== undefined && t !== undefined) rows.push(s, t, 1);
  }
  return { order: spec.nodes.length, edges: new Float32Array(rows) };
}

const byDegree = (a: NodeSpec, b: NodeSpec) => b.degree - a.degree || a.key.localeCompare(b.key);

/** Names the communities: note path to cluster name, and the subtitle (most common tag) of each
 *  name. `communities[i]` is the community of `spec.nodes[i]`; only notes are clustered. */
export function nameClusters(
  spec: GraphSpec,
  communities: ArrayLike<number>,
): { assign: Map<string, string>; subtitles: Map<string, string> } {
  const members = new Map<number, NodeSpec[]>();
  spec.nodes.forEach((n, i) => {
    if (n.kind !== "note") return;
    const c = communities[i]!;
    (members.get(c) ?? members.set(c, []).get(c)!).push(n);
  });
  const assign = new Map<string, string>();
  const subtitles = new Map<string, string>();
  const taken = new Set<string>([OTHER_GROUP]);
  const small: NodeSpec[] = [];
  // Largest first, so a name clash goes to the smaller cluster.
  const clusters = [...members.values()].sort((a, b) => b.length - a.length);
  for (const notes of clusters) {
    if (notes.length < MIN_CLUSTER) {
      small.push(...notes);
      continue;
    }
    const top = [...notes].sort(byDegree)[0]!;
    let name = top.label;
    for (let i = 2; taken.has(name); i++) name = `${top.label} (${i})`;
    taken.add(name);
    for (const n of notes) assign.set(n.path, name);
    const tag = commonTag(notes);
    if (tag) subtitles.set(name, tag);
  }
  for (const n of small) assign.set(n.path, OTHER_GROUP);
  return { assign, subtitles };
}

function commonTag(notes: readonly NodeSpec[]): string | null {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of new Set(n.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: string | null = null;
  for (const [tag, c] of counts) {
    if (best === null || c > counts.get(best)! || (c === counts.get(best)! && tag < best))
      best = tag;
  }
  return best;
}

/** The groups the surface draws: Group by if set, else the folders or the detected communities
 *  (`communities` is null until the worker answers: no grouping meanwhile). */
export function surfaceGroups(
  spec: GraphSpec,
  config: Pick<SurfaceConfig, "rules" | "groupBy" | "display">,
  props: PropsByPath,
  communities: ArrayLike<number> | null,
): GroupsResult {
  const base = { rules: config.rules, props };
  if (config.groupBy.property !== null) {
    return computeGroups(spec.nodes, { ...base, groupBy: config.groupBy });
  }
  if (config.display.clusterBy === "folder") {
    return computeGroups(spec.nodes, { ...base, groupBy: FOLDER_BY });
  }
  if (communities === null || communities.length !== spec.nodes.length) {
    return computeGroups(spec.nodes, { ...base, groupBy: { property: null, nestedLevel: 1 } });
  }
  const { assign, subtitles } = nameClusters(spec, communities);
  const result = computeGroups(spec.nodes, { ...base, groupBy: config.groupBy, assign });
  return {
    ...result,
    groups: result.groups.map((g) => ({
      ...g,
      ...(subtitles.has(g.key) ? { subtitle: subtitles.get(g.key)! } : {}),
    })),
  };
}
