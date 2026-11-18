/**
 * The `<open-tabs>` footer (spec "Open tabs"): which vault files the user has open in the editor,
 * with a little metadata, so "the notes I have open" needs no guessing. Pure; the agent store
 * collects the inputs at send time. Paths and frontmatter-derived metadata only, never body text.
 */
import { parseProperties, summaryTags, type PropertyRow } from "@/lib/frontmatter-properties";
import { typeOfRow, type PropertyType } from "@/lib/property-types";
import { isWikiLink, parseWikiLinkValue } from "@/lib/wiki-links";

export const MAX_OPEN_TABS = 20;
export const MAX_TAGS = 8;
export const MAX_LINKS_PER_KEY = 5;
export const MAX_VALUE_CHARS = 80;
/** Frontmatter keys shown as plain values (a "kind of note" convention), first match wins order. */
export const TYPE_KEYS = ["type", "kind", "status"] as const;

export type OpenTabKind = "note" | "base" | "code" | "canvas" | "other";

export type OpenTab = {
  /** Path as the claude process resolves it (relative to its cwd). */
  path: string;
  active: boolean;
  kind: OpenTabKind;
  tags?: string[];
  /** `type`-like properties: key -> display value. */
  props?: { key: string; value: string }[];
  /** Properties holding wikilinks: key -> link targets. */
  links?: { key: string; targets: string[] }[];
  /** A base's selected view name, when known. */
  view?: string;
};

const clip = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_VALUE_CHARS ? `${one.slice(0, MAX_VALUE_CHARS - 1)}…` : one;
};

/** `[[Target|alias#heading]]` -> `Target`; anything else is not a link. */
export function wikilinkTarget(value: string): string | null {
  return isWikiLink(value) ? parseWikiLinkValue(value).path || null : null;
}

const rowValues = (row: PropertyRow): string[] =>
  row.kind === "list" || row.kind === "tags" || row.kind === "tagString"
    ? row.items
    : row.value === null || row.value === ""
      ? []
      : [String(row.value)];

export type FrontmatterMeta = Pick<OpenTab, "tags" | "props" | "links">;

/**
 * Tags, `type`-like values and relationship links of a note's frontmatter text (no fences).
 * `typeOf(key)` is the vault's recorded type for a property name, when it has one; without it the
 * value decides (a link or a list of links is a relationship).
 */
export function frontmatterMeta(
  frontmatter: string | null,
  typeOf: (key: string) => PropertyType | undefined = () => undefined,
): FrontmatterMeta {
  if (!frontmatter) return {};
  const parsed = parseProperties(frontmatter);
  if (!parsed.ok) return {};
  const meta: FrontmatterMeta = {};
  const tags = summaryTags(parsed.rows).map(clip).filter(Boolean);
  if (tags.length) meta.tags = tags;
  const props: { key: string; value: string }[] = [];
  const links: { key: string; targets: string[] }[] = [];
  for (const row of parsed.rows) {
    const key = row.key;
    const lower = key.toLowerCase();
    if (lower === "tags" || lower === "tag") continue;
    const values = rowValues(row);
    if (values.length === 0) continue;
    const t = typeOf(key) ?? typeOfRow(row);
    if (t === "relationships") {
      const targets = values.flatMap((v) => wikilinkTarget(v) ?? []).map(clip);
      if (targets.length) links.push({ key, targets });
    } else if ((TYPE_KEYS as readonly string[]).includes(lower) && row.kind !== "object") {
      props.push({ key, value: clip(values.join(", ")) });
    }
  }
  if (props.length) meta.props = props;
  if (links.length) meta.links = links;
  return meta;
}

const quote = (path: string) => JSON.stringify(path);

const capped = (items: readonly string[], max: number) =>
  items.length > max
    ? `${items.slice(0, max).join(", ")}, +${items.length - max} more`
    : items.join(", ");

function line(t: OpenTab): string {
  const parts = [t.active ? "active" : null, t.kind === "other" ? "file" : t.kind];
  if (t.view) parts.push(`view ${quote(t.view)}`);
  if (t.tags?.length) parts.push(`tags: ${capped(t.tags, MAX_TAGS)}`);
  for (const p of t.props ?? []) parts.push(`${p.key}: ${p.value}`);
  for (const l of t.links ?? [])
    parts.push(
      `${l.key}: ${capped(
        l.targets.map((x) => `[[${x}]]`),
        MAX_LINKS_PER_KEY,
      )}`,
    );
  return `- ${quote(t.path)} (${parts.filter(Boolean).join("; ")})`;
}

const HEADER =
  "Editor tabs open in Writer, in tab order, paths relative to the working directory (metadata only; read a note with the Read tool when relevant):";

/** The footer for these tabs, or null with none. The active tab always survives the cap. */
export function openTabsBlock(tabs: readonly OpenTab[]): string | null {
  if (tabs.length === 0) return null;
  let shown = tabs.slice(0, MAX_OPEN_TABS);
  const activeAt = tabs.findIndex((t) => t.active);
  if (activeAt >= MAX_OPEN_TABS) shown = [...shown.slice(0, MAX_OPEN_TABS - 1), tabs[activeAt]!];
  const rest = tabs.length - shown.length;
  const lines = shown.map(line);
  if (rest > 0) lines.push(`- +${rest} more`);
  return `<open-tabs>\n${HEADER}\n${lines.join("\n")}\n</open-tabs>`;
}

export type TabLike = {
  id: string;
  location: { kind: string; path?: string; view?: string };
};

export type OpenTabsSource = {
  tabs: readonly TabLike[];
  activeTabId: string | null;
  /** Path as claude sees it, or null when the file is outside the vault. */
  toSentPath: (path: string) => string | null;
  /** Frontmatter text (no fences) of a document already open in memory. */
  frontmatterOf: (path: string) => string | null | undefined;
  typeOf?: (key: string) => PropertyType | undefined;
};

function kindOf(location: TabLike["location"]): OpenTabKind | null {
  switch (location.kind) {
    case "base":
      return "base";
    case "code":
      return "code";
    case "file": {
      const ext = /\.([^/.]+)$/.exec(location.path ?? "")?.[1]?.toLowerCase();
      return ext === "md" || ext === "markdown" ? "note" : ext === "canvas" ? "canvas" : "other";
    }
    default:
      return null; // launcher, settings, plugin views and plugin files are not vault files
  }
}

/** Vault-file tabs in tab order, deduplicated by path, the active one marked. */
export function openTabsFrom(src: OpenTabsSource): OpenTab[] {
  const out: OpenTab[] = [];
  const seen = new Map<string, OpenTab>();
  for (const tab of src.tabs) {
    const kind = kindOf(tab.location);
    const raw = tab.location.path;
    if (!kind || !raw) continue;
    const path = src.toSentPath(raw);
    if (!path) continue;
    const active = tab.id === src.activeTabId;
    const dup = seen.get(path);
    if (dup) {
      dup.active ||= active;
      continue;
    }
    const entry: OpenTab = { path, active, kind };
    if (kind === "note")
      Object.assign(entry, frontmatterMeta(src.frontmatterOf(raw) ?? null, src.typeOf));
    if (kind === "base" && tab.location.view) entry.view = clip(tab.location.view);
    seen.set(path, entry);
    out.push(entry);
  }
  return out;
}
