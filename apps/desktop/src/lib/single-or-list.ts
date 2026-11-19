// Edits of a property that holds one item or a list of them (relationships, URLs): the shape is
// kept, a single value stays single until a second item is added, then it becomes a list. Pure
// splices on the frontmatter text through the one write path (`frontmatter-properties.ts`).
import {
  appendListItem,
  removeListItem,
  setList,
  setScalar,
  type EditResult,
  type PropertyRow,
} from "./frontmatter-properties";

/** Add `item` after the existing ones. `single` says the row's value is one item (a scalar the
 *  caller recognises); an empty row takes the item as a single value, a list gains an item, any
 *  other row fails with `unsupported`. */
export function addToSingleOrList(
  text: string,
  row: PropertyRow,
  item: string,
  single: boolean,
  unsupported: string,
): EditResult {
  if (row.kind === "empty") return setScalar(text, row.key, item, true);
  if (single) return setList(text, row.key, [String(row.value ?? ""), item]);
  if (row.kind === "list") return appendListItem(text, row.key, item);
  return { ok: false, error: unsupported };
}

/** Remove the item at `index`: removing the only item of a single value empties the property
 *  (`key:`), removing from a list leaves the others. */
export function removeFromSingleOrList(
  text: string,
  row: PropertyRow,
  index: number,
  single: boolean,
): EditResult {
  return single ? setScalar(text, row.key, null) : removeListItem(text, row.key, index);
}
