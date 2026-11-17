// Pure helpers for table cells: which editor a cell gets, how text maps to a
// property value (and back), and why a cell may be read-only. No React, no IPC.
import { isWikiLink, parseWikiLinkValue } from "@/lib/wiki-links";
import type { Cell, CellValue, Column, PropertyJson, PropertyValueType, Row } from "./types";

// ---------------------------------------------------------------------------
// Property ids
// ---------------------------------------------------------------------------

export type PropertyNamespace = "note" | "file" | "formula";

/** Namespace of a canonical column key (`Column.key`; a bare key is a note property). */
export function propertyNamespace(key: string): PropertyNamespace {
  if (key.startsWith("file.")) return "file";
  if (key.startsWith("formula.")) return "formula";
  return "note";
}

/** The frontmatter key behind a note column (`note.` is already dropped in `Column.key`). */
export function notePropertyName(key: string): string {
  return key;
}

/** Canonical key of a property id as written in a `.base` (`note.x` and `x` are the same). */
export function canonicalPropertyKey(id: string): string {
  return id.startsWith("note.") ? id.slice("note.".length) : id;
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/** The editor a cell gets. A link is a text value written as `[[...]]`. */
export type EditKind = PropertyValueType | "link";

/** The `valueType` hint the backend understands for an editor kind. */
export function toWireType(kind: EditKind | undefined): PropertyValueType | undefined {
  return kind === "link" ? "text" : kind;
}

export const READ_ONLY_REASONS = {
  formula: "Formula columns are computed and cannot be edited",
  file: "File properties cannot be edited here",
  error: "This cell holds an error and cannot be edited",
  object: "Nested values cannot be edited in the table",
  unsupported: "This value type cannot be edited in the table",
  complexList: "Lists with nested or non-text items cannot be edited in the table",
  frontmatter: "This note's frontmatter cannot be parsed, so its properties are read-only",
  unsaved: "This note is open in an editor tab with unsaved changes; save or close it first",
} as const;

export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[keyof typeof READ_ONLY_REASONS];

/** Why a whole column cannot be edited, or `null` for a note-property column. */
export function columnReadOnlyReason(column: Column): ReadOnlyReason | null {
  const ns = propertyNamespace(column.key);
  if (ns === "formula") return READ_ONLY_REASONS.formula;
  if (ns === "file") return READ_ONLY_REASONS.file;
  return null;
}

function isTextItem(item: CellValue): boolean {
  return item.type === "string" || item.type === "link";
}

export type CellClassification =
  | { editable: true; kind: EditKind }
  /** A null cell: any scalar kind fits; the column decides. */
  | { editable: true; kind: null }
  | { editable: false; reason: ReadOnlyReason };

/** Which editor a cell value needs, from its tagged type alone. */
export function classifyValue(value: CellValue): CellClassification {
  switch (value.type) {
    case "null":
      return { editable: true, kind: null };
    case "boolean":
      return { editable: true, kind: "checkbox" };
    case "number":
      return { editable: true, kind: "number" };
    case "string":
      return { editable: true, kind: "text" };
    case "date":
      return { editable: true, kind: value.hasTime ? "datetime" : "date" };
    case "link":
      return { editable: true, kind: "link" };
    case "list":
      return value.value.every(isTextItem)
        ? { editable: true, kind: "list" }
        : { editable: false, reason: READ_ONLY_REASONS.complexList };
    case "error":
      return { editable: false, reason: READ_ONLY_REASONS.error };
    case "object":
      return { editable: false, reason: READ_ONLY_REASONS.object };
    default:
      return { editable: false, reason: READ_ONLY_REASONS.unsupported };
  }
}

const columnKindCache = new WeakMap<readonly Row[], Map<number, EditKind>>();

/** The most common editable kind among a column's non-null cells (`text` for an empty column). */
export function inferColumnKind(rows: readonly Row[], columnIndex: number): EditKind {
  let perColumn = columnKindCache.get(rows);
  if (!perColumn) {
    perColumn = new Map();
    columnKindCache.set(rows, perColumn);
  }
  const cached = perColumn.get(columnIndex);
  if (cached) return cached;
  const counts = new Map<EditKind, number>();
  for (const row of rows) {
    const cell = row.cells[columnIndex];
    if (!cell) continue;
    const c = classifyValue(cell);
    if (c.editable && c.kind) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  let best: EditKind = "text";
  let bestCount = 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  perColumn.set(columnIndex, best);
  return best;
}

export type EditTarget =
  | { editable: true; kind: EditKind }
  | { editable: false; reason: ReadOnlyReason };

/** Full edit decision for one cell: column namespace first, then the value, then the column majority for null cells. */
export function editTargetFor(
  column: Column,
  cell: Cell,
  rows: readonly Row[],
  columnIndex: number,
): EditTarget {
  const columnReason = columnReadOnlyReason(column);
  if (columnReason) return { editable: false, reason: columnReason };
  const c = classifyValue(cell);
  if (!c.editable) return c;
  return { editable: true, kind: c.kind ?? inferColumnKind(rows, columnIndex) };
}

// ---------------------------------------------------------------------------
// Text <-> property value
// ---------------------------------------------------------------------------

/** Text shown in a copied TSV cell: what the table displays. */
export function cellCopyText(cell: Cell): string {
  return cell.display;
}

export type ParsedCellText =
  | { ok: true; clear: true }
  | { ok: true; clear: false; value: PropertyJson; valueType: EditKind }
  | { ok: false; error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function validCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Split the text of a list cell into items: comma separated, trimmed, empty items dropped. */
export function parseListText(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `[[x]]` as-is, anything else wrapped so the backend writes a link. */
export function toWikiLinkText(text: string): string {
  const t = text.trim();
  return isWikiLink(t) ? t : `[[${t}]]`;
}

/**
 * Parse pasted or typed text for a column of `kind`. Empty text means "clear the
 * cell". Invalid text is an error, never coerced.
 */
export function parseCellText(kind: EditKind, text: string): ParsedCellText {
  const t = text.trim();
  if (t === "") return { ok: true, clear: true };
  switch (kind) {
    case "text":
      return { ok: true, clear: false, value: text, valueType: "text" };
    case "number": {
      const n = Number(t);
      if (!Number.isFinite(n)) return { ok: false, error: `"${t}" is not a number` };
      return { ok: true, clear: false, value: n, valueType: "number" };
    }
    case "checkbox": {
      const lower = t.toLowerCase();
      if (["true", "yes", "1", "checked"].includes(lower))
        return { ok: true, clear: false, value: true, valueType: "checkbox" };
      if (["false", "no", "0", "unchecked"].includes(lower))
        return { ok: true, clear: false, value: false, valueType: "checkbox" };
      return { ok: false, error: `"${t}" is not true or false` };
    }
    case "date": {
      const m = DATE_RE.exec(t);
      if (!m || !validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])))
        return { ok: false, error: `"${t}" is not a date (YYYY-MM-DD)` };
      return { ok: true, clear: false, value: t, valueType: "date" };
    }
    case "datetime": {
      const m = DATETIME_RE.exec(t);
      if (
        !m ||
        !validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) ||
        Number(m[4]) > 23 ||
        Number(m[5]) > 59 ||
        (m[6] !== undefined && Number(m[6]) > 59)
      )
        return { ok: false, error: `"${t}" is not a date and time (YYYY-MM-DDTHH:mm)` };
      return {
        ok: true,
        clear: false,
        value: t.replace(" ", "T"),
        valueType: "datetime",
      };
    }
    case "list": {
      const items = parseListText(text);
      if (items.length === 0) return { ok: true, clear: true };
      return { ok: true, clear: false, value: items, valueType: "list" };
    }
    case "link":
      return { ok: true, clear: false, value: toWikiLinkText(t), valueType: "link" };
  }
}

/** A raw frontmatter item as text: scalars as written, anything nested as JSON. */
export function rawItemText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return JSON.stringify(raw) ?? "";
}

/** Initial editor text for a raw frontmatter value (`undefined` when the key is absent). */
export function rawToEditText(kind: EditKind, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (kind === "list")
    return Array.isArray(raw) ? raw.map(rawItemText).join(", ") : rawItemText(raw);
  return rawItemText(raw);
}

/** Items of a raw list value for the chips editor. A scalar string is a one-item list. */
export function rawToListItems(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(rawItemText);
  return [rawItemText(raw)];
}

/** Structural equality of two frontmatter JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/** The editor kind of a raw value of unknown origin (undo / redo of a value without a recorded kind). */
export function valueTypeOfRaw(raw: unknown): EditKind | undefined {
  if (typeof raw === "boolean") return "checkbox";
  if (typeof raw === "number") return "number";
  if (Array.isArray(raw)) return "list";
  if (typeof raw === "string") return isWikiLink(raw) ? "link" : undefined;
  return undefined;
}

/** Text of an item inside a list or other nested value (no display string is sent for those). */
export function itemText(item: CellValue): string {
  switch (item.type) {
    case "string":
    case "html":
    case "image":
    case "icon":
    case "file":
    case "date":
      return item.value;
    case "number":
      return item.value === null ? "NaN" : String(item.value);
    case "boolean":
      return String(item.value);
    case "link":
      return item.value.display ?? item.value.target;
    case "null":
      return "";
    case "error":
      return item.value.message;
    case "list":
      return item.value.map(itemText).join(", ");
    default:
      return item.type;
  }
}

// ---------------------------------------------------------------------------
// Optimistic cells
// ---------------------------------------------------------------------------

/** Split `[[target#heading|alias]]` into the link value fields, or `null` when it is not a wikilink. */
export function parseWikiLinkText(text: string): { target: string; display: string | null } | null {
  if (!isWikiLink(text)) return null;
  const link = parseWikiLinkValue(text);
  return { target: link.path, display: link.alias };
}

function rawItemToValue(item: string): CellValue {
  const link = parseWikiLinkText(item);
  return link
    ? { type: "link", value: { target: link.target, display: link.display, resolved: null } }
    : { type: "string", value: item };
}

/**
 * The cell a just-written raw value will show once the query catches up. Used for the
 * optimistic update; the backend's own cell replaces it on the next result. `kind` is the
 * editor kind the value was written with (it decides date vs text for a string).
 */
export function rawToCell(raw: unknown, kind: EditKind | undefined): Cell {
  if (raw === undefined || raw === null) return { type: "null", display: "" };
  if (typeof raw === "boolean") return { type: "boolean", value: raw, display: String(raw) };
  if (typeof raw === "number") return { type: "number", value: raw, display: String(raw) };
  if (Array.isArray(raw)) {
    const items = raw.map((x) => rawItemToValue(rawItemText(x)));
    return { type: "list", value: items, display: items.map(itemText).join(", ") };
  }
  const text = rawItemText(raw);
  if (kind === "date" || kind === "datetime")
    return { type: "date", value: text, hasTime: kind === "datetime", display: text };
  const link = parseWikiLinkText(text);
  if (link)
    return {
      type: "link",
      value: { target: link.target, display: link.display, resolved: null },
      display: link.display ?? link.target,
    };
  return { type: "string", value: text, display: text };
}
