import { useEffect } from "react";
import { useActiveTabId } from "./use-tabs";

/**
 * How far to scroll (`scrollLeft` delta) so a tab lies fully inside the visible part of the
 * scrolling strip. 0 when it already does. A tab wider than the view aligns its start. The view
 * is the scroll part only: the fixed pinned group sits outside it, so its width is already
 * excluded and an unpinned tab can never end up under the pinned tabs.
 */
export function scrollDeltaIntoView(
  tab: { left: number; right: number },
  view: { left: number; right: number },
): number {
  if (tab.left < view.left) return tab.left - view.left;
  if (tab.right > view.right) {
    return Math.min(tab.right - view.right, tab.left - view.left);
  }
  return 0;
}

/**
 * Scrolls the tab matching `selector` (null: none) into view inside its `data-tab-scroll`
 * ancestor whenever the selector changes. The one implementation behind every tab strip (editor
 * tabs, agent chat tabs). A tab outside a scroll part (a pinned one) is always visible, so
 * nothing happens for it. Instant, and skipped when the tab is already fully visible.
 */
export function useScrollTabIntoView(selector: string | null) {
  useEffect(() => {
    if (!selector) return;
    const tab = document.querySelector<HTMLElement>(selector);
    const scroller = tab?.closest<HTMLElement>("[data-tab-scroll]");
    if (!tab || !scroller) return;
    const delta = scrollDeltaIntoView(
      tab.getBoundingClientRect(),
      scroller.getBoundingClientRect(),
    );
    if (delta !== 0) scroller.scrollLeft += delta;
  }, [selector]);
}

/** The editor strip's active tab (tagged `data-tab-id`). */
export function useScrollActiveTabIntoView() {
  const activeTabId = useActiveTabId();
  useScrollTabIntoView(activeTabId ? `[data-tab-id="${CSS.escape(activeTabId)}"]` : null);
}
