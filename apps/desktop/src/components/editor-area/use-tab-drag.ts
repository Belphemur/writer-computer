import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

// Distance the pointer must travel before a press on a tab becomes a drag, so plain clicks
// still select the tab.
const DRAG_THRESHOLD_PX = 4;

/** Where the dragged tab lands among the others of its group: how many of them lie left of `x`. */
export function dropIndexAmong(otherCenters: readonly number[], x: number): number {
  return otherCenters.filter((center) => center < x).length;
}

/**
 * Drag a tab sideways to reorder it. The tab moves live as the pointer passes its neighbours.
 * Only tabs of the dragged tab's own group (`data-tab-pinned`) are candidates, so a pinned tab
 * never lands among the unpinned ones or the other way round; the store's `moveTab` clamps too.
 */
export function useTabDrag(moveTab: (tabId: string, toIndex: number) => void) {
  const justDragged = useRef(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tabId: string, pinned: boolean) => {
      if (event.button !== 0) return;
      const strip = event.currentTarget.closest<HTMLElement>("[data-tab-strip]");
      if (!strip) return;
      const startX = event.clientX;
      let dragging = false;

      const onMove = (e: PointerEvent) => {
        if (!dragging) {
          if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
          dragging = true;
        }
        const own = Array.from(
          strip.querySelectorAll<HTMLElement>(`[data-tab-id][data-tab-pinned="${pinned}"]`),
        ).filter((el) => el.dataset.tabId !== tabId);
        const centers = own.map((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left + rect.width / 2;
        });
        const groupStart = pinned
          ? 0
          : strip.querySelectorAll('[data-tab-id][data-tab-pinned="true"]').length;
        moveTab(tabId, groupStart + dropIndexAmong(centers, e.clientX));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!dragging) return;
        // The click that follows the release must not select the tab it ended on.
        justDragged.current = true;
        setTimeout(() => {
          justDragged.current = false;
        }, 0);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [moveTab],
  );

  const consumeDragClick = useCallback(() => justDragged.current, []);

  return { onPointerDown, consumeDragClick };
}
