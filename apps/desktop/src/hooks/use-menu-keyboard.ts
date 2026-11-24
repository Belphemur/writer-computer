import { useEffect, type KeyboardEvent, type RefObject } from "react";

/** What arrows move over and first focus lands on in a menu: its enabled items, and a field marked
 *  `data-menu-nav` (a search box). A disabled item is never focused. */
export const MENU_NAV = "[role^=menuitem]:not(:disabled), [data-menu-nav]";

/**
 * The one keyboard behaviour of a popover menu (the composer's chips, the row menus): first focus
 * on open (the search field, else the checked item when enabled, else the first enabled one),
 * arrows that wrap over the enabled items, Esc and Tab closing, and focus back on the anchor when
 * the menu goes away (unless the user already moved it elsewhere, a click outside). Returns the
 * `onKeyDown` for an element around the menu (and its anchor).
 */
export function useMenuKeyboard(
  bodyRef: RefObject<HTMLElement | null>,
  opts: {
    onClose: () => void;
    returnFocusTo: RefObject<HTMLElement | null>;
    /** False while the menu is closed (its body is not mounted). */
    open?: boolean;
  },
) {
  const { onClose, returnFocusTo, open = true } = opts;

  useEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    const anchor = returnFocusTo.current;
    const checked = body?.querySelector<HTMLElement>(
      "[role^=menuitem][aria-checked=true]:not(:disabled)",
    );
    (
      body?.querySelector<HTMLElement>("[data-menu-nav]") ??
      checked ??
      body?.querySelector<HTMLElement>(MENU_NAV)
    )?.focus();
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body) anchor?.focus();
    };
  }, [open, bodyRef, returnFocusTo]);

  return (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...(bodyRef.current?.querySelectorAll<HTMLElement>(MENU_NAV) ?? [])];
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(i + delta + items.length) % items.length]?.focus();
    }
  };
}
