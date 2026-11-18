// The saved view config of the graph (`.writer/graph.json`, SPECs/graph-view-spec.md section 6):
// filters, ordered color rules, Group by and Display of the graph tab. Pure: shapes, defaults and `normalizeConfig`, which turns whatever the file held into a
// valid config (a hand-edited or newer file never breaks the view).

import type { GraphEdgeKind } from "./ipc";
import { DEFAULT_LABEL_MODE, isLabelMode, type LabelMode } from "./lod";

export type GraphFilters = {
  /** Search query: only matches and their links are shown (syntax in `query.ts`). */
  query: string;
  tags: boolean;
  attachments: boolean;
  bases: boolean;
  missing: boolean;
  orphans: boolean;
  links: boolean;
  embeds: boolean;
  properties: boolean;
  /** Property labels switched off under Properties. */
  hiddenLabels: string[];
  includeFolders: string[];
  excludeFolders: string[];
};

/** The filter switch of each edge kind, and the one list of kinds (the generated `EdgeKind` makes
 *  both exhaustive: a new Rust kind is a type error here). */
export const KIND_FILTER: Record<GraphEdgeKind, "links" | "embeds" | "properties"> = {
  link: "links",
  embed: "embeds",
  property: "properties",
};
export const EDGE_KINDS = Object.keys(KIND_FILTER) as GraphEdgeKind[];

export type ColorRule = { id: string; query: string; color: string };

/** `property` is `tags`, `folder`, any frontmatter key, or null for no grouping. */
export type GroupBy = { property: string | null; nestedLevel: 1 | 2 | 3 };

/** What the automatic clusters are: detected communities (Louvain) or the top-level folders. An
 *  explicit Group by wins over both. */
export const CLUSTER_BY = ["communities", "folder"] as const;
export type ClusterBy = (typeof CLUSTER_BY)[number];
export const isClusterBy = (v: unknown): v is ClusterBy =>
  (CLUSTER_BY as readonly unknown[]).includes(v);

export type Depth = 1 | 2 | 3 | 4 | 5;
export const MAX_DEPTH = 5;
export const DEFAULT_DEPTH: Depth = 2;

/** A depth from a tab location or a slider; `undefined` (the whole vault) stays `undefined`. */
export function clampDepth(d: number | undefined): Depth | undefined {
  return d === undefined || !Number.isFinite(d)
    ? undefined
    : (Math.min(MAX_DEPTH, Math.max(1, Math.round(d))) as Depth);
}

/** The Display section of the side panel. */
export type Display = { labels: LabelMode; clusterBy: ClusterBy; depth: Depth };

export type SurfaceConfig = {
  filters: GraphFilters;
  rules: ColorRule[];
  groupBy: GroupBy;
  display: Display;
};

/** `global` is the key of the one saved view (the graph tab); it keeps the name the file always had. */
export type GraphConfig = { version: 1; global: SurfaceConfig };

export const DEFAULT_FILTERS: GraphFilters = {
  query: "",
  tags: false,
  attachments: false,
  bases: false,
  missing: false,
  orphans: true,
  links: true,
  embeds: true,
  // Every relationship property is an edge kind of its own (dozens in a real vault): off until
  // enabled in the panel, and then never fetched.
  properties: false,
  hiddenLabels: [],
  includeFolders: [],
  excludeFolders: [],
};

export const DEFAULT_DISPLAY: Display = {
  labels: DEFAULT_LABEL_MODE,
  clusterBy: "communities",
  depth: DEFAULT_DEPTH,
};

export const DEFAULT_SURFACE: SurfaceConfig = {
  filters: DEFAULT_FILTERS,
  rules: [],
  groupBy: { property: null, nestedLevel: 1 },
  display: DEFAULT_DISPLAY,
};

export const DEFAULT_CONFIG: GraphConfig = {
  version: 1,
  global: DEFAULT_SURFACE,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

function normalizeFilters(v: unknown): GraphFilters {
  const f = isRecord(v) ? v : {};
  const d = DEFAULT_FILTERS;
  return {
    query: typeof f.query === "string" ? f.query : d.query,
    tags: bool(f.tags, d.tags),
    attachments: bool(f.attachments, d.attachments),
    bases: bool(f.bases, d.bases),
    missing: bool(f.missing, d.missing),
    orphans: bool(f.orphans, d.orphans),
    links: bool(f.links, d.links),
    embeds: bool(f.embeds, d.embeds),
    properties: bool(f.properties, d.properties),
    hiddenLabels: strings(f.hiddenLabels),
    includeFolders: strings(f.includeFolders),
    excludeFolders: strings(f.excludeFolders),
  };
}

function normalizeRules(v: unknown): ColorRule[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const rules: ColorRule[] = [];
  for (const r of v) {
    if (!isRecord(r) || typeof r.color !== "string" || typeof r.query !== "string") continue;
    let id = typeof r.id === "string" && r.id ? r.id : `rule-${rules.length + 1}`;
    while (seen.has(id)) id = `${id}-`;
    seen.add(id);
    rules.push({ id, query: r.query, color: r.color });
  }
  return rules;
}

function normalizeGroupBy(v: unknown): GroupBy {
  const g = isRecord(v) ? v : {};
  const level = g.nestedLevel === 2 || g.nestedLevel === 3 ? g.nestedLevel : 1;
  const property = typeof g.property === "string" && g.property ? g.property : null;
  return { property, nestedLevel: level };
}

function normalizeDisplay(v: unknown): Display {
  const d = isRecord(v) ? v : {};
  const depth = typeof d.depth === "number" ? Math.round(d.depth) : DEFAULT_DEPTH;
  return {
    labels: isLabelMode(d.labels) ? d.labels : DEFAULT_DISPLAY.labels,
    clusterBy: isClusterBy(d.clusterBy) ? d.clusterBy : DEFAULT_DISPLAY.clusterBy,
    depth: Math.min(MAX_DEPTH, Math.max(1, depth)) as Depth,
  };
}

export function normalizeSurface(v: unknown): SurfaceConfig {
  const s = isRecord(v) ? v : {};
  return {
    filters: normalizeFilters(s.filters),
    rules: normalizeRules(s.rules),
    groupBy: normalizeGroupBy(s.groupBy),
    display: normalizeDisplay(s.display),
  };
}

export function normalizeConfig(v: unknown): GraphConfig {
  const c = isRecord(v) ? v : {};
  return { version: 1, global: normalizeSurface(c.global) };
}

/** The text of `.writer/graph.json` as a config; invalid JSON is an error (the caller reports it
 *  and keeps the defaults), a missing file (`null`) is the defaults. */
export function parseConfig(text: string | null): GraphConfig {
  if (text === null || text.trim() === "") return DEFAULT_CONFIG;
  return normalizeConfig(JSON.parse(text));
}

export function serializeConfig(config: GraphConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
