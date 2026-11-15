import { useCallback, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStickyGroups } from "./use-sticky-groups";

interface Props<T extends { kind: string }> {
  items: readonly T[];
  /** Pixel height of an item; heights are computed, never measured, so windowing is exact. */
  heightOf: (item: T, index: number) => number;
  keyOf: (item: T, index: number) => string;
  render: (item: T, index: number) => React.ReactNode;
  label: string;
  /** Called with the scroll area's width (on mount and when it resizes). */
  onWidth?: (width: number) => void;
  /** `data-*` marker of the scroll element. */
  marker: string;
}

/**
 * A vertically windowed list of fixed-height items: only the visible window is in the DOM. Items
 * of `kind: "group"` are group headers; the active one is pinned at the top of the scroller
 * (`use-sticky-groups.ts`).
 */
export function WindowedList<T extends { kind: string }>({
  items,
  heightOf,
  keyOf,
  render,
  label,
  onWidth,
  marker,
}: Props<T>) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  const { rangeExtractor, activeRef } = useStickyGroups(items);
  const virtualizer = useVirtualizer({
    count: items.length,
    rangeExtractor,
    getScrollElement: () => el,
    estimateSize: (i) => heightOf(items[i]!, i),
    getItemKey: (i) => keyOf(items[i]!, i),
    overscan: 6,
  });

  useEffect(() => {
    if (!el || !onWidth) return;
    const measure = () => onWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, onWidth]);

  const virtualItems = virtualizer.getVirtualItems();
  const pinned = virtualItems.some((vi) => vi.index === activeRef.current)
    ? activeRef.current
    : null;

  return (
    <div
      ref={ref}
      role="list"
      aria-label={label}
      {...{ [marker]: "" }}
      className="relative min-h-0 flex-1 overflow-auto"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((vi) => (
          <div
            key={vi.key}
            role="listitem"
            data-sticky-group={vi.index === pinned ? "" : undefined}
            style={
              vi.index === pinned
                ? { position: "sticky", top: 0, zIndex: 2, height: vi.size, width: "100%" }
                : {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                  }
            }
            className={vi.index === pinned ? "bg-surface-primary" : undefined}
          >
            {render(items[vi.index]!, vi.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
