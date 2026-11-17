// Pure layout helpers for the table: flattening groups into display items,
// column widths, row heights and sort indicators. No React, no IPC.
import { canonicalPropertyKey } from "./cells";
import type { BaseQueryResult, BaseView, Cell, Column, Group, SortDirection } from "./types";

export const DEFAULT_COLUMN_WIDTH = 180;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1200;

/** Row heights for the documented `rowHeight` values (px). */
export const ROW_HEIGHTS: Record<string, number> = {
  short: 28,
  medium: 36,
  tall: 52,
  "extra tall": 72,
};
export const DEFAULT_ROW_HEIGHT = ROW_HEIGHTS.short!;
export const GROUP_HEADER_HEIGHT = 32;

export type GridItem =
  | {
      kind: "group";
      groupIndex: number;
      /** Stable identity for the collapse state. */
      key: string;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | { kind: "group-summary"; groupIndex: number; summaries: (Cell | null)[] }
  | { kind: "row"; row: number };

export interface GridLayout {
  items: GridItem[];
  /** Data row indices in visible order (collapsed groups excluded). */
  visibleRows: number[];
  /** Data row index -> index in `items`, `-1` while hidden by a collapsed group. */
  itemIndexOfRow: number[];
}

/** Identity of a group across requeries: value type plus display string. */
export function groupKey(group: Group): string {
  return `${group.key.type}:${group.key.display}`;
}

export function groupLabel(group: Group): string {
  if (group.key.type === "null" || group.key.display === "") return "No value";
  return group.key.display;
}

/**
 * Flatten rows and groups into the items the table renders. Without groups
 * every row is an item. With groups each group contributes a header, a summary
 * row when any summary is configured, and its rows unless it is collapsed.
 * Throws when the groups do not describe ranges inside `rows` (a backend bug,
 * surfaced instead of rendering a wrong table).
 */
export function buildGridLayout(
  result: Pick<BaseQueryResult, "rows" | "groups">,
  collapsed: ReadonlySet<string>,
): GridLayout {
  const { rows, groups } = result;
  const items: GridItem[] = [];
  const visibleRows: number[] = [];
  const itemIndexOfRow: number[] = Array.from({ length: rows.length }, () => -1);

  if (!groups) {
    for (let r = 0; r < rows.length; r++) {
      itemIndexOfRow[r] = items.length;
      visibleRows.push(r);
      items.push({ kind: "row", row: r });
    }
    return { items, visibleRows, itemIndexOfRow };
  }

  let expectedStart = 0;
  groups.forEach((group, groupIndex) => {
    if (group.start !== expectedStart || group.len < 0 || group.start + group.len > rows.length)
      throw new Error(
        `Invalid group range ${group.start}+${group.len} for ${rows.length} rows (group ${groupIndex})`,
      );
    expectedStart = group.start + group.len;
    const key = groupKey(group);
    const isCollapsed = collapsed.has(key);
    items.push({
      kind: "group",
      groupIndex,
      key,
      label: groupLabel(group),
      count: group.len,
      collapsed: isCollapsed,
    });
    if (group.summaries.some((s) => s !== null))
      items.push({ kind: "group-summary", groupIndex, summaries: group.summaries });
    if (isCollapsed) return;
    for (let r = group.start; r < group.start + group.len; r++) {
      itemIndexOfRow[r] = items.length;
      visibleRows.push(r);
      items.push({ kind: "row", row: r });
    }
  });
  if (expectedStart !== rows.length)
    throw new Error(`Groups cover ${expectedStart} of ${rows.length} rows`);
  return { items, visibleRows, itemIndexOfRow };
}

/** Pixel size of an item. */
export function itemHeight(item: GridItem, rowHeight: number): number {
  return item.kind === "group" ? GROUP_HEADER_HEIGHT : rowHeight;
}

export function rowHeightPx(view: BaseView | undefined): number {
  const raw = view?.extra.rowHeight;
  return (typeof raw === "string" && ROW_HEIGHTS[raw.toLowerCase()]) || DEFAULT_ROW_HEIGHT;
}

/** Width of each column: the view's `columnSize` (by canonical key), else the default. */
export function columnWidths(columns: readonly Column[], view: BaseView | undefined): number[] {
  const sizes = new Map<string, number>();
  for (const [id, value] of Object.entries(view?.columnSize ?? {})) {
    if (typeof value === "number" && Number.isFinite(value))
      sizes.set(canonicalPropertyKey(id), value);
  }
  return columns.map((column) => {
    const size = sizes.get(column.key);
    if (size === undefined) return DEFAULT_COLUMN_WIDTH;
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(size)));
  });
}

export interface SortIndicator {
  direction: SortDirection;
  /** 1-based priority among the view's sort keys (only shown when there are several). */
  priority: number;
  of: number;
}

/** Sort and group-by markers per column key, from the view definition. Display only. */
export function sortIndicators(view: BaseView | undefined): {
  sort: Map<string, SortIndicator>;
  groupBy: string | null;
} {
  const sort = new Map<string, SortIndicator>();
  const keys = view?.sort ?? [];
  keys.forEach((s, i) => {
    const key = canonicalPropertyKey(s.property);
    if (!sort.has(key)) sort.set(key, { direction: s.direction, priority: i + 1, of: keys.length });
  });
  const groupBy = view?.groupBy ? canonicalPropertyKey(view.groupBy.property) : null;
  return { sort, groupBy };
}

/** `aria-sort` value of a column header. */
export function ariaSort(
  indicator: SortIndicator | undefined,
): "ascending" | "descending" | "none" {
  if (!indicator) return "none";
  return indicator.direction === "ASC" ? "ascending" : "descending";
}

/** The view of the document that a query result belongs to. */
export function viewOfResult(
  document: { views: BaseView[] } | null,
  result: Pick<BaseQueryResult, "view"> | null,
): BaseView | undefined {
  if (!document || !result) return undefined;
  const index = result.view.index;
  return index === null ? undefined : document.views[index];
}

/** Names for the toolbar tabs; an empty list (a base without views) shows no tabs. */
export function viewNames(document: { views: BaseView[] } | null): string[] {
  return document ? document.views.map((v) => v.name) : [];
}

/** A view in the toolbar's view switcher; `type` is `undefined` when the document has no such view. */
export interface ViewChoice {
  name: string;
  type: string | undefined;
}

/** `names` (the result's `availableViews` or the document's) with each view's type for its icon. */
export function viewChoices(
  names: readonly string[],
  document: { views: BaseView[] } | null,
): ViewChoice[] {
  const types = new Map<string, string>();
  for (const v of document?.views ?? []) if (!types.has(v.name)) types.set(v.name, v.type);
  return names.map((name) => ({ name, type: types.get(name) }));
}
