// Aggregation for the overview level: one bubble per group (its note count) and one line per pair
// of groups (the number of links between them). Computed once per graph or grouping change, never
// per frame; the canvas only places the bubbles at their members' centroid and swaps visibility at
// the level boundary. Pure.
import type { GraphSpec } from "./model";

export interface Bubble {
  key: string;
  count: number;
  color: string;
  members: string[];
}

export interface GroupLink {
  a: string;
  b: string;
  /** Links between the two groups (every note-level edge counted by its own `count`). */
  count: number;
}

export interface Overview {
  /** "groups": bubbles; "hubs": no grouping applies, the top hubs are drawn instead. */
  mode: "groups" | "hubs";
  bubbles: Bubble[];
  links: GroupLink[];
}

export const OTHER_GROUP = "Other";

/**
 * `groupOf` maps a note path to its group (null for none). Notes without a group join "Other";
 * tags, missing notes and attachments follow the notes they link with only through edges, so they
 * are not counted. Fewer than two groups means grouping gives no overview: the hubs mode.
 */
export function aggregate(
  spec: GraphSpec,
  groupOf: (path: string) => string | null,
  colorOf: (group: string) => string,
): Overview {
  const memberGroup = new Map<string, string>();
  const bubbles = new Map<string, Bubble>();
  for (const n of spec.nodes) {
    if (n.kind !== "note") continue;
    const key = groupOf(n.path) ?? OTHER_GROUP;
    memberGroup.set(n.key, key);
    const b = bubbles.get(key) ?? { key, count: 0, color: colorOf(key), members: [] };
    b.count += 1;
    b.members.push(n.key);
    bubbles.set(key, b);
  }
  if (bubbles.size < 2) return { mode: "hubs", bubbles: [], links: [] };

  const links = new Map<string, GroupLink>();
  for (const e of spec.edges) {
    const a = memberGroup.get(e.source);
    const b = memberGroup.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}\u0000${hi}`;
    const link = links.get(key) ?? { a: lo, b: hi, count: 0 };
    link.count += e.count;
    links.set(key, link);
  }
  return {
    mode: "groups",
    bubbles: [...bubbles.values()].sort((x, y) => y.count - x.count || x.key.localeCompare(y.key)),
    links: [...links.values()].sort((x, y) => y.count - x.count),
  };
}

export const HUBS_OVERVIEW: Overview = { mode: "hubs", bubbles: [], links: [] };
