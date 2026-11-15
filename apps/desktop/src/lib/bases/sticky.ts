// Sticky group headers of the windowed views. Pure: which header is pinned, and which indexes the
// virtualizer must render so that header stays in the DOM while its own position has scrolled out
// of the window. No React, no IPC.

/** Indexes (ascending) of the items that are group headers. */
export function groupHeaderIndexes(items: readonly { kind: string }[]): number[] {
  const out: number[] = [];
  items.forEach((item, i) => {
    if (item.kind === "group") out.push(i);
  });
  return out;
}

/**
 * The header that is pinned while the item at `firstVisible` is the first one in view: the last
 * header at or before it. `firstVisible` is the item that contains the scroll offset (the
 * virtualizer's `range.startIndex`), so this answers "which group is active at scrollTop"
 * without measuring anything. `null` when no header precedes it (ungrouped views, or content
 * above the first header).
 */
export function activeHeaderIndex(headers: readonly number[], firstVisible: number): number | null {
  let lo = 0;
  let hi = headers.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headers[mid]! <= firstVisible) {
      found = headers[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** `indexes` plus `active` (when not null and missing), ascending and without duplicates. */
export function withPinned(indexes: readonly number[], active: number | null): number[] {
  if (active === null || indexes.includes(active)) return [...indexes];
  const out = [...indexes, active];
  out.sort((a, b) => a - b);
  return out;
}
