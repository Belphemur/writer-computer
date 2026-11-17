// The query syntax of the graph's search, filters and color rules ("the same syntax as Search in
// notes", SPECs/graph-view-spec.md 3.3 and 3.4): words, `path:`, `tag:` and `[property:value]`,
// all of which must match. Pure; the frontmatter is passed in when a term needs it.

export type Term =
  | { kind: "word"; value: string }
  | { kind: "path"; value: string }
  | { kind: "tag"; value: string }
  /** `[name]` (value `null`) or `[name:value]`. */
  | { kind: "prop"; name: string; value: string | null };

export type Query = readonly Term[];

/** What a note is to a query: its index facts; `props` is its frontmatter (when loaded). */
export interface Matchable {
  path: string;
  name: string;
  tags: readonly string[];
  props?: Readonly<Record<string, unknown>>;
}

const TOKEN = /\[[^\]]*\]|[^\s"]+:"[^"]*"|"[^"]*"|\S+/g;

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

export function parseQuery(text: string): Query {
  const terms: Term[] = [];
  for (const raw of text.match(TOKEN) ?? []) {
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const body = raw.slice(1, -1).trim();
      const i = body.indexOf(":");
      if (i === -1) {
        if (body) terms.push({ kind: "prop", name: body.toLowerCase(), value: null });
      } else {
        const name = body.slice(0, i).trim().toLowerCase();
        const value = unquote(body.slice(i + 1).trim());
        if (name) terms.push({ kind: "prop", name, value: value === "" ? null : value });
      }
      continue;
    }
    const lower = raw.toLowerCase();
    const prefix = lower.startsWith("path:") ? "path" : lower.startsWith("tag:") ? "tag" : null;
    if (prefix) {
      const value = unquote(raw.slice(prefix.length + 1));
      if (value) terms.push({ kind: prefix, value: value.replace(/^#/, "") });
      continue;
    }
    const value = unquote(raw);
    if (value) terms.push({ kind: "word", value });
  }
  return terms;
}

/** Does a term need the note's frontmatter (so the caller must load it)? */
export const needsProps = (q: Query) => q.some((t) => t.kind === "prop");

const lower = (s: string) => s.toLowerCase();

/** A tag matches itself and its nested children (`tag:work` finds `work/plans`). */
function tagMatches(tags: readonly string[], wanted: string): boolean {
  const w = lower(wanted);
  return tags.some((t) => {
    const l = lower(t.replace(/^#/, ""));
    return l === w || l.startsWith(`${w}/`);
  });
}

/** The text of a property value: a list is flattened, a wiki link is its target name. Shared by
 *  the search terms and Group by (`groups.ts`). */
export function valuesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(valuesOf);
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return [];
  const s = String(v).trim();
  const m = /^\[\[([^\]|#]+)/.exec(s);
  const text = (m ? m[1]! : s).trim();
  return text ? [text] : [];
}

function propMatches(props: Matchable["props"], name: string, wanted: string | null): boolean {
  if (!props) return false;
  const key = Object.keys(props).find((k) => lower(k) === name);
  if (key === undefined) return false;
  const values = valuesOf(props[key]);
  if (wanted === null) return values.length > 0 || props[key] === "";
  const w = lower(wanted);
  return values.some((v) => lower(v) === w);
}

export function matchesTerm(t: Term, n: Matchable): boolean {
  switch (t.kind) {
    case "word":
      return lower(n.name).includes(lower(t.value)) || lower(n.path).includes(lower(t.value));
    case "path":
      return lower(n.path).includes(lower(t.value));
    case "tag":
      return tagMatches(n.tags, t.value);
    case "prop":
      return propMatches(n.props, t.name, t.value);
  }
}

/** An empty query matches everything. */
export function matches(q: Query, n: Matchable): boolean {
  return q.every((t) => matchesTerm(t, n));
}
