// Byte-minimal edits of one key inside a property's map (`metadata.version`, `metadata.flags.beta`):
// the `object` property type of `SPECs/properties-types-spec.md`, ADR
// `2026-11-18-add-an-object-property-type-edited-as-indented-rows-up-to-two-levels`. Pure text in,
// text out, built from the `yaml` Document node ranges like the top-level splices in
// `frontmatter-properties.ts` (whose helpers it shares), and verified the same way: the result is
// re-parsed and must equal the old block with only that key changed, else the edit is refused.
//
// A set replaces the key's value (or its lines), an add appends lines after the map's last entry,
// a remove drops the key's lines, a rename replaces the key token. An emptied map becomes
// `key: {}`; the first key added to `key: {}` turns it into a block (a trailing comment stays).
// Only block maps with plain keys are edited, two levels deep; flow maps, anchored maps and
// anything deeper are refused, never rewritten. The Rust patcher (`src-tauri/src/index/patch/
// nested.rs`) does the same on its side; both are pinned by `shared/nested-property-vectors.json`.
import { isMap, isScalar, isSeq, type Document, type Node, type Pair, type YAMLMap } from "yaml";
import {
  MAX_MAP_LEVEL,
  afterColon,
  failure,
  isEditableMap,
  keyText,
  lineEnd,
  lineStart,
  openMap,
  pairContentEnd,
  pairLines,
  removeLines,
  renderKey,
  renderScalar,
  splice,
  verified,
  type EditResult,
  type ScalarValue,
} from "./frontmatter-properties";

/** What a nested key holds: a scalar, or a list of text. */
export type NestedValue = ScalarValue | readonly string[];

/** `[property, key]` or `[property, key, key]`. */
export type NestedPath = readonly string[];

const MIN_PATH = 2;
const MAX_PATH = MAX_MAP_LEVEL + 1;

interface Target {
  doc: Document;
  /** The map the key lives in, and the pair that holds it. */
  map: YAMLMap;
  owner: Pair;
  name: string;
  /** The key's own pair; `null` when it does not exist (yet). */
  pair: Pair | null;
}

function label(path: NestedPath): string {
  return path.join(".");
}

function column(text: string, pair: Pair): number {
  const at = (pair.key as Node).range?.[0] ?? 0;
  return at - lineStart(text, at);
}

/** Walk `path` down to the map that holds its last key, refusing anything that is not an editable
 *  block map (a flow map, an anchor, a duplicate key) on the way. */
function locate(text: string, path: NestedPath): Target | { error: string } {
  if (path.length < MIN_PATH || path.length > MAX_PATH)
    return { error: "Only two levels of a property's map can be edited here." };
  const opened = openMap(text);
  if (!opened.ok) return { error: opened.message };
  const inSource = `"${label(path)}" can only be edited in Source.`;
  let map = opened.map;
  let owner: Pair | null = null;
  for (const part of path.slice(0, -1)) {
    const pair: Pair | undefined = map?.items.find((p) => keyText(p) === part);
    if (!pair) return { error: `The property "${part}" does not exist.` };
    const node = pair.value as Node | null;
    if (!isMap(node)) return { error: `The property "${part}" is not an object.` };
    if (!isEditableMap(node)) return { error: inSource };
    // the key must start its line: a block map has no other layout
    const at = (pair.key as Node).range?.[0] ?? 0;
    if (text.slice(lineStart(text, at), at).trim() !== "") return { error: inSource };
    map = node;
    owner = pair;
  }
  const name = path[path.length - 1];
  const pair = map?.items.find((p) => keyText(p) === name) ?? null;
  return { doc: opened.doc, map: map as YAMLMap, owner: owner as Pair, name, pair };
}

function cloneAt(obj: Record<string, unknown>, path: NestedPath): Record<string, unknown> {
  let at = obj;
  for (const part of path) at = at[part] as Record<string, unknown>;
  return at;
}

function checkValue(value: NestedValue): string | null {
  if (Array.isArray(value) && value.some((v) => typeof v !== "string"))
    return "A list holds text only.";
  return null;
}

/** `head: value` (or `head:` and the block list lines) with `indent` spaces before list dashes. */
function renderLines(head: string, value: NestedValue, indent: number): string[] | null {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const r = renderScalar(item);
      if (r === null) return null;
      items.push(`${" ".repeat(indent + 2)}- ${r}`);
    }
    return items.length === 0 ? [`${head}: []`] : [`${head}:`, ...items];
  }
  const r = renderScalar(value as ScalarValue);
  if (r === null) return null;
  return [`${head}:${r === "" ? "" : ` ${r}`}`];
}

const ONE_LINE = "That value cannot be written on one line.";

/** Replace the value of an existing key with a scalar or a list of text. A key holding a map is not
 *  replaced (set its keys instead). */
export function setNested(text: string, path: NestedPath, value: NestedValue): EditResult {
  const at = locate(text, path);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The key "${label(path)}" does not exist.`);
  const bad = checkValue(value);
  if (bad) return failure(bad);
  const node = at.pair.value as Node | null;
  if (isMap(node)) return failure(`"${label(path)}" is an object; set its keys one by one.`);

  const list = Array.isArray(value);
  const inline = list
    ? value.length === 0
      ? "[]"
      : null
    : renderScalar(value as ScalarValue, node);
  if (!list && inline === null) return failure(ONE_LINE);
  const range = node?.range;
  const token =
    node &&
    range &&
    range[1] > range[0] &&
    !text.slice(range[0], range[1]).includes("\n") &&
    ((isScalar(node) && node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED") ||
      (isSeq(node) && node.flow));

  let next: string;
  if (inline !== null && token && range) {
    // one-line value for one-line value: only the value token changes (quote style, comment stay)
    next =
      inline === ""
        ? splice(text, afterColon(text, at.pair), range[1], "")
        : splice(text, range[0], range[1], inline);
  } else if (inline !== null && (node === null || (isScalar(node) && node.value === null))) {
    // `key:` with nothing after the colon
    const colon = afterColon(text, at.pair);
    next = inline === "" ? text : splice(text, colon, colon, ` ${inline}`);
  } else {
    const [from, to] = pairLines(text, at.pair);
    const keyAt = (at.pair.key as Node).range?.[0] ?? 0;
    const head = text.slice(lineStart(text, keyAt), afterColon(text, at.pair) - 1);
    const lines = renderLines(head, value, column(text, at.pair));
    if (lines === null) return failure(ONE_LINE);
    next = splice(text, from, to, lines.join("\n"));
  }
  if (next === text) return { ok: true, text };
  return verified(at.doc, next, (o) => {
    const parent = cloneAt(o, path.slice(0, -1));
    parent[at.name] = list ? [...value] : value;
    return o;
  });
}

/** Add a key at the end of the map that holds it (`key: {}` becomes a block). */
export function addNested(text: string, path: NestedPath, value: NestedValue): EditResult {
  const probe = locate(text, path);
  if ("error" in probe) return failure(probe.error);
  const name = probe.name.trim();
  if (name === "") return failure("A key needs a name.");
  if (/[\n\r]/.test(name)) return failure("A key name must be on one line.");
  if (probe.pair) return failure(`The key "${label(path)}" already exists.`);
  const bad = checkValue(value);
  if (bad) return failure(bad);

  const { map, owner } = probe;
  const last = map.items[map.items.length - 1];
  const indent = last ? column(text, map.items[0]) : column(text, owner) + 2;
  const lines = renderLines(`${" ".repeat(indent)}${renderKey(name)}`, value, indent);
  if (lines === null) return failure(ONE_LINE);
  const insert = `\n${lines.join("\n")}`;

  let next: string;
  if (last) {
    const at = lineEnd(text, pairContentEnd(text, last));
    next = splice(text, at, at, insert);
  } else {
    // `key: {}`: the braces go, the new key follows on the next line (a comment stays on the key)
    const braceEnd = map.range?.[1] ?? afterColon(text, owner);
    const withLines = splice(text, lineEnd(text, braceEnd), lineEnd(text, braceEnd), insert);
    next = splice(withLines, afterColon(text, owner), braceEnd, "");
  }
  return verified(probe.doc, next, (o) => {
    cloneAt(o, path.slice(0, -1))[name] = Array.isArray(value) ? [...value] : value;
    return o;
  });
}

/** Remove a key's lines. Removing a map's last key leaves `key: {}`. */
export function removeNested(text: string, path: NestedPath): EditResult {
  const at = locate(text, path);
  if ("error" in at) return failure(at.error);
  if (!at.pair) return failure(`The key "${label(path)}" does not exist.`);
  const [from, to] = pairLines(text, at.pair);
  let next = removeLines(text, from, to);
  if (at.map.items.length === 1) {
    // an empty map is `key: {}`: a bare `key:` would read as null
    const colon = afterColon(text, at.owner);
    next = splice(next, colon, colon, " {}");
  }
  return verified(at.doc, next, (o) => {
    delete cloneAt(o, path.slice(0, -1))[at.name];
    return o;
  });
}

/** Rename a key: only the key token changes. */
export function renameNested(text: string, path: NestedPath, to: string): EditResult {
  const at = locate(text, path);
  if ("error" in at) return failure(at.error);
  const name = to.trim();
  if (name === at.name) return { ok: true, text };
  if (name === "") return failure("A key needs a name.");
  if (/[\n\r]/.test(name)) return failure("A key name must be on one line.");
  if (!at.pair) return failure(`The key "${label(path)}" does not exist.`);
  if (at.map.items.some((p) => keyText(p) === name)) return failure(`"${name}" already exists.`);
  const range = (at.pair.key as Node).range as [number, number, number];
  const next = splice(text, range[0], range[1], renderKey(name));
  return verified(at.doc, next, (o) => {
    const parent = cloneAt(o, path.slice(0, -1));
    const entries = Object.entries(parent).map(([k, v]) => [k === at.name ? name : k, v] as const);
    for (const k of Object.keys(parent)) delete parent[k];
    for (const [k, v] of entries) parent[k] = v;
    return o;
  });
}
