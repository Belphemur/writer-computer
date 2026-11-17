// Completion for Bases expressions (filters, formulas, formula-typed view options). Pure: no
// React, no IPC. The editor component (`components/base-view/expression-input.tsx`) feeds it the
// text and the caret and renders what it returns.
//
// Sources, none of them invented here:
//   - functions and methods: the engine's own registry (`base_functions`, Rust `FUNCTIONS`), so a
//     function the engine lacks can never be offered;
//   - namespaces `note`, `file`, `formula`, `this`, the keyword literals, the file fields and the
//     fields of strings, lists, dates and durations (the engine's `file_field`, `get_field`);
//   - property names from the vault index and formula names from the document being edited.
//
// Contexts (`completionContext`): after a dot the receiver expression decides the candidates (its
// type is inferred from literals, namespaces, property types and registry return types); without
// a dot the candidates are namespaces, properties, formulas, global functions and keywords; inside
// `note["` the candidates are property names. Inside any other string, or after a number, nothing
// is offered.
import type { BaseFunctionInfo, VaultProperty } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExprType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "duration"
  | "list"
  | "object"
  | "link"
  | "file"
  | "regexp"
  | "html"
  | "image"
  | "icon"
  | "any";

const EXPR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "duration",
  "list",
  "object",
  "link",
  "file",
  "regexp",
  "html",
  "image",
  "icon",
  "any",
]);

/** What the completion needs to know about the document and the vault. */
export interface CompletionEnv {
  /** The engine's registry (`base_functions`). */
  functions: readonly BaseFunctionInfo[];
  /** Vault properties from the index. */
  properties: readonly VaultProperty[];
  /** Formulas of the document being edited: name -> expression. */
  formulas: Readonly<Record<string, string>>;
}

export type CandidateKind =
  | "function"
  | "method"
  | "namespace"
  | "property"
  | "field"
  | "formula"
  | "keyword";

export interface Candidate {
  /** Stable identity (React key, `aria-activedescendant`). */
  id: string;
  /** The name shown. */
  label: string;
  kind: CandidateKind;
  /** Group heading in the list. */
  group: string;
  /** Signature or type, shown next to the label. */
  detail: string;
  /** One-line documentation. */
  doc: string;
  /** Replaces `text.slice(from, to)`. */
  from: number;
  to: number;
  insert: string;
  /** Caret position inside `insert` after applying (default: its end). */
  caret: number;
  /** Open the list again after applying (a namespace inserts `file.`). */
  retrigger: boolean;
}

// ---------------------------------------------------------------------------
// Static vocabulary
// ---------------------------------------------------------------------------

export const NAMESPACES: readonly { name: string; doc: string }[] = [
  { name: "note", doc: "Properties of the note (frontmatter)." },
  { name: "file", doc: "Fields and methods of the file." },
  { name: "formula", doc: "Formulas defined in this base." },
  { name: "this", doc: "The base itself, or the note that embeds it." },
];

export const KEYWORDS: readonly { name: string; detail: string }[] = [
  { name: "true", detail: "boolean literal" },
  { name: "false", detail: "boolean literal" },
  { name: "null", detail: "null literal" },
];

interface FieldDef {
  name: string;
  type: ExprType;
  doc: string;
}

/** `file.<name>` (the engine's `file_field`). */
export const FILE_FIELDS: readonly FieldDef[] = [
  { name: "name", type: "string", doc: "File name with extension." },
  { name: "basename", type: "string", doc: "File name without extension." },
  { name: "path", type: "string", doc: "Vault-relative path." },
  { name: "folder", type: "string", doc: "Folder the file is in." },
  { name: "ext", type: "string", doc: "File extension." },
  { name: "size", type: "number", doc: "Size in bytes." },
  { name: "ctime", type: "date", doc: "Creation time." },
  { name: "mtime", type: "date", doc: "Last modification time." },
  { name: "tags", type: "list", doc: "Tags of the file." },
  { name: "links", type: "list", doc: "Links in the file." },
  { name: "backlinks", type: "list", doc: "Files that link to this one." },
  { name: "embeds", type: "list", doc: "Embeds in the file." },
  { name: "properties", type: "object", doc: "All frontmatter properties." },
];

/** Fields of non-file values (`get_field`, `date_field`, `duration_field` in the engine). */
export const VALUE_FIELDS: Partial<Record<ExprType, readonly FieldDef[]>> = {
  string: [{ name: "length", type: "number", doc: "Number of characters." }],
  list: [{ name: "length", type: "number", doc: "Number of items." }],
  date: ["year", "month", "day", "hour", "minute", "second", "millisecond"].map((name) => ({
    name,
    type: "number" as const,
    doc: `The ${name} of the date.`,
  })),
  duration: ["milliseconds", "seconds", "minutes", "hours", "days", "weeks", "months", "years"].map(
    (name) => ({ name, type: "number" as const, doc: `The duration as a number of ${name}.` }),
  ),
};

/** Index types (`index_properties`) to expression types. */
const INDEX_TYPE: Record<string, ExprType> = {
  text: "string",
  number: "number",
  bool: "boolean",
  boolean: "boolean",
  checkbox: "boolean",
  date: "date",
  datetime: "date",
  list: "list",
  link: "link",
  object: "object",
};

const NAMESPACE_NAMES: ReadonlySet<string> = new Set(NAMESPACES.map((n) => n.name));
const RESERVED = new Set([...NAMESPACE_NAMES, ...KEYWORDS.map((k) => k.name)]);

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Whether `name` can be written as a bare identifier (U5) and is not a namespace or literal. */
export function isBareIdentifier(name: string): boolean {
  return IDENT.test(name) && !RESERVED.has(name);
}

/** `"my prop"` quoted for an expression string literal. */
export function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// ---------------------------------------------------------------------------
// Tokenizer (left of the caret only; tolerant, never throws)
// ---------------------------------------------------------------------------

type TokKind = "ident" | "num" | "str" | "regex" | "(" | ")" | "[" | "]" | "," | "." | "op";

export interface Tok {
  kind: TokKind;
  start: number;
  end: number;
  text: string;
  /** A string or regexp literal that was not closed before the end of the text. */
  open: boolean;
}

const isIdentStart = (c: string) => /[\p{L}_$]/u.test(c);
const isIdentChar = (c: string) => /[\p{L}\p{N}_$]/u.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Tokens of `src`, mirroring the engine lexer (strings, regexp literals after non-values). */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const push = (kind: TokKind, start: number, end: number, open = false) =>
    out.push({ kind, start, end, text: src.slice(start, end), open });
  const endsValue = () => {
    const t = out[out.length - 1];
    return (
      !!t &&
      (t.kind === "num" ||
        t.kind === "str" ||
        t.kind === "regex" ||
        t.kind === "ident" ||
        t.kind === ")" ||
        t.kind === "]")
    );
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === c) {
          closed = true;
          j++;
          break;
        } else j++;
      }
      const end = Math.min(j, src.length);
      push("str", i, end, !closed);
      i = end;
    } else if (c === "/" && !endsValue()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\n") break;
        if (d === "\\") j += 2;
        else if (d === "[") {
          inClass = true;
          j++;
        } else if (d === "]") {
          inClass = false;
          j++;
        } else if (d === "/" && !inClass) {
          closed = true;
          j++;
          while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
          break;
        } else j++;
      }
      const end = Math.min(j, src.length);
      push("regex", i, end, !closed);
      i = end;
    } else if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j]!)) j++;
      if (src[j] === "." && j + 1 < src.length && isDigit(src[j + 1]!)) {
        j++;
        while (j < src.length && isDigit(src[j]!)) j++;
      }
      push("num", i, j);
      i = j;
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentChar(src[j]!)) j++;
      push("ident", i, j);
      i = j;
    } else if (c === "(" || c === ")" || c === "[" || c === "]" || c === "," || c === ".") {
      push(c, i, i + 1);
      i++;
    } else {
      push("op", i, i + 1);
      i++;
    }
  }
  return out;
}

/** Index of the opener matching the closer at `closeIdx`, or -1. */
function matchBackward(tokens: readonly Tok[], closeIdx: number): number {
  const close = tokens[closeIdx]!.kind;
  const open = close === ")" ? "(" : "[";
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const k = tokens[i]!.kind;
    if (k === close) depth++;
    else if (k === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the first token of the postfix chain (`a.b("x")[0].c`) that ends at `endIdx`, or -1
 * when the tokens there are not a chain.
 */
function chainStart(tokens: readonly Tok[], endIdx: number): number {
  let j = endIdx;
  for (;;) {
    const t = tokens[j];
    if (!t) return -1;
    if (t.kind === "ident" || t.kind === "num" || t.kind === "str" || t.kind === "regex") {
      if (tokens[j - 1]?.kind === ".") {
        j -= 2;
        continue;
      }
      return j;
    }
    if (t.kind === ")" || t.kind === "]") {
      const open = matchBackward(tokens, j);
      if (open < 0) return -1;
      const before = tokens[open - 1];
      if (t.kind === ")") {
        if (before?.kind === "ident") {
          if (tokens[open - 2]?.kind === ".") {
            j = open - 3;
            continue;
          }
          return open - 1;
        }
        return open; // a parenthesized group
      }
      if (
        before &&
        (before.kind === "ident" ||
          before.kind === ")" ||
          before.kind === "]" ||
          before.kind === "str")
      ) {
        j = open - 1;
        continue; // an index on the chain before it
      }
      return open; // a list literal
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Context at the caret
// ---------------------------------------------------------------------------

export type CompletionContext =
  | { kind: "none" }
  /** A bare name (or nothing, when forced): namespaces, properties, functions, keywords. */
  | { kind: "global"; prefix: string; from: number; to: number }
  /** After `receiver.`. `receiverFrom` is where the receiver expression starts. */
  | {
      kind: "member";
      prefix: string;
      from: number;
      to: number;
      receiver: string;
      receiverFrom: number;
    }
  /** Inside `note["...`: property names. `to` takes in a closing quote and bracket if present. */
  | { kind: "bracket"; namespace: string; prefix: string; from: number; to: number };

/**
 * What is being completed at `caret`. With `force` (Ctrl+Space) an empty name completes too;
 * otherwise a name needs a first character or a dot before it.
 */
export function completionContext(text: string, caret: number, force = false): CompletionContext {
  const left = text.slice(0, caret);
  const tokens = tokenize(left);
  const last = tokens[tokens.length - 1];

  // Inside a string: only `ns["` property names; everywhere else a literal is not completed.
  if (last && (last.kind === "str" || last.kind === "regex") && last.open) {
    if (last.kind === "str") {
      const open = tokens[tokens.length - 2];
      const base = tokens[tokens.length - 3];
      if (
        open?.kind === "[" &&
        base?.kind === "ident" &&
        NAMESPACE_NAMES.has(base.text) &&
        base.text !== "formula" &&
        open.end === last.start
      ) {
        let to = caret;
        const q = last.text[0]!;
        if (text[to] === q) to++;
        if (text[to] === "]") to++;
        return {
          kind: "bracket",
          namespace: base.text,
          prefix: last.text.slice(1).replace(/\\(.)/g, "$1"),
          from: last.start,
          to,
        };
      }
    }
    return { kind: "none" };
  }

  let prefix = "";
  let from = caret;
  let prevIdx = tokens.length - 1;
  if (last && last.kind === "ident" && last.end === caret) {
    prefix = last.text;
    from = last.start;
    prevIdx = tokens.length - 2;
  } else if (last && last.kind === "num" && last.end === caret) {
    return { kind: "none" };
  }
  const prev = tokens[prevIdx];
  const afterDot = prev?.kind === "." && prev.end === from;

  if (afterDot) {
    const start = chainStart(tokens, prevIdx - 1);
    if (start < 0) return { kind: "none" };
    const first = tokens[start]!;
    // `1.` is the start of a decimal number, not a member access.
    if (prevIdx - 1 === start && first.kind === "num") return { kind: "none" };
    return {
      kind: "member",
      prefix,
      from,
      to: caret,
      receiver: text.slice(first.start, prev.start),
      receiverFrom: first.start,
    };
  }
  if (prefix === "" && !force) return { kind: "none" };
  return { kind: "global", prefix, from, to: caret };
}

// ---------------------------------------------------------------------------
// Type inference of the receiver
// ---------------------------------------------------------------------------

/** Properties by key, with their single expression type (`any` when the vault mixes types). */
export function propertyType(env: Pick<CompletionEnv, "properties">, name: string): ExprType {
  const p = env.properties.find((x) => x.key === name);
  if (!p) return "any";
  const types = new Set<ExprType>();
  for (const [t, count] of Object.entries(p.types)) {
    if (count <= 0) continue;
    const mapped = INDEX_TYPE[t];
    if (mapped) types.add(mapped);
    else if (t !== "null") types.add("any");
  }
  return types.size === 1 ? [...types][0]! : "any";
}

function asType(returns: string): ExprType {
  return EXPR_TYPES.has(returns) ? (returns as ExprType) : "any";
}

/** Return type of the method `name` on a `type` receiver; `any` when unknown or ambiguous. */
function methodReturns(functions: readonly BaseFunctionInfo[], type: ExprType, name: string) {
  const named = functions.filter((f) => f.kind === "method" && f.name === name);
  const exact = named.filter((f) => f.receivers.includes(type));
  const pool = exact.length > 0 ? exact : type === "any" ? named : named.filter(isAnyMethod);
  const returns = new Set(pool.map((f) => asType(f.returns)));
  return returns.size === 1 ? [...returns][0]! : "any";
}

const isAnyMethod = (f: BaseFunctionInfo) => f.receivers.includes("any");

type State = { ns: "note" | "file" | "formula" | "this" } | { type: ExprType };

const MAX_FORMULA_DEPTH = 8;

/**
 * The type of a postfix chain such as `note.due`, `file.name.lower()`, `formula.age`,
 * `list(1, 2)`. Anything that is not a plain chain (operators, groups) is `any`: completion then
 * offers every method rather than guessing.
 */
export function inferType(expr: string, env: CompletionEnv, depth = 0): ExprType {
  const tokens = tokenize(expr.trim());
  if (tokens.length === 0 || depth > MAX_FORMULA_DEPTH) return "any";
  if (chainStart(tokens, tokens.length - 1) !== 0) return "any";

  const first = tokens[0]!;
  let i = 1;
  let state: State;
  if (first.kind === "str") state = { type: first.open ? "any" : "string" };
  else if (first.kind === "num") state = { type: "number" };
  else if (first.kind === "regex") state = { type: first.open ? "any" : "regexp" };
  else if (first.kind === "[") {
    const close = findCloser(tokens, 0);
    if (close < 0) return "any";
    state = { type: "list" };
    i = close + 1;
  } else if (first.kind === "ident") {
    const text = first.text;
    if (text === "true" || text === "false") state = { type: "boolean" };
    else if (text === "null") state = { type: "any" };
    else if (tokens[1]?.kind === "(") {
      const close = findCloser(tokens, 1);
      if (close < 0) return "any";
      const fn = env.functions.find((f) => f.kind === "global" && f.name === text);
      state = { type: fn ? asType(fn.returns) : "any" };
      i = close + 1;
    } else if (NAMESPACE_NAMES.has(text)) state = { ns: text as "note" };
    else state = { type: propertyType(env, text) };
  } else return "any";

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === "[") {
      const close = findCloser(tokens, i);
      if (close < 0) return "any";
      const key = tokens[i + 1];
      if (
        "ns" in state &&
        close === i + 2 &&
        key?.kind === "str" &&
        !key.open &&
        state.ns !== "file"
      ) {
        state = stateAfterName(state, unquote(key.text), false, env, depth);
      } else state = { type: "any" };
      i = close + 1;
      continue;
    }
    if (t.kind === "." && tokens[i + 1]?.kind === "ident") {
      const name = tokens[i + 1]!.text;
      const isCall = tokens[i + 2]?.kind === "(";
      let next = i + 2;
      if (isCall) {
        const close = findCloser(tokens, i + 2);
        if (close < 0) return "any";
        next = close + 1;
      }
      state = stateAfterName(state, name, isCall, env, depth);
      i = next;
      continue;
    }
    return "any";
  }
  if ("ns" in state) return state.ns === "file" || state.ns === "this" ? "file" : "object";
  return state.type;
}

function stateAfterName(
  st: State,
  name: string,
  isCall: boolean,
  env: CompletionEnv,
  depth: number,
): State {
  if ("ns" in st) {
    switch (st.ns) {
      case "note":
        return { type: propertyType(env, name) };
      case "formula": {
        const expr = env.formulas[name];
        return { type: expr === undefined ? "any" : inferType(expr, env, depth + 1) };
      }
      case "file":
        if (isCall) return { type: methodReturns(env.functions, "file", name) };
        return { type: FILE_FIELDS.find((f) => f.name === name)?.type ?? "any" };
      case "this":
        if (isCall) return { type: methodReturns(env.functions, "file", name) };
        if (name === "file") return { type: "file" };
        if (name === "note") return { ns: "note" };
        return { type: FILE_FIELDS.find((f) => f.name === name)?.type ?? propertyType(env, name) };
    }
  }
  if (isCall) return { type: methodReturns(env.functions, st.type, name) };
  if (st.type === "file") return { type: FILE_FIELDS.find((f) => f.name === name)?.type ?? "any" };
  const field = VALUE_FIELDS[st.type]?.find((f) => f.name === name);
  return { type: field?.type ?? "any" };
}

function findCloser(tokens: readonly Tok[], openIdx: number): number {
  const open = tokens[openIdx]!.kind;
  const close = open === "(" ? ")" : "]";
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const k = tokens[i]!.kind;
    if (k === open) depth++;
    else if (k === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How well `prefix` matches `label`, lower is better, `null` when it does not match: exact,
 * exact ignoring case, prefix, prefix ignoring case, start of a word (camelCase hump or after
 * `_ - .`), substring, then letters in order.
 */
export function matchScore(prefix: string, label: string): number | null {
  if (prefix === "") return 0;
  if (label === prefix) return 0;
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (l === p) return 1;
  if (label.startsWith(prefix)) return 2;
  if (l.startsWith(p)) return 3;
  for (let i = 1; i < label.length; i++) {
    const prevChar = label[i - 1]!;
    const hump = /[a-z0-9]/.test(prevChar) && /[A-Z]/.test(label[i]!);
    if ((hump || /[_\-. ]/.test(prevChar)) && l.startsWith(p, i)) return 4;
  }
  if (l.includes(p)) return 5;
  let at = 0;
  for (const ch of l) if (ch === p[at]) at++;
  return at === p.length ? 6 : null;
}

const KIND_RANK: Record<CandidateKind, number> = {
  property: 0,
  field: 0,
  formula: 1,
  namespace: 2,
  method: 3,
  function: 3,
  keyword: 4,
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const MAX_RESULTS = 60;

interface Draft extends Omit<Candidate, "id"> {
  /** Smaller sorts first inside one match score (type-specific methods before `any` methods). */
  rank: number;
  /** Alternative text to match (`formula.age` also matches `age`). */
  alias?: string;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function groupOf(f: BaseFunctionInfo, type: ExprType): { group: string; rank: number } {
  if (f.kind === "global") return { group: "Functions", rank: 0 };
  if (f.receivers.includes("any")) return { group: "Any value", rank: 1 };
  if (f.receivers.length > 1 && type !== "any" && f.receivers.includes(type))
    return { group: `${titleCase(type)} methods`, rank: 0 };
  if (f.receivers.length > 1) return { group: "Several types", rank: 3 };
  const only = f.receivers[0]!;
  return { group: `${titleCase(only)} methods`, rank: only === type ? 0 : 2 };
}

function functionDraft(
  f: BaseFunctionInfo,
  type: ExprType,
  from: number,
  to: number,
  text: string,
): Draft {
  const { group, rank } = groupOf(f, type);
  // Editing an existing call: complete the name only.
  const hasParen = text[to] === "(";
  const insert = hasParen ? f.name : `${f.name}()`;
  return {
    label: f.name,
    kind: f.kind === "global" ? "function" : "method",
    group,
    detail: f.signature,
    doc: f.doc,
    from,
    to,
    insert,
    caret: hasParen ? insert.length : f.minArgs > 0 ? f.name.length + 1 : insert.length,
    retrigger: false,
    rank,
  };
}

function propertyDraft(
  name: string,
  types: string,
  from: number,
  to: number,
  insert: string,
): Draft {
  return {
    label: name,
    kind: "property",
    group: "Properties",
    detail: types,
    doc: "",
    from,
    to,
    insert,
    caret: insert.length,
    retrigger: false,
    rank: 0,
  };
}

function typeSummary(p: VaultProperty): string {
  const names = Object.entries(p.types)
    .filter(([, n]) => n > 0)
    .map(([t]) => t);
  return names.length > 0 ? names.join(" | ") : "property";
}

function fieldDrafts(fields: readonly FieldDef[], from: number, to: number): Draft[] {
  return fields.map((f) => ({
    label: f.name,
    kind: "field" as const,
    group: "Fields",
    detail: f.type,
    doc: f.doc,
    from,
    to,
    insert: f.name,
    caret: f.name.length,
    retrigger: false,
    rank: 0,
  }));
}

function methodDrafts(
  env: CompletionEnv,
  type: ExprType,
  from: number,
  to: number,
  text: string,
): Draft[] {
  return env.functions
    .filter((f) => f.kind === "method")
    .filter((f) => type === "any" || f.receivers.includes(type) || isAnyMethod(f))
    .map((f) => functionDraft(f, type, from, to, text));
}

/** `formula.<name>` entries; `receiverFrom` is set after `formula.` (a bracket form replaces it). */
function formulaDrafts(
  env: CompletionEnv,
  from: number,
  to: number,
  where: { member: false } | { member: true; receiverFrom: number },
): Draft[] {
  return Object.keys(env.formulas).map((name) => {
    const bare = IDENT.test(name);
    const insert = where.member
      ? bare
        ? name
        : `formula[${quote(name)}]`
      : bare
        ? `formula.${name}`
        : `formula[${quote(name)}]`;
    return {
      label: where.member || !bare ? name : `formula.${name}`,
      alias: where.member ? undefined : name,
      kind: "formula" as const,
      group: "Formulas",
      detail: inferType(env.formulas[name]!, env),
      doc: env.formulas[name]!,
      from: where.member && !bare ? where.receiverFrom : from,
      to,
      insert,
      caret: insert.length,
      retrigger: false,
      rank: 0,
    };
  });
}

function drafts(
  ctx: Exclude<CompletionContext, { kind: "none" }>,
  env: CompletionEnv,
  text: string,
) {
  const out: Draft[] = [];
  if (ctx.kind === "bracket") {
    for (const p of env.properties) {
      out.push(propertyDraft(p.key, typeSummary(p), ctx.from, ctx.to, `${quote(p.key)}]`));
    }
    return out;
  }
  if (ctx.kind === "member") {
    const recv = ctx.receiver.trim();
    const { from, to } = ctx;
    if (recv === "note") {
      for (const p of env.properties) {
        const insert = isBareIdentifier(p.key) ? p.key : `note[${quote(p.key)}]`;
        out.push(
          propertyDraft(
            p.key,
            typeSummary(p),
            insert.startsWith("note[") ? ctx.receiverFrom : from,
            to,
            insert,
          ),
        );
      }
      return out;
    }
    if (recv === "formula") {
      return formulaDrafts(env, from, to, { member: true, receiverFrom: ctx.receiverFrom });
    }
    if (recv === "file") {
      return [...fieldDrafts(FILE_FIELDS, from, to), ...methodDrafts(env, "file", from, to, text)];
    }
    if (recv === "this") {
      for (const ns of ["file", "note"] as const)
        out.push({
          label: ns,
          kind: "namespace",
          group: "Namespaces",
          detail: ns === "file" ? "file" : "object",
          doc: NAMESPACES.find((n) => n.name === ns)!.doc,
          from,
          to,
          insert: `${ns}.`,
          caret: ns.length + 1,
          retrigger: true,
          rank: 0,
        });
      out.push(...fieldDrafts(FILE_FIELDS, from, to), ...methodDrafts(env, "file", from, to, text));
      for (const p of env.properties) {
        if (isBareIdentifier(p.key))
          out.push(propertyDraft(p.key, typeSummary(p), from, to, p.key));
      }
      return out;
    }
    const type = inferType(ctx.receiver, env);
    out.push(...fieldDrafts(VALUE_FIELDS[type] ?? [], from, to));
    if (type === "file") out.push(...fieldDrafts(FILE_FIELDS, from, to));
    out.push(...methodDrafts(env, type, from, to, text));
    return out;
  }
  // global
  const { from, to } = ctx;
  for (const ns of NAMESPACES) {
    out.push({
      label: ns.name,
      kind: "namespace",
      group: "Namespaces",
      detail: ns.name === "file" || ns.name === "this" ? "file" : "object",
      doc: ns.doc,
      from,
      to,
      insert: `${ns.name}.`,
      caret: ns.name.length + 1,
      retrigger: true,
      rank: 0,
    });
  }
  for (const p of env.properties) {
    out.push(
      propertyDraft(
        p.key,
        typeSummary(p),
        from,
        to,
        isBareIdentifier(p.key) ? p.key : `note[${quote(p.key)}]`,
      ),
    );
  }
  out.push(...formulaDrafts(env, from, to, { member: false }));
  for (const f of env.functions)
    if (f.kind === "global") out.push(functionDraft(f, "any", from, to, text));
  for (const k of KEYWORDS)
    out.push({
      label: k.name,
      kind: "keyword",
      group: "Keywords",
      detail: k.detail,
      doc: "",
      from,
      to,
      insert: k.name,
      caret: k.name.length,
      retrigger: false,
      rank: 0,
    });
  return out;
}

export interface CompletionResult {
  context: CompletionContext;
  candidates: Candidate[];
}

/**
 * Ranked candidates for the caret, deduplicated by what they insert and capped. Candidates are
 * sorted by match quality, then by group relevance (methods of the receiver's own type before
 * `any` methods before the rest), then by kind, then alphabetically; the list is returned grouped
 * in that order.
 */
export function complete(
  text: string,
  caret: number,
  env: CompletionEnv,
  options: { force?: boolean; limit?: number } = {},
): CompletionResult {
  const context = completionContext(text, caret, options.force);
  if (context.kind === "none") return { context, candidates: [] };
  const prefix = context.prefix;
  const scored: { d: Draft; score: number }[] = [];
  const seen = new Set<string>();
  for (const d of drafts(context, env, text)) {
    const key = `${d.group}|${d.kind}|${d.label}|${d.insert}|${d.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let score = matchScore(prefix, d.label);
    if (d.alias !== undefined) {
      const alt = matchScore(prefix, d.alias);
      if (alt !== null) score = score === null ? alt + 1 : Math.min(score, alt + 1);
    }
    if (score !== null) scored.push({ d, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.d.rank - b.d.rank ||
      KIND_RANK[a.d.kind] - KIND_RANK[b.d.kind] ||
      a.d.label.localeCompare(b.d.label) ||
      a.d.detail.localeCompare(b.d.detail),
  );
  const top = scored.slice(0, options.limit ?? MAX_RESULTS).map((s) => s.d);
  // Keep the sorted order but gather each group at the position of its best candidate.
  const order: string[] = [];
  for (const d of top) if (!order.includes(d.group)) order.push(d.group);
  const grouped = order.flatMap((g) => top.filter((d) => d.group === g));
  const candidates = grouped.map(({ rank: _rank, alias: _alias, ...c }, i): Candidate => ({
    ...c,
    id: `c${i}`,
  }));
  return { context, candidates };
}

/** `text` with `candidate` applied, and where the caret goes. */
export function applyCandidate(text: string, c: Candidate): { text: string; caret: number } {
  return {
    text: text.slice(0, c.from) + c.insert + text.slice(c.to),
    caret: c.from + c.caret,
  };
}

// ---------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------

export interface SignatureHelp {
  signature: string;
  doc: string;
  /** The signature split so the current argument can be emphasized. */
  segments: { text: string; active: boolean }[];
  /** Index of the argument being typed (clamped to the last, for variadic functions). */
  activeParam: number;
}

interface CallFrame {
  kind: "(" | "[";
  /** Index of the opening token. */
  at: number;
  callee: string | null;
  arg: number;
}

/** The innermost call enclosing the caret: the function name, its receiver text, the argument. */
export function callAt(
  text: string,
  caret: number,
): { name: string; receiver: string | null; argIndex: number } | null {
  const tokens = tokenize(text.slice(0, caret));
  const stack: CallFrame[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "(" || t.kind === "[") {
      const before = tokens[i - 1];
      stack.push({
        kind: t.kind,
        at: i,
        callee: t.kind === "(" && before?.kind === "ident" ? before.text : null,
        arg: 0,
      });
    } else if (t.kind === ")" || t.kind === "]") {
      if (stack.length > 0 && stack[stack.length - 1]!.kind === (t.kind === ")" ? "(" : "[")) {
        stack.pop();
      }
    } else if (t.kind === ",") {
      const top = stack[stack.length - 1];
      if (top) top.arg++;
    }
  });
  for (let k = stack.length - 1; k >= 0; k--) {
    const frame = stack[k]!;
    if (frame.kind !== "(" || frame.callee === null) {
      if (frame.kind === "[") return null; // inside a list literal or index: not a call
      continue; // a parenthesized group inside a call: keep looking outward
    }
    const nameIdx = frame.at - 1;
    let receiver: string | null = null;
    if (tokens[nameIdx - 1]?.kind === ".") {
      const start = chainStart(tokens, nameIdx - 2);
      if (start >= 0) receiver = text.slice(tokens[start]!.start, tokens[nameIdx - 1]!.start);
    }
    return { name: frame.callee, receiver, argIndex: frame.arg };
  }
  return null;
}

/** The parameter texts of a signature: `string.slice(start, end?): string` gives `start`, `end?`. */
export function signatureParams(signature: string): { text: string; from: number }[] {
  const open = signature.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === "(") depth++;
    else if (signature[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];
  const out: { text: string; from: number }[] = [];
  let from = open + 1;
  let level = 0;
  for (let i = open + 1; i <= close; i++) {
    const c = signature[i]!;
    if (c === "(" || c === "[") level++;
    else if (c === ")" || c === "]") level--;
    if ((c === "," && level === 0) || i === close) {
      const raw = signature.slice(from, i);
      const text = raw.trim();
      if (text !== "") out.push({ text, from: from + raw.indexOf(text) });
      from = i + 1;
    }
  }
  return out;
}

/** Signature help for the call around the caret, or `null` when there is none to show. */
export function signatureHelp(
  text: string,
  caret: number,
  env: CompletionEnv,
): SignatureHelp | null {
  const call = callAt(text, caret);
  if (!call) return null;
  let candidates: BaseFunctionInfo[];
  if (call.receiver === null) {
    candidates = env.functions.filter((f) => f.kind === "global" && f.name === call.name);
  } else {
    const type = inferType(call.receiver, env);
    const named = env.functions.filter((f) => f.kind === "method" && f.name === call.name);
    const exact = named.filter((f) => type !== "any" && f.receivers.includes(type));
    candidates = exact.length > 0 ? exact : named.filter((f) => type === "any" || isAnyMethod(f));
  }
  if (candidates.length === 0) return null;
  // Of several overloads prefer one that can take this many arguments.
  const fn =
    candidates.find(
      (f) => call.argIndex + 1 >= f.minArgs && (f.maxArgs === null || call.argIndex < f.maxArgs),
    ) ?? candidates[0]!;
  const params = signatureParams(fn.signature);
  const variadicAt = params.findIndex((p) => p.text.startsWith("..."));
  const active =
    params.length === 0
      ? -1
      : variadicAt >= 0 && call.argIndex >= variadicAt
        ? variadicAt
        : Math.min(call.argIndex, params.length - 1);
  const segments: SignatureHelp["segments"] = [];
  let pos = 0;
  params.forEach((p, i) => {
    if (p.from > pos) segments.push({ text: fn.signature.slice(pos, p.from), active: false });
    segments.push({ text: p.text, active: i === active });
    pos = p.from + p.text.length;
  });
  if (pos < fn.signature.length) segments.push({ text: fn.signature.slice(pos), active: false });
  return { signature: fn.signature, doc: fn.doc, segments, activeParam: active };
}
