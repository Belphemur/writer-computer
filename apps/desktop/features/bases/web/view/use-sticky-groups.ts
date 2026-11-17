import { useCallback, useMemo, useRef } from "react";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";
import { activeHeaderIndex, groupHeaderIndexes, withPinned } from "../lib/sticky";

/**
 * Sticky group headers for a virtualized list: `rangeExtractor` goes to `useVirtualizer` and adds
 * the active group's header to the rendered indexes even when its slot has scrolled out of the
 * window. The caller renders that one item with `position: sticky` instead of an absolute
 * transform (see `stickyStyle`), so the browser pins it with no scroll handler and no layout
 * reads. The extractor only runs when the virtual range changes, which is exactly when the first
 * visible item can cross a header, so there is no extra scroll state either.
 *
 * Read `activeRef.current` after `virtualizer.getVirtualItems()` in the same render: that call
 * runs the extractor.
 */
export function useStickyGroups(items: readonly { kind: string }[]) {
  const headers = useMemo(() => groupHeaderIndexes(items), [items]);
  const activeRef = useRef<number | null>(null);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const active = activeHeaderIndex(headers, range.startIndex);
      activeRef.current = active;
      return withPinned(defaultRangeExtractor(range), active);
    },
    [headers],
  );
  return { rangeExtractor, activeRef };
}
