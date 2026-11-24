import type { KeyboardEvent, RefObject } from "react";

const NEXT_KEYS = ["ArrowDown", "ArrowRight"];
const PREV_KEYS = ["ArrowUp", "ArrowLeft"];

/**
 * Keys of a roving tablist: arrows move to the next or previous tab (wrapping) and select it,
 * Home and End jump. The tabs are the `[role=tab]` elements of the list in `ids` order; the
 * selected one is the tab stop (`tabIndex` 0, the others -1, set by the caller). Returns the
 * `onKeyDown` for the `role=tablist` element.
 */
export function useRovingTablist(
  listRef: RefObject<HTMLElement | null>,
  opts: { ids: readonly string[]; selectedId: string; onSelect: (id: string) => void },
) {
  const { ids, selectedId, onSelect } = opts;
  return (e: KeyboardEvent) => {
    if (ids.length === 0) return;
    const at = ids.indexOf(selectedId);
    let next = -1;
    if (NEXT_KEYS.includes(e.key)) next = (at + 1) % ids.length;
    else if (PREV_KEYS.includes(e.key)) next = (at - 1 + ids.length) % ids.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(ids[next]!);
    listRef.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };
}
