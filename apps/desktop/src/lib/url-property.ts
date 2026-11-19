// The `url` property type's value shape: one address or a list of them (spec:
// `SPECs/properties-types-spec.md` "URL"). Whether an item is a URL is `lib/url-value.ts`; a value
// that is not one is kept as written and only marked. Edits keep the shape like relationships
// (`lib/single-or-list.ts`).
import type { EditResult, PropertyRow } from "./frontmatter-properties";
import { addToSingleOrList, removeFromSingleOrList } from "./single-or-list";

/** Rows the URL field edits in place: a text value, a list, or nothing yet. Anything else (a
 *  number, a date, a link, a map) keeps its own editor and shows "Not a URL". */
export function isUrlRow(row: PropertyRow): boolean {
  if (row.kind === "empty") return true;
  if (row.kind === "list") return row.editable;
  return (row.kind === "text" || row.kind === "url") && row.editable;
}

const isSingle = (row: PropertyRow) => row.kind === "text" || row.kind === "url";

/** The items of a URL row, in order: the single value, the list items, or none. */
export function urlItems(row: PropertyRow): string[] {
  if (isSingle(row)) return row.value === null || row.value === "" ? [] : [String(row.value)];
  return row.kind === "list" ? row.items : [];
}

/** Add `url` after the existing ones: the first of an empty property is a single value, a second
 *  turns it into a list, a list gains an item. */
export function addUrl(text: string, row: PropertyRow, url: string): EditResult {
  const single = isSingle(row) && urlItems(row).length > 0;
  // `key: ""` holds no URL yet: the new one replaces it as a single value
  const target: PropertyRow = isSingle(row) && !single ? { ...row, kind: "empty" } : row;
  return addToSingleOrList(text, target, url, single, "This value cannot take another URL.");
}

/** Remove the URL at `index`; removing the only one of a single value empties the property. */
export function removeUrl(text: string, row: PropertyRow, index: number): EditResult {
  return removeFromSingleOrList(text, row, index, isSingle(row));
}
