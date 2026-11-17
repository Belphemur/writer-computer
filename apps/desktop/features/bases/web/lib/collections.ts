// Layout helpers shared by the cards and list views: sections (the groups of a result, or one
// ungrouped section), collapse state, fixed item heights for windowing, image sources and the
// documented semantics of the cards/list view options (spec "U6"). Pure: no React, no IPC.
import { isWikiLink, parseWikiLinkValue } from "@/lib/wiki-links";
import { groupKey, groupLabel } from "./grid";
import type { BaseQueryResult, BaseView, CellValue } from "./types";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface Section {
  /** Identity for the collapse state; `null` for the single ungrouped section. */
  key: string | null;
  label: string | null;
  start: number;
  len: number;
}

/** The groups of a result as sections. Throws when the ranges do not tile `rows` (a backend bug). */
export function sectionsOf(result: Pick<BaseQueryResult, "rows" | "groups">): Section[] {
  const { rows, groups } = result;
  if (!groups) return [{ key: null, label: null, start: 0, len: rows.length }];
  let expected = 0;
  const sections = groups.map((g, i) => {
    if (g.start !== expected || g.len < 0 || g.start + g.len > rows.length)
      throw new Error(
        `Invalid group range ${g.start}+${g.len} for ${rows.length} rows (group ${i})`,
      );
    expected = g.start + g.len;
    return { key: groupKey(g), label: groupLabel(g), start: g.start, len: g.len };
  });
  if (expected !== rows.length) throw new Error(`Groups cover ${expected} of ${rows.length} rows`);
  return sections;
}

export type HeaderItem = {
  kind: "group";
  key: string;
  label: string;
  count: number;
  collapsed: boolean;
};

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const DEFAULT_CARD_SIZE = 200;
export const MIN_CARD_SIZE = 100;
export const MAX_CARD_SIZE = 600;
export const CARD_GAP = 12;
export const CARD_PADDING = 12;
export const GROUP_HEADER_HEIGHT = 32;
const CARD_TITLE_HEIGHT = 24;
const CARD_PROPERTY_HEIGHT = 20;
const CARD_CONTENT_PADDING = 16;

export type ImageFit = "cover" | "contain";

export interface CardOptions {
  /** Card width in px (`cardSize`, default 200). */
  size: number;
  /** Property holding the cover image (`image`), `null` for none. */
  image: string | null;
  /** `imageFit`: `cover` (default) crops, `contain` letterboxes. */
  fit: ImageFit;
  /** `imageAspectRatio`: image height divided by width (default 1, square). */
  aspectRatio: number;
}

export const MIN_ASPECT_RATIO = 0.25;
export const MAX_ASPECT_RATIO = 3;

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Cards options from the view's YAML. The public docs name the settings (card size, image
 * property, image fit, image aspect ratio, default 1:1) but not their keys; `cardSize` is the key
 * real files use, the other three are Writer's choice (`image`, `imageFit`, `imageAspectRatio`)
 * and are the only YAML keys the cards view writes. Out-of-range numbers are clamped.
 */
export function cardOptions(view: BaseView | undefined): CardOptions {
  const x = view?.extra ?? {};
  const size = finite(x.cardSize);
  const ratio = finite(x.imageAspectRatio);
  return {
    size:
      size === null ? DEFAULT_CARD_SIZE : Math.min(MAX_CARD_SIZE, Math.max(MIN_CARD_SIZE, size)),
    image: typeof x.image === "string" && x.image !== "" ? x.image : null,
    fit: x.imageFit === "contain" ? "contain" : "cover",
    aspectRatio: ratio === null ? 1 : Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, ratio)),
  };
}

/** Cards per row for a container `width` (cards have a fixed width of `size`). */
export function cardsPerRow(width: number, size: number): number {
  return Math.max(1, Math.floor((width - 2 * CARD_PADDING + CARD_GAP) / (size + CARD_GAP)));
}

/** Height in px of one card: optional image, title line, one line per other shown property. */
export function cardHeight(options: CardOptions, shownProperties: number): number {
  const image = options.image ? Math.round(options.size * options.aspectRatio) : 0;
  return (
    image +
    CARD_CONTENT_PADDING +
    CARD_TITLE_HEIGHT +
    CARD_PROPERTY_HEIGHT * Math.max(0, shownProperties - 1)
  );
}

export type CardItem = HeaderItem | { kind: "cards"; rows: number[] };

/** Group headers and rows of `perRow` cards; collapsed groups contribute their header only. */
export function cardItems(
  sections: readonly Section[],
  perRow: number,
  collapsed: ReadonlySet<string>,
): CardItem[] {
  const items: CardItem[] = [];
  for (const s of sections) {
    const isCollapsed = s.key !== null && collapsed.has(s.key);
    if (s.key !== null)
      items.push({
        kind: "group",
        key: s.key,
        label: s.label ?? "",
        count: s.len,
        collapsed: isCollapsed,
      });
    if (isCollapsed) continue;
    for (let i = 0; i < s.len; i += perRow) {
      const rows: number[] = [];
      for (let r = i; r < Math.min(i + perRow, s.len); r++) rows.push(s.start + r);
      items.push({ kind: "cards", rows });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Card images
// ---------------------------------------------------------------------------

export type CardImage =
  | { kind: "none" }
  | { kind: "color"; color: string }
  /** An `https:` URL (the page CSP allows `https:` images and nothing else remote). */
  | { kind: "url"; url: string }
  /** A vault file; the view turns it into an asset URL the same way the markdown renderer does. */
  | { kind: "file"; path: string }
  /** A value that is refused (`reason` is shown as the tooltip), never loaded. */
  | { kind: "blocked"; reason: string };

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `Folder/pic.png` as a safe vault-relative path, or `null` (traversal, absolute, `.obsidian`). */
export function safeVaultPath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path === "") return null;
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return null;
  if (parts[0] === ".obsidian") return null;
  return path;
}

/**
 * What an image-property cell shows. A hex color is a swatch; an `https:` URL is loaded; any other
 * scheme (`http:`, `data:`, `file:`, `javascript:`) is blocked; a link or file value, a
 * `[[wikilink]]`/`![[embed]]` text or a plain path is a vault file (resolved through the link's
 * `resolved` path when the engine gave one). A list takes its first non-empty item.
 */
export function cardImage(cell: CellValue | undefined): CardImage {
  if (!cell) return { kind: "none" };
  switch (cell.type) {
    case "null":
      return { kind: "none" };
    case "list": {
      for (const item of cell.value) {
        const image = cardImage(item);
        if (image.kind !== "none") return image;
      }
      return { kind: "none" };
    }
    case "link": {
      const path = cell.value.resolved ? safeVaultPath(cell.value.resolved) : null;
      return path
        ? { kind: "file", path }
        : { kind: "blocked", reason: `${cell.value.target} was not found in the vault` };
    }
    case "file": {
      const path = safeVaultPath(cell.value);
      return path ? { kind: "file", path } : { kind: "blocked", reason: "Unsafe file path" };
    }
    case "string":
    case "image": {
      const raw = cell.value.trim();
      if (raw === "") return { kind: "none" };
      if (HEX_COLOR.test(raw)) return { kind: "color", color: raw };
      const link = raw.startsWith("!") ? raw.slice(1) : raw;
      const target = (isWikiLink(link) && parseWikiLinkValue(link).path) || raw;
      if (/^https:\/\//i.test(target)) return { kind: "url", url: target };
      if (SCHEME.test(target) && !/^[a-z]:[\\/]/i.test(target))
        return {
          kind: "blocked",
          reason: `Only https: image URLs are loaded (got ${target.split(":")[0]}:)`,
        };
      const path = safeVaultPath(target);
      return path ? { kind: "file", path } : { kind: "blocked", reason: "Unsafe file path" };
    }
    default:
      return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type ListMarkers = "bullets" | "numbers" | "none";

export interface ListOptions {
  /** `markers`: bullets (default), numbers or none. */
  markers: ListMarkers;
  /** `indentProperties`: other properties as indented lines under the primary one (default off). */
  indent: boolean;
  /** `separator`: text between inline properties (default `", "`). */
  separator: string;
}

export const DEFAULT_SEPARATOR = ", ";

/**
 * List options from the view's YAML. The docs name Markers (bullets, numbers, none), Indent
 * properties and Separators (default comma) but not the keys: `markers`, `indentProperties` and
 * `separator` are Writer's choice and the only keys the list view writes.
 */
export function listOptions(view: BaseView | undefined): ListOptions {
  const x = view?.extra ?? {};
  return {
    markers: x.markers === "numbers" || x.markers === "none" ? x.markers : "bullets",
    indent: x.indentProperties === true,
    separator: typeof x.separator === "string" ? x.separator : DEFAULT_SEPARATOR,
  };
}

export const LIST_LINE_HEIGHT = 24;

/** Lines a list row takes: one, plus one per non-empty other property when indented. */
export function listRowLines(options: ListOptions, nonEmptyOthers: number): number {
  return options.indent ? 1 + nonEmptyOthers : 1;
}

export type ListItem = HeaderItem | { kind: "row"; row: number; ordinal: number; lines: number };

/** The marker text of a row (`•`, `3.`, or empty). */
export function markerText(markers: ListMarkers, ordinal: number): string {
  if (markers === "bullets") return "•";
  if (markers === "numbers") return `${ordinal}.`;
  return "";
}

/** Group headers and rows; the ordinal restarts in every group (and counts from 1). */
export function listItems(
  sections: readonly Section[],
  collapsed: ReadonlySet<string>,
  linesOf: (row: number) => number,
): ListItem[] {
  const items: ListItem[] = [];
  for (const s of sections) {
    const isCollapsed = s.key !== null && collapsed.has(s.key);
    if (s.key !== null)
      items.push({
        kind: "group",
        key: s.key,
        label: s.label ?? "",
        count: s.len,
        collapsed: isCollapsed,
      });
    if (isCollapsed) continue;
    for (let i = 0; i < s.len; i++)
      items.push({ kind: "row", row: s.start + i, ordinal: i + 1, lines: linesOf(s.start + i) });
  }
  return items;
}
