// The one graph model of the feature (docs/decisions/2026-11-17-render-the-graph-view-...): a
// `GraphSlice` becomes a plain `GraphSpec` (pure; the filters of the view are applied here, so the
// layout only sees what is shown), and `applySpec` brings a graphology `Graph` to that spec IN
// PLACE, keyed by path: nodes that are still there keep their position and pin, removed ones are
// dropped, new ones are added next to their neighbours. Used by the graph tab.
// Everything the renderer needs per node and edge (kind, size, label) lives in attributes; style
// is decided by the sigma reducers (`reducers.ts`), never here.
import { excludes, inFolder } from "./exclude";
import Graph from "graphology";
import { KIND_FILTER, type GraphFilters } from "./config";
import type { GraphEdgeKind, GraphNode, GraphSlice } from "./ipc";
import { matches, needsProps, parseQuery, type Matchable } from "./query";

/** `cluster` is a whole cluster drawn as one node (the collapsed whole-vault view) or the stub of
 *  another cluster in a drilled-down one (`drill.ts`): a click opens that cluster. */
export type NodeKind = "note" | "tag" | "attachment" | "base" | "missing" | "cluster";
export type EdgeKind = GraphEdgeKind | "tag";

/** What a node is, independent of the renderer. `key` is the vault-relative path (graphology key);
 *  a tag is `#tag`, a missing note `?link text`. */
export interface NodeSpec {
  key: string;
  kind: NodeKind;
  label: string;
  /** Vault-relative path to open; empty for tags and missing notes. */
  path: string;
  folder: string;
  tags: string[];
  degree: number;
  /** The close-up card's type or status text, from `GraphNode.cardValue`. */
  cardValue: string | null;
  /** A `cluster` node: the cluster it opens. */
  cluster?: string;
  /** A `cluster` node's own colour (it is in no group, so the groups sync leaves it alone). */
  tint?: string;
}

/** One relationship between two notes, before the pair is merged into one drawn edge. */
export interface EdgePart {
  kind: EdgeKind;
  /** The property name of a `property` part. */
  label: string | null;
  from: string;
  to: string;
  count: number;
}

/** One link of one kind between a pair, as the slice has it (merged by `mergePairs`). */
export interface RawEdge extends EdgePart {
  key: string;
  source: string;
  target: string;
}

/** The one edge drawn between two notes, whatever links them (every kind, both directions). `kind`
 *  and `label` are the pair's own only when every part shares them (else a plain `link`), so the
 *  colour is neutral unless the whole edge is one property. */
export interface EdgeSpec {
  key: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string | null;
  /** How many links between the pair this one edge stands for. */
  count: number;
  /** What makes the link, for the hover line. */
  parts: EdgePart[];
  /** Every part runs from `source` to `target`: the only case that draws an arrow. */
  directed: boolean;
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

/** graphology attributes. `x`/`y`/`fixed` belong to the layout; the rest is set by the spec, the
 *  groups sync (`color`, `group`) and the layout's anchors. */
export interface NodeAttrs extends NodeSpec {
  x: number;
  y: number;
  size: number;
  fixed?: boolean;
  /** Resolved color from color rules or the group; `null` means the accent. */
  color: string | null;
  group: string | null;
  /** Other group values of a multi-valued note (thin link to their hulls). */
  groupExtra: string[];
  /** A hidden helper node that pulls its group together (`groups.ts`). */
  anchor?: boolean;
}

export interface EdgeAttrs {
  kind: EdgeKind | "group";
  label: string | null;
  count: number;
  parts: EdgePart[];
  directed: boolean;
  /** ForceAtlas2 weight (the link count; the layout lowers it between clusters). */
  weight: number;
}

export type GraphModel = Graph<NodeAttrs, EdgeAttrs>;

export function createModel(): GraphModel {
  return new Graph<NodeAttrs, EdgeAttrs>({ type: "directed", multi: true, allowSelfLoops: false });
}

// -- node facts ---------------------------------------------------------------------------------

const stripMd = (name: string) => name.replace(/\.md$/i, "");

export function nodeKindOf(n: Pick<GraphNode, "ext" | "unresolved">): NodeKind {
  if (n.unresolved) return "missing";
  const ext = n.ext.replace(/^\./, "").toLowerCase();
  if (ext === "base") return "base";
  return ext === "md" || ext === "" || ext === "markdown" ? "note" : "attachment";
}

/** The key of a slice node: its path; a missing note is keyed apart from a real note of that name. */
export function nodeKey(n: Pick<GraphNode, "path" | "name" | "unresolved">): string {
  return n.unresolved ? `?${n.path || n.name}` : n.path;
}

const SIZE_BASE = 3;
const SIZE_K = 1.4;
const SIZE_MAX = 18;

/** `base + k * sqrt(degree)`, capped (spec 3.1). */
export function sizeForDegree(degree: number): number {
  return Math.min(SIZE_MAX, SIZE_BASE + SIZE_K * Math.sqrt(Math.max(0, degree)));
}

/** A cluster node's size follows its note count (bubbles are bigger than notes), capped. */
export const sizeForCluster = (count: number): number =>
  Math.min(40, 8 + 2.2 * Math.sqrt(Math.max(0, count)));

const sizeOf = (n: NodeSpec) =>
  n.kind === "cluster" ? sizeForCluster(n.degree) : sizeForDegree(n.degree);

const parentTag = (tag: string) => (tag.includes("/") ? tag.slice(0, tag.lastIndexOf("/")) : null);

// -- slice to spec ------------------------------------------------------------------------------

/** Frontmatter per vault-relative path, for the `[property:value]` terms of the search. */
export type PropsByPath = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function nodeAllowed(n: GraphNode, kind: NodeKind, f: GraphFilters): boolean {
  if (kind === "attachment" && !f.attachments) return false;
  if (kind === "base" && !f.bases) return false;
  if (kind === "missing" && !f.missing) return false;
  if (kind !== "missing") {
    if (f.includeFolders.length && !f.includeFolders.some((r) => inFolder(n.folder, r))) {
      return false;
    }
    if (f.exclude.some((r) => excludes(r, n))) return false;
  }
  return true;
}

const edgeKindAllowed = (kind: GraphEdgeKind, label: string | undefined, f: GraphFilters) =>
  f[KIND_FILTER[kind]] && (kind !== "property" || !f.hiddenLabels.includes(label ?? ""));

/** The property labels present in the slice (for the Properties checkboxes and the legend). */
export function propertyLabels(slice: GraphSlice): string[] {
  const out = new Set<string>();
  for (const e of slice.edges) if (e.kind === "property" && e.label) out.add(e.label);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The slice as the view shows it. `center` stays whatever the filters say (the spec never hides
 * the center). The search keeps the matching notes and the notes they link with; orphans, tags,
 * attachments, bases, missing notes, edge kinds, property labels and folders are the toggles of the
 * Filters panel.
 */
export function buildSpec(
  slice: GraphSlice,
  filters: GraphFilters,
  options: { center?: string | null; props?: PropsByPath } = {},
): GraphSpec {
  const byId = new Map<number, GraphNode>();
  const kinds = new Map<number, NodeKind>();
  for (const n of slice.nodes) {
    const kind = nodeKindOf(n);
    if (nodeAllowed(n, kind, filters) || n.path === options.center) {
      byId.set(n.id, n);
      kinds.set(n.id, kind);
    }
  }

  // Edges between kept nodes, one per (pair, kind, label).
  const edges = new Map<string, RawEdge>();
  for (const e of slice.edges) {
    if (e.dst === null || e.src === e.dst) continue;
    const src = byId.get(e.src);
    const dst = byId.get(e.dst);
    if (!src || !dst || !edgeKindAllowed(e.kind, e.label, filters)) continue;
    const source = nodeKey(src);
    const target = nodeKey(dst);
    const label = e.kind === "property" ? (e.label ?? null) : null;
    const key = `${source}\u0000${target}\u0000${e.kind}\u0000${label ?? ""}`;
    const had = edges.get(key);
    if (had) had.count += 1;
    else
      edges.set(key, {
        key,
        source,
        target,
        from: source,
        to: target,
        kind: e.kind,
        label,
        count: 1,
      });
  }

  let keep = new Set([...byId.values()].map(nodeKey));
  const query = parseQuery(filters.query);
  if (query.length > 0) keep = searchScope(byId, edges, query, options.props, options.center);

  const nodes = new Map<string, NodeSpec>();
  for (const [id, n] of byId) {
    const key = nodeKey(n);
    if (!keep.has(key)) continue;
    nodes.set(key, {
      key,
      kind: kinds.get(id)!,
      label: stripMd(n.name || n.path),
      path: n.unresolved ? "" : n.path,
      folder: n.folder,
      tags: n.tags,
      degree: n.degreeIn + n.degreeOut,
      cardValue: n.cardValue ?? null,
    });
  }
  const kept = [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target));

  if (filters.tags) addTags(nodes, kept);
  const merged = mergePairs(kept);

  const linked = new Set<string>();
  for (const e of merged) {
    linked.add(e.source);
    linked.add(e.target);
  }
  const shown = [...nodes.values()].filter(
    (n) => filters.orphans || linked.has(n.key) || n.path === options.center,
  );
  const shownKeys = new Set(shown.map((n) => n.key));
  return {
    nodes: shown,
    edges: merged.filter((e) => shownKeys.has(e.source) && shownKeys.has(e.target)),
  };
}

const KIND_ORDER: readonly EdgeKind[] = ["link", "embed", "property", "tag"];

/** One edge per pair of notes: every kind and both directions collapse into it (the part list keeps
 *  what each was). The single place that decides what an edge stands for; the reducers and the
 *  layout read the result. */
export function mergePairs(raw: readonly RawEdge[]): EdgeSpec[] {
  const pairs = new Map<string, RawEdge[]>();
  for (const e of raw) {
    const key =
      e.source < e.target ? `${e.source}\u0000${e.target}` : `${e.target}\u0000${e.source}`;
    (pairs.get(key) ?? pairs.set(key, []).get(key)!).push(e);
  }
  const out: EdgeSpec[] = [];
  for (const [key, group] of pairs) {
    const first = group[0]!;
    const parts: EdgePart[] = group
      .map(({ kind, label, from, to, count }) => ({ kind, label, from, to, count }))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    const same = parts.every((p) => p.kind === first.kind && p.label === first.label);
    out.push({
      key,
      source: first.source,
      target: first.target,
      kind: same ? first.kind : "link",
      label: same ? first.label : null,
      count: parts.reduce((n, p) => n + p.count, 0),
      parts,
      directed: parts.every((p) => p.from === first.source && p.to === first.target),
    });
  }
  return out;
}

/** Matching notes and the notes linked with them. */
function searchScope(
  byId: ReadonlyMap<number, GraphNode>,
  edges: ReadonlyMap<string, RawEdge>,
  query: ReturnType<typeof parseQuery>,
  props: PropsByPath | undefined,
  center: string | null | undefined,
): Set<string> {
  const hit = new Set<string>();
  for (const n of byId.values()) {
    const m: Matchable = {
      path: n.path,
      name: stripMd(n.name),
      tags: n.tags,
      props: props?.[n.path],
    };
    if (n.path === center || matches(query, m)) hit.add(nodeKey(n));
  }
  const keep = new Set(hit);
  for (const e of edges.values()) {
    if (hit.has(e.source)) keep.add(e.target);
    if (hit.has(e.target)) keep.add(e.source);
  }
  return keep;
}

/** Tag nodes (one per tag, nested tags linked child to parent) and the note-to-tag edges. */
function addTags(nodes: Map<string, NodeSpec>, edges: RawEdge[]): void {
  const counts = new Map<string, number>();
  const add = (source: string, tag: string) => {
    const key = `#${tag}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    edges.push({
      key: `${source}\u0000${key}\u0000tag\u0000`,
      source,
      target: key,
      from: source,
      to: key,
      kind: "tag",
      label: null,
      count: 1,
    });
  };
  for (const n of Array.from(nodes.values())) {
    if (n.kind !== "note") continue;
    for (const raw of n.tags) {
      const tag = raw.replace(/^#/, "");
      if (tag) add(n.key, tag);
    }
  }
  const seen = new Set<string>();
  const ensure = (tag: string) => {
    const key = `#${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.set(key, {
      key,
      kind: "tag",
      label: key,
      path: "",
      folder: "",
      tags: [],
      degree: counts.get(key) ?? 0,
      cardValue: null,
    });
    const parent = parentTag(tag);
    if (parent) {
      ensure(parent);
      edges.push({
        key: `${key}\u0000#${parent}\u0000tag\u0000`,
        source: key,
        target: `#${parent}`,
        from: key,
        to: `#${parent}`,
        kind: "tag",
        label: null,
        count: 1,
      });
    }
  };
  for (const key of Array.from(counts.keys())) ensure(key.slice(1));
}

/** Does the view need frontmatter for this config (search terms, color rules, Group by)? */
export function filtersNeedProps(filters: GraphFilters): boolean {
  return needsProps(parseQuery(filters.query));
}

// -- spec to graph, in place --------------------------------------------------------------------

/** FNV-1a: a stable pseudo-random source, so a node placed at first sight lands in the same spot. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A place for a node that has none: near the mean of its placed neighbours, else on a ring
 *  around the origin sized by the node count. */
function startPosition(graph: GraphModel, key: string, neighbours: string[], total: number) {
  const h = hash(key);
  const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
  const jitter = ((h >>> 16) / 0xffff) * 0.6 + 0.2;
  const placed = neighbours.filter((k) => graph.hasNode(k));
  if (placed.length > 0) {
    let x = 0;
    let y = 0;
    for (const k of placed) {
      x += graph.getNodeAttribute(k, "x");
      y += graph.getNodeAttribute(k, "y");
    }
    return {
      x: x / placed.length + Math.cos(angle) * jitter,
      y: y / placed.length + Math.sin(angle) * jitter,
    };
  }
  const radius = Math.sqrt(Math.max(1, total)) * 2;
  return { x: Math.cos(angle) * radius * jitter, y: Math.sin(angle) * radius * jitter };
}

export interface ApplyResult {
  added: string[];
  removed: string[];
  /** Nodes or edges were added or dropped (the layout has to be rebuilt and restarted). */
  structural: boolean;
}

/**
 * Brings `graph` to `spec`: keeps what is there (position, pin, color, group), drops what is gone,
 * adds what is new, and refreshes label, size, degree and edge counts. Anchor nodes and group
 * edges (`groups.ts`) are not part of the spec and are left alone.
 */
export function applySpec(graph: GraphModel, spec: GraphSpec): ApplyResult {
  const wantNodes = new Map(spec.nodes.map((n) => [n.key, n]));
  const wantEdges = new Map(spec.edges.map((e) => [e.key, e]));
  const removed: string[] = [];
  const added: string[] = [];

  let edgesDropped = false;
  for (const key of graph.edges()) {
    const attrs = graph.getEdgeAttributes(key);
    if (attrs.kind !== "group" && !wantEdges.has(key)) {
      graph.dropEdge(key);
      edgesDropped = true;
    }
  }
  for (const key of graph.nodes()) {
    if (graph.getNodeAttribute(key, "anchor")) continue;
    if (!wantNodes.has(key)) {
      graph.dropNode(key);
      removed.push(key);
    }
  }

  const neighbours = new Map<string, string[]>();
  for (const e of spec.edges) {
    (neighbours.get(e.source) ?? neighbours.set(e.source, []).get(e.source)!).push(e.target);
    (neighbours.get(e.target) ?? neighbours.set(e.target, []).get(e.target)!).push(e.source);
  }

  for (const n of spec.nodes) {
    const size = sizeOf(n);
    if (graph.hasNode(n.key)) {
      graph.mergeNodeAttributes(n.key, n.tint ? { ...n, size, color: n.tint } : { ...n, size });
      continue;
    }
    const pos = startPosition(graph, n.key, neighbours.get(n.key) ?? [], spec.nodes.length);
    graph.addNode(n.key, {
      ...n,
      size,
      ...pos,
      color: n.tint ?? null,
      group: null,
      groupExtra: [],
    });
    added.push(n.key);
  }

  let edgesAdded = false;
  for (const e of spec.edges) {
    const attrs = {
      kind: e.kind,
      label: e.label,
      count: e.count,
      parts: e.parts,
      directed: e.directed,
      weight: e.count,
    };
    // The pair's drawn direction follows its first part: a flip rebuilds the edge.
    if (graph.hasEdge(e.key) && graph.source(e.key) !== e.source) {
      graph.dropEdge(e.key);
      edgesDropped = true;
    }
    if (graph.hasEdge(e.key)) graph.mergeEdgeAttributes(e.key, attrs);
    else {
      graph.addEdgeWithKey(e.key, e.source, e.target, attrs);
      edgesAdded = true;
    }
  }
  return {
    added,
    removed,
    structural: added.length > 0 || removed.length > 0 || edgesAdded || edgesDropped,
  };
}
