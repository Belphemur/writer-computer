// Header-click sorting: how a click changes a view's `sort` list. Pure.
import { canonicalPropertyKey } from "./cells";
import type { BaseSortKey, SortDirection } from "./types";

const NEXT: Record<SortDirection, SortDirection | null> = { ASC: "DESC", DESC: null };

/**
 * A click on a header cycles that column asc, desc, none. An unsorted column becomes the only sort
 * key (asc); with `append` it is added as the last key instead. A column that already sorts keeps
 * its position in a multi-sort while it cycles.
 */
export function cycleSort(
  keys: readonly BaseSortKey[],
  columnId: string,
  append: boolean,
): BaseSortKey[] {
  const want = canonicalPropertyKey(columnId);
  const at = keys.findIndex((k) => canonicalPropertyKey(k.property) === want);
  if (at < 0) {
    const added: BaseSortKey = { property: columnId, direction: "ASC" };
    return append ? [...keys, added] : [added];
  }
  const next = NEXT[keys[at]!.direction];
  if (next === null) return keys.filter((_, i) => i !== at);
  return keys.map((k, i) => (i === at ? { ...k, direction: next } : k));
}
