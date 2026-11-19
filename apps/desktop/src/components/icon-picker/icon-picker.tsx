import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HugeiconsIcon } from "@hugeicons/react";
import { buildIconIndex, searchIconIndex } from "@/lib/icon-picker/icon-search";
import {
  buildEmojiIndex,
  loadEmoji,
  searchEmojiIndex,
  type EmojiData,
} from "@/lib/icon-picker/emoji-search";
import { loadIconSet } from "@/lib/icon-picker/icon-set";
import { iconValue, isEmoji, parseIconValue } from "@/lib/icon-picker/icon-value";
import type { IconSet } from "@/lib/icon-picker/icon-shards";

const COLUMNS = 8;
const CELL = 36;
const VIEWPORT_HEIGHT = CELL * 6;
export const ICON_PICKER_WIDTH = 316;

export type IconPickerTab = "icons" | "emoji";
const TAB_LABEL: Record<IconPickerTab, string> = { icons: "Icons", emoji: "Emoji" };

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

interface Cell {
  key: string;
  label: string;
  /** `data-icon-name` / `data-emoji` for tests and styling. */
  data: Record<string, string>;
  selected: boolean;
  content: ReactNode;
}

/** A virtualized grid with one active cell, driven from the search field above it. */
function useGrid(cells: readonly Cell[], listId: string) {
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: Math.ceil(cells.length / COLUMNS),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CELL,
    overscan: 3,
    initialRect: { width: ICON_PICKER_WIDTH, height: VIEWPORT_HEIGHT },
  });
  function move(delta: number) {
    if (cells.length === 0) return;
    const next = Math.min(Math.max(active + delta, 0), cells.length - 1);
    setActive(next);
    virtualizer.scrollToIndex(Math.floor(next / COLUMNS));
  }
  const reset = () => {
    setActive(0);
    virtualizer.scrollToOffset(0);
  };
  const activeId = cells[active] ? `${listId}-${cells[active]!.key}` : undefined;
  return { active, setActive, scrollRef, virtualizer, move, reset, activeId };
}

/** The search field's keys: arrows move over the grid, Enter picks, Escape closes the picker. */
function searchKeys(grid: ReturnType<typeof useGrid>, pick: () => void, onClose: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    if (e.key in step) {
      e.preventDefault();
      grid.move(step[e.key]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
}

function GridView({
  cells,
  grid,
  listId,
  label,
  empty,
  color,
  onPick,
}: {
  cells: readonly Cell[];
  grid: ReturnType<typeof useGrid>;
  listId: string;
  label: string;
  empty: string | null;
  color?: string;
  onPick: (index: number) => void;
}) {
  return (
    <div
      ref={grid.scrollRef}
      id={listId}
      role="listbox"
      aria-label={label}
      style={{ height: VIEWPORT_HEIGHT }}
      className="mt-1.5 overflow-y-auto"
    >
      {empty ? (
        <p className="px-1 py-2 text-[12px] text-[var(--text-muted)]">{empty}</p>
      ) : (
        <div style={{ height: grid.virtualizer.getTotalSize(), position: "relative" }}>
          {grid.virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              role="presentation"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: CELL,
                transform: `translateY(${row.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
              }}
            >
              {cells.slice(row.index * COLUMNS, (row.index + 1) * COLUMNS).map((cell, c) => {
                const i = row.index * COLUMNS + c;
                return (
                  <div
                    key={cell.key}
                    id={`${listId}-${cell.key}`}
                    role="option"
                    aria-selected={cell.selected}
                    aria-label={cell.label}
                    title={cell.label}
                    {...Object.fromEntries(
                      Object.entries(cell.data).map(([k, v]) => [`data-${k}`, v]),
                    )}
                    data-active={i === grid.active ? "" : undefined}
                    onMouseEnter={() => grid.setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(i);
                    }}
                    style={color ? { color } : undefined}
                    className={`flex cursor-pointer items-center justify-center rounded-md hover:bg-[var(--item-hover-bg)] ${
                      i === grid.active ? "bg-[var(--item-hover-bg)]" : ""
                    } ${cell.selected ? "ring-1 ring-[var(--border-color)]" : ""}`}
                  >
                    {cell.content}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IconsTab({
  value,
  onPick,
  onClose,
  loadIcons,
  color,
}: {
  value: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
  loadIcons: () => Promise<IconSet>;
  color?: string;
}) {
  const [set, setSet] = useState<IconSet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const listId = useId();
  useEffect(() => {
    let stale = false;
    loadIcons().then(
      (s) => !stale && setSet(s),
      (e: unknown) => !stale && setLoadError(describe(e)),
    );
    return () => {
      stale = true;
    };
  }, [loadIcons]);
  const index = useMemo(() => (set ? buildIconIndex(Object.keys(set)) : []), [set]);
  const results = useMemo(() => searchIconIndex(index, query), [index, query]);
  const current = parseIconValue(value);
  const cells = useMemo<Cell[]>(
    () =>
      results.map((entry) => ({
        key: entry.name,
        label: entry.words.join(" "),
        data: { "icon-name": entry.name },
        selected: current?.kind === "icon" && current.name === entry.name,
        content: (
          <HugeiconsIcon
            icon={set![entry.name]!}
            size={18}
            strokeWidth={1.75}
            color="currentColor"
          />
        ),
      })),
    [results, set, current?.kind, current?.name],
  );
  const grid = useGrid(cells, listId);
  const pick = (i: number) => {
    const cell = cells[i];
    if (cell) onPick(iconValue("icon", cell.data["icon-name"]!));
  };
  return (
    <>
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-label="Search icons"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={grid.activeId}
        placeholder={set ? `Search ${index.length.toLocaleString("en-US")} icons` : "Loading icons"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          grid.reset();
        }}
        onKeyDown={searchKeys(grid, () => pick(grid.active), onClose)}
        className="h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none"
      />
      <GridView
        cells={cells}
        grid={grid}
        listId={listId}
        label="Icons"
        color={color}
        onPick={pick}
        empty={set && cells.length === 0 ? "No matching icon" : null}
      />
      {loadError ? (
        <p role="alert" className="px-1 py-2 text-[12px] text-[var(--text-primary)]">
          Could not load the icons. {loadError}
        </p>
      ) : null}
    </>
  );
}

function EmojiTab({
  value,
  onPick,
  onClose,
  loadData,
}: {
  value: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
  loadData: () => Promise<EmojiData>;
}) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [typedBad, setTypedBad] = useState(false);
  const listId = useId();
  useEffect(() => {
    let stale = false;
    loadData().then(
      (d) => !stale && setData(d),
      (e: unknown) => !stale && setLoadError(describe(e)),
    );
    return () => {
      stale = true;
    };
  }, [loadData]);
  const index = useMemo(() => (data ? buildEmojiIndex(data) : []), [data]);
  const results = useMemo(() => searchEmojiIndex(index, query), [index, query]);
  const current = parseIconValue(value);
  const cells = useMemo<Cell[]>(
    () =>
      results.map((e) => ({
        key: e.emoji,
        label: e.name,
        data: { emoji: e.emoji },
        selected: current?.kind === "emoji" && current.name === e.emoji,
        content: <span className="text-[20px] leading-none">{e.emoji}</span>,
      })),
    [results, current?.kind, current?.name],
  );
  const grid = useGrid(cells, listId);
  const pick = (i: number) => {
    const cell = cells[i];
    if (cell) onPick(iconValue("emoji", cell.data.emoji!));
  };
  const commitTyped = () => {
    const text = typed.trim();
    if (text === "") return;
    if (isEmoji(text)) onPick(iconValue("emoji", text));
    else setTypedBad(true);
  };
  return (
    <>
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-label="Search emoji"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={grid.activeId}
        placeholder={data ? "Search emoji" : "Loading emoji"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          grid.reset();
        }}
        onKeyDown={searchKeys(grid, () => pick(grid.active), onClose)}
        className="h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none"
      />
      <GridView
        cells={cells}
        grid={grid}
        listId={listId}
        label="Emoji"
        onPick={pick}
        empty={data && cells.length === 0 ? "No matching emoji" : null}
      />
      {loadError ? (
        <p role="alert" className="px-1 py-2 text-[12px] text-[var(--text-primary)]">
          Could not load the emoji. {loadError}
        </p>
      ) : null}
      <input
        type="text"
        aria-label="Type or paste an emoji"
        aria-invalid={typedBad || undefined}
        placeholder="Type or paste"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setTypedBad(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitTyped();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className={`mt-1.5 h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none ${
          typedBad ? "ring-1 ring-[var(--warning)]" : ""
        }`}
      />
      {typedBad ? (
        <p role="alert" className="mt-1 text-[12px] text-[var(--warning)]">
          Not an emoji
        </p>
      ) : null}
    </>
  );
}

/**
 * The one icon picker (core; the agent's project picker and the enum value icons use it): an
 * Icons tab (search over the whole Hugeicons free set, a virtualized grid) and an Emoji tab
 * (search by name and keyword, plus "Type or paste"). It only reports choices (`onPick` with
 * `icon:<Name>` or `emoji:<emoji>`, see `lib/icon-picker/icon-value.ts`); who stores them is the
 * caller. `onRemove` adds a "Remove icon" button; `footer` is the caller's own row (colours,
 * Reset). `loadIcons` and `loadEmojiData` are the test seams for the lazily loaded data.
 */
export function IconPicker({
  value,
  onPick,
  onRemove,
  onClose,
  label,
  tabs = ["icons", "emoji"],
  iconColor,
  footer,
  error,
  loadIcons = loadIconSet,
  loadEmojiData = loadEmoji,
}: {
  value: string | null;
  onPick: (value: string) => void;
  onRemove?: () => void;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  tabs?: readonly IconPickerTab[];
  /** CSS colour of the icons in the grid (the caller's own colour choice). */
  iconColor?: string;
  footer?: ReactNode;
  error?: string | null;
  loadIcons?: () => Promise<IconSet>;
  loadEmojiData?: () => Promise<EmojiData>;
}) {
  const parsed = parseIconValue(value);
  const [tab, setTab] = useState<IconPickerTab>(
    parsed?.kind === "emoji" && tabs.includes("emoji") ? "emoji" : tabs[0]!,
  );
  return (
    <div
      role="dialog"
      aria-label={label}
      style={{ width: ICON_PICKER_WIDTH }}
      className="max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--surface-primary)] p-2 shadow-lg"
      onKeyDown={(e) => {
        // Escape from a tab or button also closes the picker, before anything behind it
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Kind" className="mb-1.5 flex gap-1">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-2 py-1 text-[12px] ${
                tab === t
                  ? "bg-[var(--item-hover-bg)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
              }`}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      {tab === "icons" ? (
        <IconsTab
          key="icons"
          value={value}
          onPick={onPick}
          onClose={onClose}
          loadIcons={loadIcons}
          color={iconColor}
        />
      ) : (
        <EmojiTab
          key="emoji"
          value={value}
          onPick={onPick}
          onClose={onClose}
          loadData={loadEmojiData}
        />
      )}
      {onRemove && parsed ? (
        <button
          type="button"
          onClick={onRemove}
          className="mt-2 rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
        >
          Remove icon
        </button>
      ) : null}
      {footer}
      {error ? (
        <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-primary)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
