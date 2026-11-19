// The properties model of a note: parse the frontmatter text into typed rows, and edit it with
// byte-minimal text splices. No IO, no React.
//
// The frontmatter text (`OpenFile.frontmatter`, the YAML between the `---` lines) is the source
// of truth. Every edit here is a splice on that text built from the `yaml` Document node ranges:
// a scalar change replaces only the value token, a list change touches one line, a removal drops
// the property's lines. Comments, quoting, key order, blank lines and every other property stay
// byte-identical (`yaml-entries.ts`, which re-stringifies the whole object, must not be used for
// this). Each edit is re-parsed and compared with the semantic result it should have; a mismatch
// refuses the edit instead of writing a corrupted block.
//
// Shapes the panel cannot edit safely (unparsable YAML, duplicate keys, a flow-mapping root, a
// non-mapping root, non-scalar keys) make `parseProperties` return `ok: false` with a message;
// the panel then offers the raw text only. Single values it cannot edit (flow maps such as an
// unquoted `{{date}}`, aliases, multi-line strings, maps nested deeper than two levels) become
// read-only rows that show their source text. A property whose value is a block map is an
// `object` row with `entries` (two levels, `frontmatter-nested.ts` edits them).
import type { PropertyType } from "./property-types";
import { isWikiLink } from "./wiki-links";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  stringify,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

export type PropertyKind =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "link"
  | "url"
  | "list"
  | "tags"
  | "tagString"
  | "empty"
  | "multiline"
  | "object"
  | "raw";

export interface PropertyRow {
  key: string;
  kind: PropertyKind;
  /** Whether the row's value can be edited in the panel. */
  editable: boolean;
  /** Scalar value (`text`, `number`, `checkbox`, dates, `link`, `url`); `null` for `empty`. */
  value: string | number | boolean | null;
  /** Items of `list`, `tags` and `tagString` rows. */
  items: string[];
  /** The keys of an editable `object` row, as rows of their own (a level-1 map's entries may be
   *  objects themselves; a level-2 map's are leaves, a map there is read-only). */
  entries: PropertyRow[];
  /** Source text of a read-only row (`raw`, `multiline`, a non-editable `object`). */
  source: string;
  /** The value looks like a Templater / Dataview placeholder (`{{...}}`, `<% ... %>`). */
  placeholder: boolean;
}

export type RefusalReason =
  | "unparsable"
  | "duplicate-keys"
  | "not-a-map"
  | "flow-root"
  | "unsupported-key";

export type ParsedProperties =
  | { ok: true; rows: PropertyRow[]; count: number }
  | { ok: false; reason: RefusalReason; message: string; count: number };

export type EditResult = { ok: true; text: string } | { ok: false; error: string };

export type ScalarValue = string | number | boolean | null;

/** The value of a new `object` property: an empty map, written `{}` until a key is added. */
export type EmptyObject = Readonly<Record<string, never>>;
export const EMPTY_OBJECT: EmptyObject = Object.freeze({});

const PLACEHOLDER_RE = /\{\{.*?\}\}|<%.*?%>/;
const URL_RE = /^https?:\/\/\S+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/;
const NUMBER_SOURCE_RE = /^-?\d+(?:\.\d+)?$/;
const TAG_KEYS = new Set(["tags", "tag"]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function open(text: string): Document {
  return parseDocument(text, { uniqueKeys: false, logLevel: "silent", prettyErrors: false });
}

export function keyText(pair: Pair): string | null {
  return isScalar(pair.key) ? String(pair.key.value) : null;
}

type Opened =
  | { ok: true; doc: Document; map: YAMLMap | null }
  | Extract<ParsedProperties, { ok: false }>;

export function openMap(text: string): Opened {
  if (text.trim() === "") return { ok: true, doc: open(text), map: null };
  const doc = open(text);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      reason: "unparsable",
      message: "These properties are not valid YAML, so they can only be edited as source.",
      count: approximateCount(text),
    };
  }
  const root = doc.contents;
  if (root === null) return { ok: true, doc, map: null };
  if (!isMap(root)) {
    return {
      ok: false,
      reason: "not-a-map",
      message: "The frontmatter is not a list of properties, so it can only be edited as source.",
      count: 0,
    };
  }
  if (root.flow) {
    return {
      ok: false,
      reason: "flow-root",
      message: "The frontmatter is a flow mapping ({ ... }), so it can only be edited as source.",
      count: root.items.length,
    };
  }
  const seen = new Set<string>();
  for (const pair of root.items) {
    const key = keyText(pair);
    if (key === null) {
      return {
        ok: false,
        reason: "unsupported-key",
        message: "A property name is not plain text, so the block can only be edited as source.",
        count: root.items.length,
      };
    }
    if (seen.has(key)) {
      return {
        ok: false,
        reason: "duplicate-keys",
        message: `The property "${key}" appears more than once, so the block can only be edited as source.`,
        count: root.items.length,
      };
    }
    seen.add(key);
  }
  return { ok: true, doc, map: root };
}

/** Top-level `key:` lines of text that did not parse; only used for the summary count. */
function approximateCount(text: string): number {
  return text.split("\n").filter((l) => /^[^\s#:-][^:]*:(\s|$)/.test(l)).length;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value) ?? "";
}

/** `[[Note]]` written without quotes is a flow list holding a flow list holding `Note`; Obsidian
 *  (and the vault index) read it as the link. Returns `[[Note]]` for that shape, else null. */
function unquotedLink(node: unknown): string | null {
  if (!isSeq(node) || node.items.length !== 1) return null;
  const inner = node.items[0];
  if (!isSeq(inner) || inner.items.length !== 1) return null;
  const leaf = inner.items[0];
  return isScalar(leaf) && typeof leaf.value === "string" ? `[[${leaf.value}]]` : null;
}

function scalarItems(seq: YAMLSeq): string[] | null {
  const out: string[] = [];
  for (const item of seq.items) {
    const link = unquotedLink(item);
    if (link !== null) {
      out.push(link);
      continue;
    }
    if (!isScalar(item) || item.type === "BLOCK_LITERAL" || item.type === "BLOCK_FOLDED")
      return null;
    out.push(scalarText(item.value));
  }
  return out;
}

function sourceOf(text: string, node: Node | null | undefined): string {
  const range = node?.range;
  return range ? text.slice(range[0], range[1]).trim() : "";
}

function baseRow(key: string): PropertyRow {
  return {
    key,
    kind: "raw",
    editable: false,
    value: null,
    items: [],
    entries: [],
    source: "",
    placeholder: false,
  };
}

/** How many map levels the panel edits: a property's map is level 1, a map in it level 2. A map
 *  deeper than that is shown as its source. */
export const MAX_MAP_LEVEL = 2;

/** `depth` 0 is a property; 1 and 2 are the keys of its level-1 and level-2 maps. */
function rowOf(text: string, pair: Pair, depth = 0): PropertyRow {
  const key = keyText(pair) as string;
  const row = baseRow(key);
  const node = pair.value as Node | null;
  row.source = sourceOf(text, node);
  row.placeholder = PLACEHOLDER_RE.test(row.source);

  if (node === null || node === undefined) return { ...row, kind: "empty", editable: true };
  if (isAlias(node)) return row;

  if (isScalar(node)) {
    const v = node.value;
    if (v === null || v === undefined) return { ...row, kind: "empty", editable: true };
    if (typeof v === "boolean") return { ...row, kind: "checkbox", editable: true, value: v };
    if (typeof v === "number") {
      const plain = NUMBER_SOURCE_RE.test(row.source);
      return { ...row, kind: "number", editable: plain, value: v };
    }
    if (typeof v === "string") {
      if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED" || v.includes("\n"))
        return { ...row, kind: "multiline" };
      if (depth === 0 && TAG_KEYS.has(key.toLowerCase()) && v.trim() !== "")
        return { ...row, kind: "tagString", editable: true, items: splitTagString(v), value: v };
      const kind: PropertyKind = isWikiLink(v)
        ? "link"
        : URL_RE.test(v)
          ? "url"
          : DATE_RE.test(v)
            ? "date"
            : DATETIME_RE.test(v)
              ? "datetime"
              : "text";
      return { ...row, kind, editable: true, value: v };
    }
    return row;
  }

  if (isSeq(node)) {
    const link = unquotedLink(node);
    if (link !== null) return { ...row, kind: "link", editable: true, value: link };
    const items = scalarItems(node);
    if (items === null) return row;
    const kind: PropertyKind = depth === 0 && TAG_KEYS.has(key.toLowerCase()) ? "tags" : "list";
    return { ...row, kind, editable: true, items };
  }

  if (isMap(node)) {
    const keys = node.items.map((p) => (isScalar(p.key) ? String(p.key.value) : null));
    // a key that is not plain text (an unquoted `{{date}}`) leaves a raw row
    if (keys.includes(null)) return row;
    const editable = isEditableMap(node) && depth < MAX_MAP_LEVEL;
    const entries = editable ? node.items.map((p) => rowOf(text, p, depth + 1)) : [];
    return { ...row, kind: "object", editable, entries };
  }
  return row;
}

/** A map the panel can edit: a block map, or `{}`, without an anchor, with unique plain keys. */
export function isEditableMap(node: YAMLMap): boolean {
  if (node.anchor || node.tag || (node.flow && node.items.length > 0)) return false;
  const keys = node.items.map((p) => (isScalar(p.key) ? String(p.key.value) : null));
  return !keys.includes(null) && new Set(keys).size === keys.length;
}

/** Parse the frontmatter text into rows, or say why it can only be edited as source. */
export function parseProperties(text: string): ParsedProperties {
  const opened = openMap(text);
  if (!opened.ok) return opened;
  const rows = opened.map ? opened.map.items.map((pair) => rowOf(text, pair)) : [];
  return { ok: true, rows, count: rows.length };
}

/** What the collapsed heuristic and the summary need, without building rows. */
export interface PropertyStats {
  count: number;
  lines: number;
}

export function propertyStats(text: string): PropertyStats {
  const lines = text.trim() === "" ? 0 : text.split("\n").length;
  const opened = openMap(text);
  return { count: opened.ok ? (opened.map?.items.length ?? 0) : opened.count, lines };
}

// ---------------------------------------------------------------------------
// Collapsed state
// ---------------------------------------------------------------------------

export const PROPERTIES_COLLAPSE_AUTO_PROPS = 6;
export const PROPERTIES_COLLAPSE_AUTO_LINES = 8;

export type PropertiesDefault = "auto" | "collapsed" | "expanded";

/** The collapsed state of a note's panel: the user's own toggle this session, else the setting;
 *  `auto` collapses blocks longer than the thresholds so they never fill the top of a note. */
export function resolveCollapsed(
  override: boolean | undefined,
  setting: PropertiesDefault,
  stats: PropertyStats,
): boolean {
  if (override !== undefined) return override;
  if (setting === "collapsed") return true;
  if (setting === "expanded") return false;
  return (
    stats.count > PROPERTIES_COLLAPSE_AUTO_PROPS || stats.lines > PROPERTIES_COLLAPSE_AUTO_LINES
  );
}

export function normalizeDefault(value: unknown): PropertiesDefault {
  return value === "collapsed" || value === "expanded" ? value : "auto";
}

/** Tag items for the collapsed summary, in document order. */
export function summaryTags(rows: readonly PropertyRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.kind === "tags" || row.kind === "tagString") out.push(...row.items);
  }
  return out.filter((t) => t !== "");
}

export function splitTagString(value: string): string[] {
  return value.split(/[\s,]+/).filter((t) => t !== "");
}

// ---------------------------------------------------------------------------
// Text splices
// ---------------------------------------------------------------------------

export function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

export function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", pos);
  return i < 0 ? text.length : i;
}

export function splice(text: string, from: number, to: number, insert: string): string {
  return text.slice(0, from) + insert + text.slice(to);
}

/** The offset just after the `:` that follows `pair`'s key. */
export function afterColon(text: string, pair: Pair): number {
  const keyEnd = (pair.key as Node).range?.[1] ?? 0;
  let i = keyEnd;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return text[i] === ":" ? i + 1 : keyEnd;
}

/** Where a node's last content character is: a block collection ends where its last item does. */
function nodeContentEnd(text: string, node: Node | null | undefined): number {
  if (!node?.range) return 0;
  if (isMap(node) && !node.flow && node.items.length > 0)
    return pairContentEnd(text, node.items[node.items.length - 1]);
  if (isSeq(node) && !node.flow && node.items.length > 0)
    return nodeContentEnd(text, node.items[node.items.length - 1] as Node);
  const end = node.range[1];
  return end > 0 && text[end - 1] === "\n" ? end - 1 : end;
}

/** Where a pair's last content character is (a trailing comment on that line is part of it). */
export function pairContentEnd(text: string, pair: Pair): number {
  const key = pair.key as Node;
  const value = pair.value as Node | null;
  const end = value?.range ? nodeContentEnd(text, value) : (key.range?.[1] ?? 0);
  return Math.max(end, afterColon(text, pair));
}

/** [from, to) covering the whole lines of a pair, without the final newline. */
export function pairLines(text: string, pair: Pair): [number, number] {
  const from = lineStart(text, (pair.key as Node).range?.[0] ?? 0);
  return [from, lineEnd(text, pairContentEnd(text, pair))];
}

export function removeLines(text: string, from: number, to: number): string {
  if (to < text.length) return splice(text, from, to + 1, "");
  return from > 0 ? splice(text, from - 1, to, "") : splice(text, from, to, "");
}

export function renderKey(key: string): string {
  return stringify(key, { lineWidth: 0 }).trimEnd();
}

export function renderScalar(value: ScalarValue, like?: Node | null): string | null {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (value.includes("\n")) return null;
  const scalar = new Scalar(value);
  if (isScalar(like) && (like.type === "QUOTE_DOUBLE" || like.type === "QUOTE_SINGLE"))
    scalar.type = like.type;
  const out = stringify(scalar, { lineWidth: 0 }).trimEnd();
  return out.includes("\n") ? null : out;
}

export function renderFlow(items: readonly string[]): string | null {
  const parts: string[] = [];
  for (const item of items) {
    const r = renderScalar(item);
    if (r === null) return null;
    parts.push(r);
  }
  return `[${parts.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Verified edits
// ---------------------------------------------------------------------------

export function toObject(doc: Document): Record<string, unknown> {
  try {
    return (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sameEntries(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
}

export const REFUSED = "That change could not be applied without altering other properties.";

/** Re-parse `next` and require it to equal `expected`; on a mismatch the edit is refused. */
export function verified(
  before: Document,
  next: string,
  change: (obj: Record<string, unknown>) => Record<string, unknown>,
): EditResult {
  const opened = openMap(next);
  if (!opened.ok) return { ok: false, error: REFUSED };
  const expected = change(structuredClone(toObject(before)));
  if (!sameEntries(toObject(opened.doc), expected)) return { ok: false, error: REFUSED };
  return { ok: true, text: next };
}

interface Located {
  text: string;
  doc: Document;
  map: YAMLMap | null;
  pair: Pair | null;
}

function locate(text: string, key: string): Located | { error: string } {
  const opened = openMap(text);
  if (!opened.ok) return { error: opened.message };
  const pair = opened.map?.items.find((p) => keyText(p) === key) ?? null;
  return { text, doc: opened.doc, map: opened.map, pair };
}

export function failure(error: string): EditResult {
  return { ok: false, error };
}

/** Replace a property's whole value with `value` (one line), keeping the key line's neighbours.
 *  A string keeps the quote style of the value it replaces unless `restyle` is set (a conversion
 *  to a date, whose ISO text must be plain). */
export function setScalar(
  text: string,
  key: string,
  value: ScalarValue,
  restyle = false,
): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The property "${key}" does not exist.`);
  const node = at.pair.value as Node | null;
  const rendered = renderScalar(value, restyle ? null : node);
  if (rendered === null) return failure("That value cannot be written on one line.");

  let next: string;
  const range = node?.range;
  if (
    node &&
    range &&
    isScalar(node) &&
    node.type !== "BLOCK_LITERAL" &&
    node.type !== "BLOCK_FOLDED" &&
    range[1] > range[0] &&
    !text.slice(range[0], range[1]).includes("\n")
  ) {
    next =
      value === null
        ? splice(text, afterColon(text, at.pair), range[1], "")
        : splice(text, range[0], range[1], rendered);
  } else if (node === null || (isScalar(node) && node.value === null)) {
    // `key:` with nothing after the colon.
    next =
      value === null
        ? text
        : splice(text, afterColon(text, at.pair), afterColon(text, at.pair), ` ${rendered}`);
  } else {
    const [from, to] = pairLines(text, at.pair);
    next = splice(text, from, to, `${renderKey(key)}:${rendered === "" ? "" : ` ${rendered}`}`);
  }
  if (next === text) return { ok: true, text };
  return verified(at.doc, next, (o) => ({ ...o, [key]: value }));
}

/** Append a new property at the end of the block. `value` is `[]` for the list kinds. */
export function addProperty(
  text: string,
  key: string,
  value: ScalarValue | readonly string[] | EmptyObject,
): EditResult {
  const name = key.trim();
  if (name === "") return failure("A property needs a name.");
  if (/[\n\r]/.test(name)) return failure("A property name must be on one line.");
  const at = locate(text, name);
  if ("error" in at) return failure(at.error);
  if (at.pair) return failure(`The property "${name}" already exists.`);
  const empty = value === EMPTY_OBJECT;
  let rendered: string | null;
  if (empty) rendered = "{}";
  else if (Array.isArray(value)) rendered = renderFlow(value);
  else rendered = renderScalar(value as ScalarValue);
  if (rendered === null) return failure("That value cannot be written on one line.");
  const line = `${renderKey(name)}:${rendered === "" ? "" : ` ${rendered}`}`;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  const next = `${text}${sep}${line}`;
  return verified(at.doc, next, (o) => ({
    ...o,
    [name]: empty ? {} : Array.isArray(value) ? [...value] : value,
  }));
}

export function removeProperty(text: string, key: string): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return { ok: true, text };
  const [from, to] = pairLines(text, at.pair);
  const next = removeLines(text, from, to);
  return verified(at.doc, next, (o) => {
    const { [key]: _removed, ...rest } = o;
    return rest;
  });
}

export function renameProperty(text: string, key: string, to: string): EditResult {
  const name = to.trim();
  if (name === key) return { ok: true, text };
  if (name === "") return failure("A property needs a name.");
  if (/[\n\r]/.test(name)) return failure("A property name must be on one line.");
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The property "${key}" does not exist.`);
  if (at.map?.items.some((p) => keyText(p) === name))
    return failure(`The property "${name}" already exists.`);
  const range = (at.pair.key as Node).range as [number, number, number];
  const next = splice(text, range[0], range[1], renderKey(name));
  return verified(at.doc, next, (o) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k === key ? name : k, v])),
  );
}

/** Append one item to a list property (a block list gains a `- item` line). */
export function appendListItem(text: string, key: string, item: string): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The property "${key}" does not exist.`);
  const rendered = renderScalar(item);
  if (rendered === null || item === "") return failure("That item cannot be added.");
  const node = at.pair.value as Node | null;
  const current = (toObject(at.doc)[key] ?? []) as unknown[];
  if (!Array.isArray(current)) return failure(`The property "${key}" is not a list.`);

  let next: string;
  if (isSeq(node) && !node.flow && node.items.length > 0) {
    const last = node.items[node.items.length - 1] as Node;
    const lastLine = text.slice(
      lineStart(text, last.range?.[0] ?? 0),
      lineEnd(text, last.range?.[1] ?? 0),
    );
    const marker = /^(\s*-\s+)/.exec(lastLine)?.[1] ?? "  - ";
    const at2 = lineEnd(text, last.range?.[1] ?? 0);
    next = splice(text, at2, at2, `\n${marker}${rendered}`);
  } else if (isSeq(node) && node.flow && node.items.length > 0) {
    const items = scalarItems(node);
    const flow = items && renderFlow([...items, item]);
    if (!flow || !node.range) return failure("That list cannot be edited here.");
    next = splice(text, node.range[0], node.range[1], flow);
  } else if (
    node === null ||
    (isScalar(node) && node.value === null) ||
    (isSeq(node) && node.items.length === 0)
  ) {
    const from = afterColon(text, at.pair);
    const to = node?.range && isSeq(node) ? node.range[1] : from;
    next = splice(text, from, to, `\n  - ${rendered}`);
  } else {
    return failure(`The property "${key}" is not a list.`);
  }
  return verified(at.doc, next, (o) => ({ ...o, [key]: [...current, item] }));
}

/** Replace a property's whole value with the block list `items` (`key: []` when empty). */
export function setList(text: string, key: string, items: readonly string[]): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The property "${key}" does not exist.`);
  const rendered: string[] = [];
  for (const item of items) {
    const r = renderScalar(item);
    if (r === null) return failure("That value cannot be written on one line.");
    rendered.push(r);
  }
  const head = `${renderKey(key)}:`;
  const body =
    rendered.length === 0 ? `${head} []` : `${head}\n${rendered.map((r) => `  - ${r}`).join("\n")}`;
  const [from, to] = pairLines(text, at.pair);
  return verified(at.doc, splice(text, from, to, body), (o) => ({ ...o, [key]: [...items] }));
}

/** Remove the item at `index` from a list property. */
export function removeListItem(text: string, key: string, index: number): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The property "${key}" does not exist.`);
  const node = at.pair.value as Node | null;
  if (!isSeq(node) || index < 0 || index >= node.items.length)
    return failure(`The property "${key}" has no such item.`);
  const current = toObject(at.doc)[key] as unknown[];
  let next: string;
  if (node.flow) {
    const items = scalarItems(node);
    const rest = items?.filter((_, i) => i !== index);
    const flow = rest && renderFlow(rest);
    if (flow === null || flow === undefined || !node.range)
      return failure("That list cannot be edited here.");
    next = splice(text, node.range[0], node.range[1], flow);
  } else {
    const item = node.items[index] as Node;
    const from = lineStart(text, item.range?.[0] ?? 0);
    next = removeLines(text, from, lineEnd(text, item.range?.[1] ?? 0));
  }
  return verified(at.doc, next, (o) => ({ ...o, [key]: current.filter((_, i) => i !== index) }));
}

/** Rewrite a tags value stored as one string (`tags: a b`), keeping its separator style. */
export function setTagString(text: string, key: string, tags: readonly string[]): EditResult {
  const at = locate(text, key);
  if ("error" in at) return failure(at.error);
  const node = at.pair?.value as Node | null | undefined;
  const old = isScalar(node) && typeof node.value === "string" ? node.value : "";
  const joined = tags.join(old.includes(",") ? ", " : " ");
  return setScalar(text, key, joined === "" ? null : joined);
}

/** Whether `text` ends up as nothing but whitespace (the block can be dropped). */
export function isBlank(text: string): boolean {
  return text.trim() === "";
}

// ---------------------------------------------------------------------------
// New properties
// ---------------------------------------------------------------------------

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** The starting value written for a new property of `type`. */
export function initialValue(
  type: PropertyType,
  now: Date = new Date(),
): ScalarValue | string[] | EmptyObject {
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  switch (type) {
    case "text":
    case "enum": // nothing picked yet
    case "relationships": // no link yet: the first one written is a single value
    case "url": // no address yet: the first one written is a single value
      return null;
    case "number":
      return 0;
    case "checkbox":
      return false;
    case "date":
      return date;
    case "datetime":
      return `${date}T${two(now.getHours())}:${two(now.getMinutes())}`;
    case "multitext":
    case "tags":
    case "aliases":
      return [];
    case "object":
      return EMPTY_OBJECT;
  }
}
