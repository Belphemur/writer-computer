// The simple filter builder: rows of `property operator value` that compile to the documented
// expression strings, and the inverse for rows the builder wrote itself. A leaf that does not
// round-trip through `parseRow` is an "advanced" leaf: shown and edited as a raw expression.
// Groups are `and` / `or` / `not` at one level; a nested group is kept verbatim.
import type { BaseFilter } from "./types";

export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface FilterRow {
  /** Property id as written in a `.base` (`status`, `note.status`, `file.name`, `formula.age`). */
  property: string;
  operator: FilterOperator;
  /** Raw text from the input; empty for operators without a value. */
  value: string;
}

interface OperatorDef {
  id: FilterOperator;
  label: string;
  needsValue: boolean;
  compile: (prop: string, literal: string) => string;
}

const COMPARE = (op: string) => (p: string, l: string) => `${p} ${op} ${l}`;
const METHOD =
  (name: string, negate = false) =>
  (p: string, l: string) =>
    `${negate ? "!" : ""}${p}.${name}(${l})`;

/** The operator registry: one row per operator, labels and compilation together. */
export const FILTER_OPERATORS: readonly OperatorDef[] = [
  { id: "is", label: "is", needsValue: true, compile: COMPARE("==") },
  { id: "isNot", label: "is not", needsValue: true, compile: COMPARE("!=") },
  { id: "contains", label: "contains", needsValue: true, compile: METHOD("contains") },
  {
    id: "notContains",
    label: "does not contain",
    needsValue: true,
    compile: METHOD("contains", true),
  },
  { id: "startsWith", label: "starts with", needsValue: true, compile: METHOD("startsWith") },
  { id: "endsWith", label: "ends with", needsValue: true, compile: METHOD("endsWith") },
  { id: "isEmpty", label: "is empty", needsValue: false, compile: (p) => `${p}.isEmpty()` },
  {
    id: "isNotEmpty",
    label: "is not empty",
    needsValue: false,
    compile: (p) => `!${p}.isEmpty()`,
  },
  { id: "gt", label: ">", needsValue: true, compile: COMPARE(">") },
  { id: "gte", label: ">=", needsValue: true, compile: COMPARE(">=") },
  { id: "lt", label: "<", needsValue: true, compile: COMPARE("<") },
  { id: "lte", label: "<=", needsValue: true, compile: COMPARE("<=") },
];

const OPERATOR_BY_ID = new Map(FILTER_OPERATORS.map((o) => [o.id, o]));
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

/** Expression for a property id: bare name, `file.x`, `formula.x`, or `note["a b"]`. */
export function propertyExpression(id: string): string {
  if (id.startsWith("file.") || id.startsWith("formula.")) {
    const dot = id.indexOf(".");
    const ns = id.slice(0, dot);
    const name = id.slice(dot + 1);
    return IDENT.test(name) ? id : `${ns}[${JSON.stringify(name)}]`;
  }
  const name = id.startsWith("note.") ? id.slice(5) : id;
  return IDENT.test(name) ? name : `note[${JSON.stringify(name)}]`;
}

/**
 * Literal for the text a user typed. Equality takes numbers and `true`/`false` as such (a text
 * property that holds the digits `2024` is compared as text through "contains"); ordering
 * operators take numbers and ISO dates (`date("...")`); everything else is a quoted string.
 */
export function literal(operator: FilterOperator, text: string): string {
  const ordering =
    operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte";
  const equality = operator === "is" || operator === "isNot";
  if ((equality || ordering) && NUMBER.test(text)) return text;
  if (equality && (text === "true" || text === "false")) return text;
  if (ordering && ISO_DATE.test(text)) return `date(${JSON.stringify(text)})`;
  return JSON.stringify(text);
}

/** The documented expression string of a row. */
export function compileRow(row: FilterRow): string {
  const def = OPERATOR_BY_ID.get(row.operator);
  if (!def) throw new Error(`Unknown filter operator: ${row.operator}`);
  return def.compile(
    propertyExpression(row.property),
    def.needsValue ? literal(row.operator, row.value) : "",
  );
}

const PROP = String.raw`(?:(?:file|formula)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\["(?:[^"\\]|\\.)*"\])|note\["(?:[^"\\]|\\.)*"\]|[A-Za-z_$][A-Za-z0-9_$]*)`;
const LIT = String.raw`(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|date\("(?:[^"\\]|\\.)*"\))`;
const METHOD_RE = new RegExp(`^(!?)(${PROP})\\.(contains|startsWith|endsWith)\\((${LIT})\\)$`);
const EMPTY_RE = new RegExp(`^(!?)(${PROP})\\.isEmpty\\(\\)$`);
const COMPARE_RE = new RegExp(`^(${PROP})\\s*(==|!=|>=|<=|>|<)\\s*(${LIT})$`);
const COMPARE_OPS: Record<string, FilterOperator> = {
  "==": "is",
  "!=": "isNot",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

function propertyId(expr: string): string {
  const m = /^(file|formula|note)\[("(?:[^"\\]|\\.)*")\]$/.exec(expr);
  if (!m) return expr;
  const name = JSON.parse(m[2]!) as string;
  return m[1] === "note" ? name : `${m[1]}.${name}`;
}

function literalText(lit: string): string {
  if (lit.startsWith("date(")) return JSON.parse(lit.slice(5, -1)) as string;
  if (lit.startsWith('"')) return JSON.parse(lit) as string;
  return lit;
}

/**
 * The row an expression was compiled from, or `null` for anything else (the leaf is then edited as
 * raw text). The result is only returned when it compiles back to exactly `expression`.
 */
export function parseRow(expression: string): FilterRow | null {
  const text = expression.trim();
  let row: FilterRow | null = null;
  let m = METHOD_RE.exec(text);
  if (m) {
    const op: FilterOperator =
      m[3] === "contains" ? (m[1] ? "notContains" : "contains") : (m[3] as FilterOperator);
    if (m[1] && m[3] !== "contains") return null;
    row = { property: propertyId(m[2]!), operator: op, value: literalText(m[4]!) };
  } else if ((m = EMPTY_RE.exec(text))) {
    row = { property: propertyId(m[2]!), operator: m[1] ? "isNotEmpty" : "isEmpty", value: "" };
  } else if ((m = COMPARE_RE.exec(text))) {
    row = { property: propertyId(m[1]!), operator: COMPARE_OPS[m[2]!]!, value: literalText(m[3]!) };
  }
  if (!row) return null;
  try {
    return compileRow(row) === text ? row : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Group model
// ---------------------------------------------------------------------------

export type FilterMode = "and" | "or" | "not";

/** One level of a filter: how its items combine and the items (leaf strings or kept groups). */
export interface FilterModel {
  mode: FilterMode;
  items: BaseFilter[];
}

export const FILTER_MODE_LABELS: Record<FilterMode, string> = {
  and: "All of the following are true",
  or: "Any of the following is true",
  not: "None of the following are true",
};

export function modelOf(filter: BaseFilter | null): FilterModel {
  if (filter === null) return { mode: "and", items: [] };
  if (typeof filter === "string") return { mode: "and", items: [filter] };
  if ("and" in filter) return { mode: "and", items: filter.and };
  if ("or" in filter) return { mode: "or", items: filter.or };
  return { mode: "not", items: filter.not };
}

/** The filter to write; no items means no filter. */
export function filterOf(model: FilterModel): BaseFilter | null {
  if (model.items.length === 0) return null;
  if (model.mode === "and") return { and: model.items };
  if (model.mode === "or") return { or: model.items };
  return { not: model.items };
}

export function isLeaf(item: BaseFilter): item is string {
  return typeof item === "string";
}

/**
 * A `.base` that holds `text` as its only filter, for validating an expression through
 * `base_query_text`. The caller runs it and shows `result.error` inline.
 */
export function validationBase(expression: string): string {
  return `filters: ${JSON.stringify(expression)}\nviews:\n  - type: table\n    name: Check\n    limit: 1\n`;
}
