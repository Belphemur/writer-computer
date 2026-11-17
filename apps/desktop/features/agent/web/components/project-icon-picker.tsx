import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import {
  PROJECT_COLORS,
  loadProjectIconSet,
  projectColorVar,
  type ProjectAppearance,
} from "@features/agent/web/lib/project-appearance";
import type { IconSet } from "@features/agent/web/lib/project-icon-shards";
import {
  buildIconIndex,
  searchIconIndex,
  type IconIndexEntry,
} from "@features/agent/web/lib/project-icon-search";
import { useProjectAppearance, useProjectsStore } from "@features/agent/web/stores/projects-store";
import { HugeiconsIcon } from "@hugeicons/react";

const COLUMNS = 8;
const CELL = 36;
const VIEWPORT_HEIGHT = CELL * 6;
const PANEL_WIDTH = 316;

/** What the user picked: an icon or reset ends the interaction, a color does not (the user
 *  usually wants both). */
export type PickKind = "icon" | "color" | "reset";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * The icon and color panel (spec 4.8): a search field over the whole Hugeicons free set, a
 * virtualized grid, the color swatches and Reset. It only reports choices (`onChange`); who
 * writes them is the caller (the popover below for a saved project, the new-project dialog's
 * state for one that does not exist yet). `loadIcons` is the test seam for the lazily loaded set.
 */
export function ProjectIconPicker({
  value,
  onChange,
  onClose,
  error,
  loadIcons = loadProjectIconSet,
}: {
  value: ProjectAppearance;
  onChange: (next: ProjectAppearance, kind: PickKind) => void;
  onClose: () => void;
  error?: string | null;
  loadIcons?: () => Promise<IconSet>;
}) {
  const [set, setSet] = useState<IconSet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    let stale = false;
    loadIcons().then(
      (s) => {
        if (!stale) setSet(s);
      },
      (e: unknown) => {
        if (!stale) setLoadError(describe(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [loadIcons]);

  const index = useMemo(() => (set ? buildIconIndex(Object.keys(set)) : []), [set]);
  const results = useMemo(() => searchIconIndex(index, query), [index, query]);
  const rowCount = Math.ceil(results.length / COLUMNS);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CELL,
    overscan: 3,
    initialRect: { width: PANEL_WIDTH, height: VIEWPORT_HEIGHT },
  });

  function move(delta: number) {
    if (results.length === 0) return;
    const next = Math.min(Math.max(active + delta, 0), results.length - 1);
    setActive(next);
    virtualizer.scrollToIndex(Math.floor(next / COLUMNS));
  }

  function pick(entry: IconIndexEntry | undefined) {
    if (entry) onChange({ icon: entry.name, color: value.color }, "icon");
  }

  const activeId = results[active] ? `${listId}-${results[active].name}` : undefined;

  return (
    <div
      data-project-icon-picker
      role="dialog"
      aria-label="Project icon and color"
      style={{ width: PANEL_WIDTH }}
      className="max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--surface-primary)] p-2 shadow-lg"
    >
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-label="Search icons"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        placeholder={set ? `Search ${index.length.toLocaleString("en-US")} icons` : "Loading icons"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          virtualizer.scrollToOffset(0);
        }}
        onKeyDown={(e) => {
          const step: Record<string, number> = {
            ArrowRight: 1,
            ArrowLeft: -1,
            ArrowDown: COLUMNS,
            ArrowUp: -COLUMNS,
          };
          if (e.key in step) {
            e.preventDefault();
            move(step[e.key]!);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(results[active]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className="h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none"
      />
      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label="Icons"
        style={{ height: VIEWPORT_HEIGHT }}
        className="mt-1.5 overflow-y-auto"
      >
        {loadError ? (
          <p role="alert" className="px-1 py-2 text-[12px] text-[var(--text-primary)]">
            Could not load the icons. {loadError}
          </p>
        ) : set && results.length === 0 ? (
          <p className="px-1 py-2 text-[12px] text-[var(--text-muted)]">No matching icon</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => (
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
                {results.slice(row.index * COLUMNS, (row.index + 1) * COLUMNS).map((entry, c) => {
                  const i = row.index * COLUMNS + c;
                  return (
                    <div
                      key={entry.name}
                      id={`${listId}-${entry.name}`}
                      role="option"
                      aria-selected={entry.name === value.icon}
                      aria-label={entry.words.join(" ")}
                      title={entry.words.join(" ")}
                      data-icon-name={entry.name}
                      data-active={i === active ? "" : undefined}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(entry);
                      }}
                      style={{ color: projectColorVar(value.color) }}
                      className={`flex cursor-pointer items-center justify-center rounded-md hover:bg-[var(--item-hover-bg)] ${
                        i === active ? "bg-[var(--item-hover-bg)]" : ""
                      } ${entry.name === value.icon ? "ring-1 ring-[var(--border-color)]" : ""}`}
                    >
                      <HugeiconsIcon
                        icon={set![entry.name]!}
                        size={18}
                        strokeWidth={1.75}
                        color="currentColor"
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5" role="group" aria-label="Color">
        {PROJECT_COLORS.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            title={name}
            aria-pressed={value.color === name}
            onClick={() => onChange({ icon: value.icon, color: name }, "color")}
            style={{ background: projectColorVar(name) }}
            className={`size-5 rounded-full outline-offset-2 ${
              value.color === name ? "ring-2 ring-[var(--text-primary)] ring-offset-1" : ""
            }`}
          />
        ))}
        <button
          type="button"
          onClick={() => onChange({ icon: null, color: null }, "reset")}
          className="ml-auto rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
        >
          Reset
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-primary)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The picker as a popover under `anchorRef` (a `relative` wrapper) for a saved project: every
 * choice is written through the projects store (`project.md`, the one write path). An icon or
 * Reset closes it, a color leaves it open. The wrapper stays mounted only while the popover is
 * wanted, so the caller renders it conditionally.
 */
export function ProjectIconPopover({
  projectPath,
  anchorRef,
  onClose,
}: {
  projectPath: string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const value = useProjectAppearance(projectPath);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, anchorRef, onClose);
  const placement = usePopoverPlacement(anchorRef, true, {
    width: PANEL_WIDTH + 16,
    side: "bottom",
    maxHeight: 460,
  });
  return (
    <div ref={ref} style={placement} className="absolute left-0 top-full z-50 mt-1">
      <ProjectIconPicker
        value={value}
        error={error}
        onClose={onClose}
        onChange={(next, kind) => {
          setError(null);
          useProjectsStore
            .getState()
            .setAppearance(projectPath, next)
            .then(
              () => {
                if (kind !== "color") onClose();
              },
              (e: unknown) => setError(describe(e)),
            );
        }}
      />
    </div>
  );
}
