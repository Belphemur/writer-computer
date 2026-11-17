import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  GridViewIcon,
  KanbanIcon,
  Layout01Icon,
  ListViewIcon,
  MapIcon,
  Search01Icon,
  Table01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ViewChoice } from "../lib/grid";
import { filterViews, typeaheadIndex } from "../lib/view-search";
import { getBaseView } from "../lib/view-registry";

/** The search box appears past this many views; a short list is just the list. */
export const SEARCH_THRESHOLD = 6;
const TYPEAHEAD_RESET_MS = 700;
const POPOVER_WIDTH = 260;
const MAX_LIST_HEIGHT = 288;
const GAP = 4;
const EDGE = 8;

type Icon = typeof Table01Icon;
/** Registry icon ids (`lucide` names, as plugins pass them) to the icons the app ships. */
const ICONS: Record<string, Icon> = {
  table: Table01Icon,
  "layout-grid": GridViewIcon,
  grid: GridViewIcon,
  list: ListViewIcon,
  kanban: KanbanIcon,
  "square-kanban": KanbanIcon,
  "layout-dashboard": KanbanIcon,
  map: MapIcon,
  "map-pin": MapIcon,
};

function iconFor(type: string | undefined): Icon {
  const id = type ? getBaseView(type)?.icon : undefined;
  return (id && ICONS[id]) || Layout01Icon;
}

function TypeIcon({ type }: { type: string | undefined }) {
  return (
    <span aria-hidden className="flex shrink-0 text-text-muted">
      <HugeiconsIcon icon={iconFor(type)} size={14} color="currentColor" strokeWidth={1.8} />
    </span>
  );
}

interface Place {
  left: number;
  width: number;
  /** Distance from the viewport top (opens down) or bottom (opens up). */
  top?: number;
  bottom?: number;
  listMax: number;
}

function placeBelow(anchor: DOMRect, searchable: boolean): Place {
  const width = Math.max(POPOVER_WIDTH, anchor.width);
  const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE));
  const chrome = searchable ? 76 : 8;
  const below = window.innerHeight - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  if (below >= 160 || below >= above) {
    return {
      left,
      width,
      top: anchor.bottom + GAP,
      listMax: Math.max(96, Math.min(MAX_LIST_HEIGHT, below - chrome)),
    };
  }
  return {
    left,
    width,
    bottom: window.innerHeight - anchor.top + GAP,
    listMax: Math.max(96, Math.min(MAX_LIST_HEIGHT, above - chrome)),
  };
}

interface Props {
  views: readonly ViewChoice[];
  /** The selected view (may name a view that no longer exists). */
  selected: string | undefined;
  onSelect: (name: string) => void;
}

/**
 * The view picker: a trigger showing the selected view and a portaled listbox popover. A base
 * with more than {@link SEARCH_THRESHOLD} views gets a search box; a short one gets the plain list,
 * with type-ahead. Edits to the views (rename, add, move, delete) stay in the View menu.
 */
export function ViewSwitcher({ views, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const current = selected ?? views[0]?.name;
  const currentView = views.find((v) => v.name === current);
  const searchable = views.length > SEARCH_THRESHOLD;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const isInside = (t: EventTarget | null) =>
      t instanceof Node && (popoverRef.current?.contains(t) || triggerRef.current?.contains(t));
    // Outside clicks and wheel-scrolls close it: a fixed popover would drift off its trigger.
    const onPointer = (e: PointerEvent) => {
      if (!isInside(e.target)) setOpen(false);
    };
    const onWheel = (e: Event) => {
      if (!isInside(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("wheel", onWheel, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // The views changed under an open popover (a rename or delete): keep it consistent, not stale.
  const count = views.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  // A base without views (or still loading) has nothing to pick.
  if (count === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-view-switcher
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`View: ${current}`}
        title="Switch view"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          setOpen(true);
        }}
        className="flex min-w-0 max-w-[240px] cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-[12px] text-text-primary hover:bg-[var(--item-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-border)]"
      >
        <TypeIcon type={currentView?.type} />
        <span className="min-w-0 truncate">{current}</span>
        <span aria-hidden className="flex shrink-0 text-text-muted">
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} color="currentColor" strokeWidth={2} />
        </span>
      </button>
      {open
        ? createPortal(
            <ViewPopover
              ref={popoverRef}
              views={views}
              selected={current}
              searchable={searchable}
              anchor={triggerRef}
              listId={listId}
              optionId={optionId}
              onPick={(name) => {
                close(true);
                if (name !== current) onSelect(name);
              }}
              onEscape={() => close(true)}
              onTab={() => close(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

interface PopoverProps {
  views: readonly ViewChoice[];
  selected: string | undefined;
  searchable: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  listId: string;
  optionId: (i: number) => string;
  onPick: (name: string) => void;
  onEscape: () => void;
  onTab: () => void;
  ref: React.Ref<HTMLDivElement>;
}

function ViewPopover({
  views,
  selected,
  searchable,
  anchor,
  listId,
  optionId,
  onPick,
  onEscape,
  onTab,
  ref,
}: PopoverProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterViews(views, query), [views, query]);
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      0,
      views.findIndex((v) => v.name === selected),
    ),
  );
  const [place, setPlace] = useState<Place | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPlace(placeBelow(rect, searchable));
  }, [anchor, searchable]);

  // The layout effect above has placed (and so shown) the popover before this runs.
  useEffect(() => focusRef.current?.focus({ preventScroll: true }), []);

  const active = matches.length === 0 ? -1 : Math.min(highlight, matches.length - 1);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const move = (to: number) => {
    if (matches.length > 0) setHighlight(((to % matches.length) + matches.length) % matches.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nothing typed here is the editor's: keep the keys inside the popover.
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(active + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(active < 0 ? 0 : active - 1);
        return;
      case "Home":
        e.preventDefault();
        move(0);
        return;
      case "End":
        e.preventDefault();
        move(matches.length - 1);
        return;
      case "Enter":
        e.preventDefault();
        if (active >= 0) onPick(matches[active]!.name);
        return;
      case "Escape":
        e.preventDefault();
        onEscape();
        return;
      case "Tab":
        onTab();
        return;
    }
    if (searchable || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    if (e.key === " " && typed.current.text === "") return;
    // Plain list: type-ahead on the names.
    const now = Date.now();
    const fresh = now - typed.current.at > TYPEAHEAD_RESET_MS;
    typed.current = { text: (fresh ? "" : typed.current.text) + e.key, at: now };
    const names = matches.map((v) => v.name);
    const text = typed.current.text;
    const cycle = text.length === 1 || text.split("").every((c) => c === text[0]);
    const found = typeaheadIndex(names, cycle ? text[0]! : text, cycle ? active + 1 : active);
    if (found >= 0) setHighlight(found);
  };

  const listbox = (
    <div
      ref={(el) => {
        listRef.current = el;
        if (!searchable) focusRef.current = el;
      }}
      id={listId}
      role="listbox"
      aria-label="Views"
      tabIndex={searchable ? -1 : 0}
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      onKeyDown={searchable ? undefined : onKeyDown}
      style={{ maxHeight: place?.listMax }}
      className="overflow-y-auto p-1 outline-none"
    >
      {matches.length === 0 ? (
        <div role="presentation" className="px-2 py-3 text-center text-[12px] text-text-muted">
          No matching views
        </div>
      ) : (
        matches.map((view, i) => {
          const isSelected = view.name === selected;
          return (
            <div
              key={view.name}
              id={optionId(i)}
              role="option"
              data-index={i}
              data-view-option={view.name}
              aria-selected={isSelected}
              onMouseMove={() => i !== active && setHighlight(i)}
              onClick={() => onPick(view.name)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-text-primary ${
                i === active ? "bg-[var(--item-hover-bg)]" : ""
              }`}
            >
              <TypeIcon type={view.type} />
              <span className="min-w-0 flex-1 truncate">{view.name}</span>
              <span
                aria-hidden
                className={`flex shrink-0 text-text-muted ${isSelected ? "" : "invisible"}`}
              >
                <HugeiconsIcon icon={Tick02Icon} size={14} color="currentColor" strokeWidth={2} />
              </span>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div
      ref={ref}
      data-view-popover
      // Clicks on the list or footer must not pull focus off the input or listbox.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      // Hidden until measured so it never flashes at the wrong spot.
      style={
        place
          ? {
              position: "fixed",
              left: place.left,
              top: place.top,
              bottom: place.bottom,
              width: place.width,
            }
          : { position: "fixed", visibility: "hidden", left: 0, top: 0, width: POPOVER_WIDTH }
      }
      className="z-[100] overflow-hidden rounded-lg border border-border bg-surface-primary text-[13px] text-text-primary shadow-lg"
    >
      {searchable ? (
        <div className="flex items-center gap-2 border-b border-[var(--line-subtler)] px-2.5 py-2">
          <span aria-hidden className="flex shrink-0 text-text-muted">
            <HugeiconsIcon icon={Search01Icon} size={14} color="currentColor" strokeWidth={1.8} />
          </span>
          <input
            ref={(el) => {
              focusRef.current = el;
            }}
            type="text"
            role="combobox"
            aria-label="Search views"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search views…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
      ) : null}
      {listbox}
      {searchable ? (
        <div
          data-view-count
          className="border-t border-[var(--line-subtler)] px-2.5 py-1.5 text-[11px] text-text-muted"
        >
          {matches.length === views.length
            ? `${views.length} views`
            : `${matches.length} of ${views.length} views`}
        </div>
      ) : null}
    </div>
  );
}
