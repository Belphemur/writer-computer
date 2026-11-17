// Converting one note's value when its property's type changes. Pure text in, text out, through
// the same verified splices as every other panel edit (`frontmatter-properties.ts`), so comments,
// key order and CRLF stay and the caller applies the result as ONE frontmatter update (one undo
// step). A value that cannot be converted safely is never changed: the result is a refusal and the
// caller keeps the text (the row then shows its "does not fit" state).
//
// | from \ to   | text          | list (multitext/tags/aliases) | number        | checkbox          | date              | date & time        |
// | text / url  | -             | split on commas (not in [[ ]])| if parseable  | true/false/yes/no | common formats    | common formats     |
// | link        | -             | one item                      | refused       | refused           | refused           | refused            |
// | number      | its digits    | one item                      | -             | refused           | refused           | refused            |
// | checkbox    | true / false  | one item                      | refused       | -                 | refused           | refused            |
// | date        | -             | one item                      | refused       | refused           | -                 | `T00:00` appended  |
// | date & time | -             | one item                      | refused       | refused           | time dropped      | -                  |
// | list        | joined ", "   | -                             | refused       | refused           | refused           | refused            |
// | empty       | unchanged     | `[]`                          | unchanged     | unchanged         | unchanged         | unchanged          |
//
// Relationships (a link or a list of links; the single or list shape of the value is kept):
// | from \ to   | relationships                                                                     |
// | text / url  | one `[[x]]` stays a single link; `[[a]], [[b]]` splits into a list; plain text    |
// |             | only when it resolves by file name (`linkNames`), else "Not a link"               |
// | list        | every item must be (or resolve to) a link, else "Not a link"; stays a list        |
// | link        | unchanged (single)                                                                |
// | number, checkbox, date, date & time | refused ("Not a link")                                    |
// | empty       | unchanged                                                                         |
// And from it: relationships -> text joins a list with ", " (a single link is already text);
// relationships -> list keeps the items as quoted link strings (a single link becomes one item).
import {
  isWikilink,
  setList,
  setScalar,
  type EditResult,
  type PropertyKind,
  type PropertyRow,
} from "./frontmatter-properties";
import { PROPERTY_TYPES, rowFitsType, type PropertyType } from "./property-types";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(y: number, m: number, d: number): string | null {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
    return null;
  return `${String(y).padStart(4, "0")}-${two(m)}-${two(d)}`;
}

function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
  return i < 0 ? null : i + 1;
}

/** `YYYY-MM-DD` from the unambiguous common spellings, else null. `3/4/2026` is refused (day or
 *  month first?) unless one part is above 12. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 12 && b <= 12) return validDate(y, b, a);
    if (b > 12 && a <= 12) return validDate(y, a, b);
    return null;
  }
  m = /^([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthNumber(m[1]);
    return month === null ? null : validDate(Number(m[3]), month, Number(m[2]));
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthNumber(m[2]);
    return month === null ? null : validDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

/** `YYYY-MM-DDTHH:mm` from an ISO-like date and time (seconds dropped); a date alone gets midnight. */
export function parseDatetime(input: string): string | null {
  const s = input.trim();
  const m = /^(.*?)[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) {
    const date = parseDate(s);
    return date === null ? null : `${date}T00:00`;
  }
  const date = parseDate(m[1]);
  const [h, min] = [Number(m[2]), Number(m[3])];
  if (date === null || h > 23 || min > 59) return null;
  return `${date}T${two(h)}:${two(min)}`;
}

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

function parseBoolean(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  return null;
}

/** Split on commas that are not inside `[[ ]]`; trims and drops empty parts. */
export function splitList(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < input.length; i++) {
    const two = input.slice(i, i + 2);
    if (two === "[[") {
      depth++;
      cur += two;
      i++;
    } else if (two === "]]" && depth > 0) {
      depth--;
      cur += two;
      i++;
    } else if (input[i] === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += input[i];
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const LIST_KINDS: readonly PropertyKind[] = ["list", "tags", "tagString"];
const SCALAR_KINDS: readonly PropertyKind[] = [
  "text",
  "url",
  "link",
  "number",
  "checkbox",
  "date",
  "datetime",
];

function refuse(error: string): EditResult {
  return { ok: false, error };
}

/** The scalar value of a row as the text a list item or text value would carry. */
function scalarText(row: PropertyRow): string {
  return row.value === null ? "" : String(row.value);
}

function listItems(row: PropertyRow, tags: boolean): string[] {
  if (LIST_KINDS.includes(row.kind)) return row.items;
  const text = scalarText(row);
  if (row.kind === "link") return [text];
  if (row.kind === "text" || row.kind === "url") {
    const items = splitList(text);
    return tags ? items.map((i) => i.replace(/^#/, "")) : items;
  }
  return text === "" ? [] : [text];
}

/** The items of a text or list value that are not wikilinks: what converting to relationships
 *  must resolve by file name first (see `resolveLinkNames`). */
export function plainLinkCandidates(row: PropertyRow): string[] {
  if (row.kind === "text" || row.kind === "url") return splitList(scalarText(row)).filter(plain);
  if (LIST_KINDS.includes(row.kind)) return row.items.filter(plain);
  return [];
}

function plain(item: string): boolean {
  return !isWikilink(item);
}

/** The relationships value of a text or list row: its items as `[[links]]`. Plain items take the
 *  link text `linkNames` gives them (the file name), else the conversion is refused. */
function toLinks(row: PropertyRow, linkNames: Readonly<Record<string, string>>): string[] | null {
  const items = LIST_KINDS.includes(row.kind) ? row.items : splitList(scalarText(row));
  const out: string[] = [];
  for (const item of items) {
    if (isWikilink(item)) out.push(item.trim());
    else if (linkNames[item]) out.push(`[[${linkNames[item]}]]`);
    else return null;
  }
  return out;
}

/** Convert the row's value in `text` for a property now typed `to`. Returns the (possibly
 *  unchanged) text, or a refusal that leaves the value as it is. `linkNames` maps a plain item to
 *  the file name it resolves to (only used for `relationships`). */
export function convertProperty(
  text: string,
  row: PropertyRow,
  to: PropertyType,
  linkNames: Readonly<Record<string, string>> = {},
): EditResult {
  const toList = to === "multitext" || to === "tags" || to === "aliases";
  if (row.kind === "empty") return toList ? setList(text, row.key, []) : { ok: true, text };
  if (!row.editable || !(SCALAR_KINDS.includes(row.kind) || LIST_KINDS.includes(row.kind)))
    return refuse("This value cannot be converted here; edit it in Source.");
  if (rowFitsType(row, to) && row.kind !== "tagString") return { ok: true, text };
  const key = row.key;
  const isList = LIST_KINDS.includes(row.kind);
  const raw = scalarText(row);

  switch (to) {
    case "relationships": {
      const refusal = refuse(PROPERTY_TYPES.relationships.warning);
      if (!(isList || row.kind === "text" || row.kind === "url")) return refusal;
      const links = toLinks(row, linkNames);
      if (links === null || links.length === 0) return refusal;
      // a text value stays a single link when it is one; a list stays a list
      return !isList && links.length === 1
        ? setScalar(text, key, links[0], true)
        : setList(text, key, links);
    }
    case "text":
      if (isList) {
        const joined = row.items.join(", ");
        return setScalar(text, key, joined === "" ? null : joined);
      }
      return setScalar(text, key, raw === "" ? null : raw);
    case "multitext":
    case "tags":
    case "aliases":
      if (row.kind === "tagString") return setList(text, key, row.items);
      return setList(text, key, listItems(row, to === "tags"));
    case "number": {
      if (row.kind !== "text" && row.kind !== "url") return refuse(PROPERTY_TYPES.number.warning);
      const t = raw.trim();
      if (!NUMBER_RE.test(t)) return refuse(PROPERTY_TYPES.number.warning);
      return setScalar(text, key, Number(t));
    }
    case "checkbox": {
      const b = row.kind === "text" ? parseBoolean(raw) : null;
      return b === null ? refuse(PROPERTY_TYPES.checkbox.warning) : setScalar(text, key, b);
    }
    case "date": {
      if (row.kind !== "text" && row.kind !== "datetime")
        return refuse(PROPERTY_TYPES.date.warning);
      const d = parseDate(raw);
      return d === null ? refuse(PROPERTY_TYPES.date.warning) : setScalar(text, key, d, true);
    }
    case "datetime": {
      if (row.kind !== "text" && row.kind !== "date")
        return refuse(PROPERTY_TYPES.datetime.warning);
      const d = parseDatetime(raw);
      return d === null ? refuse(PROPERTY_TYPES.datetime.warning) : setScalar(text, key, d, true);
    }
  }
}
