// The pinned properties of a note (ADR 2026-11-19): which rows are pinned, in which order, and the
// short text of a collapsed-header chip. Pure; the pins themselves live in the property types store.
import type { PropertyRow } from "@/lib/frontmatter-properties";
import { typeKey, type PropertyTypeInfo } from "@/lib/property-types";
import { wikilinkLabel } from "./property-wikilink";
import { isWikiLink } from "@/lib/wiki-links";

/** Chips the collapsed header shows before `+n`. */
export const PINNED_VISIBLE = 4;
/** Items of a list value a chip shows before `+n`. */
const LIST_ITEMS = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `tags` keep their own collapsed display, so they have no pin. */
export function isPinnable(row: PropertyRow): boolean {
  return row.kind !== "tags" && row.kind !== "tagString";
}

function placeOf(row: PropertyRow, byKey: Record<string, PropertyTypeInfo>): number | null {
  return isPinnable(row) ? (byKey[typeKey(row.key)]?.pinned ?? null) : null;
}

export function isPinned(row: PropertyRow, byKey: Record<string, PropertyTypeInfo>): boolean {
  return placeOf(row, byKey) !== null;
}

/** The note's pinned rows in pin order. */
export function pinnedRows(
  rows: readonly PropertyRow[],
  byKey: Record<string, PropertyTypeInfo>,
): PropertyRow[] {
  return rows
    .flatMap((row) => {
      const place = placeOf(row, byKey);
      return place === null ? [] : [{ row, place }];
    })
    .sort((a, b) => a.place - b.place)
    .map((p) => p.row);
}

/** Display order of the expanded panel: pinned first in pin order, then the others in the note's
 *  order. The file's key order never changes. */
export function orderRows(
  rows: readonly PropertyRow[],
  byKey: Record<string, PropertyTypeInfo>,
): PropertyRow[] {
  const pinned = pinnedRows(rows, byKey);
  return pinned.length === 0 ? [...rows] : [...pinned, ...rows.filter((r) => !pinned.includes(r))];
}

/** `2026-11-20` as `Nov 20` (the year follows when it is not `now`'s); anything else as written. */
export function shortDate(value: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(value);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return value;
  const year = Number(m[1]) === now.getFullYear() ? "" : `, ${m[1]}`;
  return `${month} ${Number(m[3])}${year}${m[4] ? ` ${m[4]}` : ""}`;
}

function itemText(item: string): string {
  return isWikiLink(item) ? wikilinkLabel(item) : item;
}

/** The chip's text for a row, formatted as the panel shows it (dates short, links as their title,
 *  lists joined and cut with `+n`); `null` when the value is empty or has no short form. */
export function chipText(row: PropertyRow, now: Date = new Date()): string | null {
  switch (row.kind) {
    case "list": {
      const items = row.items.filter((i) => i !== "").map(itemText);
      if (items.length === 0) return null;
      const more = items.length - LIST_ITEMS;
      return items.slice(0, LIST_ITEMS).join(", ") + (more > 0 ? ` +${more}` : "");
    }
    case "date":
    case "datetime":
      return row.value === null || row.value === "" ? null : shortDate(String(row.value), now);
    case "checkbox":
      return row.value === true ? "Yes" : "No";
    case "link":
      return itemText(String(row.value ?? "")) || null;
    case "text":
    case "url":
    case "number":
      return row.value === null || String(row.value).trim() === "" ? null : String(row.value);
    default:
      return null; // empty, object, multiline, raw
  }
}
