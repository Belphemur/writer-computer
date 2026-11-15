// The one `.base` mutation module. Every config edit (sort, group, filters, properties, column
// size, views, view options) is a function from the current text to the new text, built on the
// `yaml` Document API so comments, key order, scalar styles and unknown keys (plugin options,
// `rowHeight`, ...) survive: only the targeted nodes change. A function that changes nothing
// returns the input text unchanged (callers skip the write when `next === text`).
//
// No IO and no React here; the write path (`use-base-config.ts`) reads the file, calls one of
// these, writes the result, and reloads.
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { canonicalPropertyKey } from "./cells";
import type { BaseFilter, BaseGroupBy, BaseSortKey } from "./types";

/** The text is not a `.base` this module can edit (invalid YAML, unexpected shape). */
export class BaseYamlError extends Error {}

type Doc = Document;

/** Block sequences that sit at the parent key's indent (`views:\n- type: ...`) keep that style. */
function usesFlushSequences(text: string): boolean {
  return /^([ \t]*)[^\s#-][^\n]*:[ \t]*\n\1- /m.test(text);
}

function dump(doc: Doc, flush: boolean): string {
  return doc.toString({ lineWidth: 0, indentSeq: !flush });
}

/**
 * Parse, apply `edit`, serialize. Returns `text` itself when `edit` changed nothing.
 *
 * `yaml` re-prints untouched nodes in its own style (for example `[x, y]` becomes `[ x, y ]`), so
 * the edit is serialized twice (before and after) and only the changed line range is spliced into
 * the original text. That keeps every line outside the edit byte-identical. When the normalized
 * original no longer lines up with the file (different line count), the full output is used.
 */
function mutate(text: string, edit: (doc: Doc) => void): string {
  const doc = parseDocument(text);
  const first = doc.errors[0];
  if (first) throw new BaseYamlError(`The .base file is not valid YAML: ${first.message}`);
  if (doc.contents !== null && !isMap(doc.contents))
    throw new BaseYamlError("The .base file must be a YAML mapping");
  const flush = usesFlushSequences(text);
  const before = dump(doc, flush);
  edit(doc);
  const after = dump(doc, flush);
  if (after === before) return text;
  if (before === text) return after;
  const orig = text.split("\n");
  const a = before.split("\n");
  const b = after.split("\n");
  if (orig.length !== a.length) return after;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return [
    ...orig.slice(0, head),
    ...b.slice(head, b.length - tail),
    ...orig.slice(orig.length - tail),
  ].join("\n");
}

function root(doc: Doc): YAMLMap {
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAMLMap;
  return doc.contents as YAMLMap;
}

function viewsSeq(doc: Doc, create: boolean): YAMLSeq | null {
  const node = root(doc).get("views", true);
  if (isSeq(node)) return node;
  if (node === undefined || (isScalar(node) && node.value === null)) {
    if (!create) return null;
    const seq = doc.createNode([]) as YAMLSeq;
    root(doc).set("views", seq);
    return seq;
  }
  throw new BaseYamlError("`views` must be a list");
}

function viewMap(doc: Doc, index: number): YAMLMap {
  const seq = viewsSeq(doc, false);
  const node = seq?.items[index];
  if (!isMap(node)) throw new BaseYamlError(`View ${index + 1} does not exist or is not a mapping`);
  return node;
}

/** The existing key of `map` that names the same property as `id`, else `id`. */
function matchingKey(map: YAMLMap, id: string): string {
  const want = canonicalPropertyKey(id);
  for (const pair of map.items) {
    const k = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof k === "string" && canonicalPropertyKey(k) === want) return k;
  }
  return id;
}

function setOrDelete(map: YAMLMap, doc: Doc, key: string, value: unknown): void {
  if (value === undefined || value === null) map.delete(key);
  else map.set(key, doc.createNode(value));
}

// ---------------------------------------------------------------------------
// View-level values
// ---------------------------------------------------------------------------

/** Set (or, with `undefined`, remove) one key of a view. Used for options and simple keys. */
export function setViewValue(text: string, viewIndex: number, key: string, value: unknown): string {
  return mutate(text, (doc) => {
    const view = viewMap(doc, viewIndex);
    if (value === undefined || value === null) {
      view.delete(key);
      return;
    }
    // Keep the existing node (and its comments) when the scalar value is unchanged.
    const current = view.get(key, true);
    if (isScalar(current) && current.value === value) return;
    const next = doc.createNode(value);
    if (isScalar(current) && isScalar(next)) {
      current.value = next.value;
      return;
    }
    view.set(key, next);
  });
}

export function setSort(text: string, viewIndex: number, keys: readonly BaseSortKey[]): string {
  return setViewValue(
    text,
    viewIndex,
    "sort",
    keys.length === 0
      ? undefined
      : keys.map((k) => ({ property: k.property, direction: k.direction })),
  );
}

export function setGroupBy(text: string, viewIndex: number, groupBy: BaseGroupBy | null): string {
  return setViewValue(
    text,
    viewIndex,
    "groupBy",
    groupBy ? { property: groupBy.property, direction: groupBy.direction } : undefined,
  );
}

export function setLimit(text: string, viewIndex: number, limit: number | null): string {
  if (limit !== null && (!Number.isInteger(limit) || limit < 1))
    throw new BaseYamlError("The limit must be a whole number of at least 1");
  return setViewValue(text, viewIndex, "limit", limit ?? undefined);
}

export function setOrder(text: string, viewIndex: number, ids: readonly string[]): string {
  return setViewValue(text, viewIndex, "order", [...ids]);
}

/** Filters of one view (`viewIndex`) or of the whole base (`"base"`); `null` removes them. */
export function setFilters(
  text: string,
  scope: number | "base",
  filter: BaseFilter | null,
): string {
  if (scope !== "base") return setViewValue(text, scope, "filters", filter ?? undefined);
  return mutate(text, (doc) => setOrDelete(root(doc), doc, "filters", filter));
}

/** Width in px of one column (`columnSize`); `null` removes the entry. */
export function setColumnSize(
  text: string,
  viewIndex: number,
  columnId: string,
  px: number | null,
): string {
  return mutate(text, (doc) => {
    const view = viewMap(doc, viewIndex);
    const sizes = view.get("columnSize", true);
    if (px === null) {
      if (!isMap(sizes)) return;
      sizes.delete(matchingKey(sizes, columnId));
      if (sizes.items.length === 0) view.delete("columnSize");
      return;
    }
    const width = Math.round(px);
    if (isMap(sizes)) sizes.set(matchingKey(sizes, columnId), width);
    else view.set("columnSize", doc.createNode({ [columnId]: width }));
  });
}

/** `properties.<id>.displayName`; `null` removes it (and the entry when it becomes empty). */
export function setDisplayName(text: string, propertyId: string, name: string | null): string {
  return mutate(text, (doc) => {
    const props = root(doc).get("properties", true);
    if (name === null || name === "") {
      if (!isMap(props)) return;
      const key = matchingKey(props, propertyId);
      const entry = props.get(key, true);
      if (!isMap(entry)) return;
      entry.delete("displayName");
      if (entry.items.length === 0) props.delete(key);
      if (props.items.length === 0) root(doc).delete("properties");
      return;
    }
    if (!isMap(props)) {
      root(doc).set("properties", doc.createNode({ [propertyId]: { displayName: name } }));
      return;
    }
    const key = matchingKey(props, propertyId);
    const entry = props.get(key, true);
    if (isMap(entry)) entry.set("displayName", name);
    else props.set(key, doc.createNode({ displayName: name }));
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function viewNames(seq: YAMLSeq): string[] {
  return seq.items.map((v) => {
    const name = isMap(v) ? v.get("name") : undefined;
    return typeof name === "string" ? name : "";
  });
}

/** `base`, else `base 2`, `base 3`, ... not in `names`. */
export function uniqueViewName(names: readonly string[], base: string): string {
  if (!names.includes(base)) return base;
  for (let n = 2; ; n++) if (!names.includes(`${base} ${n}`)) return `${base} ${n}`;
}

function assertName(name: string, taken: readonly string[]): void {
  if (name.trim() === "") throw new BaseYamlError("A view needs a name");
  if (taken.includes(name)) throw new BaseYamlError(`A view named "${name}" already exists`);
}

/** Append a view. A base without views gets its implicit "Table" view written out first. */
export function addView(text: string, view: { type: string; name: string }): string {
  return mutate(text, (doc) => {
    const seq = viewsSeq(doc, true)!;
    if (seq.items.length === 0) seq.add(doc.createNode({ type: "table", name: "Table" }));
    assertName(view.name, viewNames(seq));
    seq.add(doc.createNode({ type: view.type, name: view.name }));
  });
}

/** Copy view `index` (all keys, comments included) right after itself under `name`. */
export function duplicateView(text: string, index: number, name: string): string {
  return mutate(text, (doc) => {
    const seq = viewsSeq(doc, false);
    const source = seq?.items[index];
    if (!seq || !isMap(source)) throw new BaseYamlError(`View ${index + 1} does not exist`);
    assertName(name, viewNames(seq));
    const copy = source.clone() as YAMLMap;
    copy.commentBefore = null;
    copy.comment = null;
    copy.set("name", name);
    seq.items.splice(index + 1, 0, copy);
  });
}

export function renameView(text: string, index: number, name: string): string {
  return mutate(text, (doc) => {
    const view = viewMap(doc, index);
    const seq = viewsSeq(doc, false)!;
    const others = viewNames(seq).filter((_, i) => i !== index);
    assertName(name, others);
    view.set("name", name);
  });
}

/** Move the view at `from` so it ends up at index `to`. */
export function moveView(text: string, from: number, to: number): string {
  return mutate(text, (doc) => {
    const seq = viewsSeq(doc, false);
    if (!seq || !seq.items[from] || to < 0 || to >= seq.items.length)
      throw new BaseYamlError("That view move is out of range");
    if (from === to) return;
    const [item] = seq.items.splice(from, 1);
    seq.items.splice(to, 0, item!);
  });
}

export function deleteView(text: string, index: number): string {
  return mutate(text, (doc) => {
    const seq = viewsSeq(doc, false);
    if (!seq || !seq.items[index]) throw new BaseYamlError(`View ${index + 1} does not exist`);
    if (seq.items.length === 1)
      throw new BaseYamlError("A base needs at least one view; edit the YAML to remove it");
    seq.items.splice(index, 1);
  });
}

// ---------------------------------------------------------------------------
// In-memory only
// ---------------------------------------------------------------------------

/**
 * `text` with `ids` appended to the view's `order` (the effective order is `fallback` when the
 * view has none). Never written to disk: a view that needs values of properties it does not show
 * (an image property, a plugin's property option) queries this text through `base_query_text`.
 */
export function withExtraColumns(
  text: string,
  viewIndex: number | null,
  ids: readonly string[],
  fallback: readonly string[],
): string {
  if (ids.length === 0 || viewIndex === null) return text;
  return mutate(text, (doc) => {
    const view = viewMap(doc, viewIndex);
    const order = view.get("order", true);
    const current: string[] = isSeq(order)
      ? order.items.map((i) => String(isScalar(i) ? i.value : i))
      : [...fallback];
    view.set("order", doc.createNode([...current, ...extraColumnsToAdd(current, ids)]));
  });
}

/** The ids of `ids` that `order` does not already contain (compared as canonical keys). */
export function extraColumnsToAdd(order: readonly string[], ids: readonly string[]): string[] {
  const have = new Set(order.map(canonicalPropertyKey));
  const out: string[] = [];
  for (const id of ids) {
    const key = canonicalPropertyKey(id);
    if (!have.has(key)) {
      have.add(key);
      out.push(id);
    }
  }
  return out;
}
