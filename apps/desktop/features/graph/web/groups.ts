// Groups (SPECs/graph-view-spec.md 3.4): ordered color rules (first match wins) and Group by a
// property, which clusters notes that share a value. Pure, except `syncGroups`, which writes the
// result into the model: `color` and `group` on the notes, and one hidden anchor node per group
// with a light edge from every member, so ForceAtlas2 pulls the cluster together without any
// custom force (the "group pull" setting is that edge's weight). Hull geometry is here too, so it
// is testable without a canvas.
import type { ColorRule, GroupBy } from "./config";
import { hash, type GraphModel, type NodeAttrs } from "./model";
import { matches, parseQuery, valuesOf, type Matchable, type Query } from "./query";
import { groupColor } from "./theme";

export const ANCHOR_PREFIX = "group:";

export type PropsByPath = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface GroupsInput {
  rules: readonly ColorRule[];
  groupBy: GroupBy;
  props: PropsByPath;
  /** Group of each note path decided elsewhere (detected clusters): replaces `groupBy`. */
  assign?: ReadonlyMap<string, string>;
}

const top = (value: string, level: number) => value.split("/").slice(0, level).join("/");

/** The group values of a note for `groupBy`: tags and folders honour the nested level. */
export function groupValues(
  n: Pick<NodeAttrs, "tags" | "folder" | "path">,
  groupBy: GroupBy,
  props: PropsByPath,
): string[] {
  const { property, nestedLevel } = groupBy;
  if (property === null) return [];
  const raw =
    property === "tags"
      ? n.tags.map((t) => t.replace(/^#/, ""))
      : property === "folder"
        ? n.folder
          ? [n.folder]
          : []
        : valuesOf(propValue(props[n.path], property));
  const levelled =
    property === "tags" || property === "folder" ? raw.map((v) => top(v, nestedLevel)) : raw;
  return [...new Set(levelled.filter(Boolean))];
}

function propValue(props: Readonly<Record<string, unknown>> | undefined, name: string): unknown {
  if (!props) return undefined;
  const key = Object.keys(props).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : props[key];
}

/** The first rule whose query matches the note, or `null`. Rules are parsed once by the caller. */
export function firstRule(
  rules: readonly { query: Query; color: string }[],
  m: Matchable,
): string | null {
  for (const r of rules) if (r.query.length > 0 && matches(r.query, m)) return r.color;
  return null;
}

export interface NodeGroupInfo {
  group: string | null;
  extra: string[];
  color: string | null;
}

export interface GroupsResult {
  nodes: Map<string, NodeGroupInfo>;
  /** Sorted group keys with their color (the legend and the hull colors). */
  groups: { key: string; color: string; size: number; subtitle?: string }[];
}

/** Assigns every note its color and group. A rule wins over the group color; a note with several
 *  values joins the first value's group and lists the rest as `extra`. */
export function computeGroups(
  nodes: Iterable<Pick<NodeAttrs, "kind" | "path" | "label" | "tags" | "folder">>,
  input: GroupsInput,
): GroupsResult {
  const rules = input.rules.map((r) => ({ query: parseQuery(r.query), color: r.color }));
  const members = new Map<string, number>();
  const per = new Map<string, { values: string[]; rule: string | null; key: string }>();
  for (const n of nodes) {
    if (n.kind !== "note") continue;
    const assigned = input.assign?.get(n.path);
    const values = input.assign
      ? assigned === undefined
        ? []
        : [assigned]
      : groupValues(n, input.groupBy, input.props);
    const rule = firstRule(rules, {
      path: n.path,
      name: n.label,
      tags: n.tags,
      props: input.props[n.path],
    });
    per.set(n.path, { values, rule, key: n.path });
    if (values[0] !== undefined) members.set(values[0], (members.get(values[0]) ?? 0) + 1);
  }
  const keys = [...members.keys()].sort((a, b) => a.localeCompare(b));
  const result = new Map<string, NodeGroupInfo>();
  for (const [path, p] of per) {
    const group = p.values[0] ?? null;
    result.set(path, {
      group,
      extra: p.values.slice(1),
      color: p.rule ?? (group !== null ? groupColor(group, keys) : null),
    });
  }
  return {
    nodes: result,
    groups: keys.map((key) => ({ key, color: groupColor(key, keys), size: members.get(key)! })),
  };
}

/** Group pull to ForceAtlas2 edge weight (`graph.force-group-pull`, 0 to 100; 40 is weight 1). */
export const anchorWeight = (pull: number) => Math.max(0, pull) / 40;

/** Writes colors and groups into the model, and keeps one anchor node per group (with a weighted
 *  edge from each member) in step. Returns whether anchors or their edges changed, which asks the
 *  layout for a rebuild. */
export function syncGroups(graph: GraphModel, result: GroupsResult, pull: number): boolean {
  let structural = false;
  let regrouped = false;
  graph.forEachNode((key, a) => {
    if (a.anchor || a.kind === "cluster") return;
    const info = result.nodes.get(a.path);
    if ((info?.group ?? null) !== a.group) regrouped = true;
    graph.mergeNodeAttributes(key, {
      color: info?.color ?? null,
      group: info?.group ?? null,
      groupExtra: info?.extra ?? [],
    });
  });

  const wanted = new Set(result.groups.map((g) => `${ANCHOR_PREFIX}${g.key}`));
  for (const key of graph.nodes()) {
    if (graph.getNodeAttribute(key, "anchor") && !wanted.has(key)) {
      graph.dropNode(key);
      structural = true;
    }
  }
  const weight = anchorWeight(pull);
  for (const g of result.groups) {
    const anchor = `${ANCHOR_PREFIX}${g.key}`;
    if (!graph.hasNode(anchor)) {
      graph.addNode(anchor, anchorAttrs(g.key));
      structural = true;
    }
  }
  // Member edges: add what is missing, drop what no longer holds, refresh the weight.
  const members = new Map<string, string>();
  graph.forEachNode((key, a) => {
    if (!a.anchor && a.group !== null) members.set(key, `${ANCHOR_PREFIX}${a.group}`);
  });
  for (const key of graph.edges()) {
    if (graph.getEdgeAttribute(key, "kind") !== "group") continue;
    const source = graph.source(key);
    if (members.get(source) !== graph.target(key)) {
      graph.dropEdge(key);
      structural = true;
    } else graph.setEdgeAttribute(key, "weight", weight);
  }
  for (const [member, anchor] of members) {
    const key = `${member}\u0000${anchor}\u0000group`;
    if (graph.hasEdge(key)) continue;
    graph.addEdgeWithKey(key, member, anchor, {
      kind: "group",
      label: null,
      count: 1,
      parts: [],
      directed: false,
      weight,
    });
    structural = true;
  }
  if (regrouped) seedGroups(graph, result);
  return structural;
}

/** Ring radius per sqrt(node count) and island radius per sqrt(group size), in layout units: sized
 *  near where ForceAtlas2 settles so a run starts close to its answer instead of exploding. */
const SEED_RING = 14;
const SEED_ISLAND = 8;

/** Seeds a new grouping so the layout starts with separate islands: each group's centre on a ring
 *  around the origin, its members scattered (by a stable hash) around the centre, its anchor on the
 *  centre. Pinned notes keep their place. Groups are known before the layout runs for the new
 *  grouping, which is what lets it end with clusters apart instead of one overlapping ball. */
export function seedGroups(graph: GraphModel, result: GroupsResult): void {
  const k = result.groups.length;
  if (k === 0) return;
  const ring = k > 1 ? Math.sqrt(graph.order) * SEED_RING : 0;
  result.groups.forEach((g, i) => {
    const angle = (i / k) * Math.PI * 2;
    const cx = Math.cos(angle) * ring;
    const cy = Math.sin(angle) * ring;
    const anchor = `${ANCHOR_PREFIX}${g.key}`;
    if (graph.hasNode(anchor)) graph.mergeNodeAttributes(anchor, { x: cx, y: cy });
    const radius = Math.sqrt(g.size) * SEED_ISLAND;
    graph.forEachNode((key, a) => {
      if (a.anchor || a.fixed || a.group !== g.key) return;
      const h = hash(key);
      const theta = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const r = Math.sqrt((h >>> 16) / 0xffff) * radius;
      graph.mergeNodeAttributes(key, { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r });
    });
  });
}

function anchorAttrs(group: string): NodeAttrs {
  return {
    key: `${ANCHOR_PREFIX}${group}`,
    kind: "tag",
    label: group,
    path: "",
    folder: "",
    tags: [],
    degree: 0,
    cardValue: null,
    x: 0,
    y: 0,
    size: 0.1,
    color: null,
    group: null,
    groupExtra: [],
    anchor: true,
  };
}

// -- hulls --------------------------------------------------------------------------------------

export type Point = readonly [number, number];

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull of `points` (Andrew's monotone chain), counter-clockwise. One or two points give
 *  themselves. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}
