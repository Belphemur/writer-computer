// The saved view config of the graph (`.writer/graph.json`, SPECs/graph-view-spec.md section 6):
// filters, ordered color rules and Group by, once for the global tab and once for the local
// panel. Pure: shapes, defaults and `normalizeConfig`, which turns whatever the file held into a
// valid config (a hand-edited or newer file never breaks the view).

export type SurfaceId = "global" | "local";

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

export type ColorRule = { id: string; query: string; color: string };

/** `property` is `tags`, `folder`, any frontmatter key, or null for no grouping. */
export type GroupBy = { property: string | null; nestedLevel: 1 | 2 | 3 };

export type SurfaceConfig = { filters: GraphFilters; rules: ColorRule[]; groupBy: GroupBy };

export type GraphConfig = { version: 1; global: SurfaceConfig; local: SurfaceConfig };

export const DEFAULT_FILTERS: GraphFilters = {
  query: "",
  tags: false,
  attachments: false,
  bases: false,
  missing: false,
  orphans: true,
  links: true,
  embeds: true,
  properties: true,
  hiddenLabels: [],
  includeFolders: [],
  excludeFolders: [],
};

export const DEFAULT_SURFACE: SurfaceConfig = {
  filters: DEFAULT_FILTERS,
  rules: [],
  groupBy: { property: null, nestedLevel: 1 },
};

export const DEFAULT_CONFIG: GraphConfig = {
  version: 1,
  global: DEFAULT_SURFACE,
  local: DEFAULT_SURFACE,
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

export function normalizeSurface(v: unknown): SurfaceConfig {
  const s = isRecord(v) ? v : {};
  return {
    filters: normalizeFilters(s.filters),
    rules: normalizeRules(s.rules),
    groupBy: normalizeGroupBy(s.groupBy),
  };
}

export function normalizeConfig(v: unknown): GraphConfig {
  const c = isRecord(v) ? v : {};
  return { version: 1, global: normalizeSurface(c.global), local: normalizeSurface(c.local) };
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
