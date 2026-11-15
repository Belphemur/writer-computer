import { useCallback, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface Props<T> {
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

/** A vertically windowed list of fixed-height items: only the visible window is in the DOM. */
export function WindowedList<T>({
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
  const virtualizer = useVirtualizer({
    count: items.length,
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

  return (
    <div
      ref={ref}
      role="list"
      aria-label={label}
      {...{ [marker]: "" }}
      className="relative min-h-0 flex-1 overflow-auto"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            role="listitem"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: vi.size,
              transform: `translateY(${vi.start}px)`,
            }}
          >
            {render(items[vi.index]!, vi.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
