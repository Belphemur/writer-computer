import { memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ariaSort,
  buildGridLayout,
  columnWidths,
  GROUP_HEADER_HEIGHT,
  itemHeight,
  rowHeightPx,
  sortIndicators,
  type GridItem,
  type GridLayout,
} from "@/lib/bases/grid";
import type { EditKind } from "@/lib/bases/cells";
import type { BaseQueryResult, BaseView, Cell, Column } from "@/lib/bases/types";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/lib/bases/grid";
import { fitColumnWidth } from "@/lib/bases/fit-width";
import { createMeasure } from "./measure-text";
import type { ViewConfig } from "@/lib/bases/view-registry";
import { CellEditor } from "./cell-editor";
import { CellView, type CellActions } from "./cell-view";
import type { CellRange, useBaseEdits } from "./use-base-edits";
import { useGroupCollapse } from "./use-group-collapse";
import { useStickyGroups } from "./use-sticky-groups";

export const HEADER_HEIGHT = 32;
const OVERSCAN = 8;

/** Shown when a row has fewer cells than the result has columns (a backend contract violation). */
const MISSING_CELL: Cell = {
  type: "error",
  value: { kind: "Contract", message: "The query result has no value for this cell" },
  display: "",
};

type Edits = ReturnType<typeof useBaseEdits>;

interface Position {
  /** Vault-relative path of the row (stable across requeries). */
  path: string;
  col: number;
}
interface Selection {
  anchor: Position;
  focus: Position;
}
interface Editing {
  path: string;
  col: number;
  kind: EditKind;
  raw: unknown;
}

interface Props {
  result: BaseQueryResult;
  view: BaseView | undefined;
  edits: Edits;
  actions: CellActions;
  config: ViewConfig;
  label: string;
}

/** Widths dragged by the user, valid until the view they were dragged on changes (a reload). */
interface WidthOverrides {
  view: BaseView | undefined;
  widths: ReadonlyMap<string, number>;
}

function itemKey(item: GridItem): string {
  if (item.kind === "row") return `r:${item.row}`;
  if (item.kind === "group") return `g:${item.key}`;
  return `s:${item.groupIndex}`;
}

function SummaryCells({
  columns,
  widths,
  summaries,
}: {
  columns: readonly Column[];
  widths: readonly number[];
  summaries: readonly (Cell | null)[];
}) {
  return (
    <>
      {columns.map((column, c) => {
        const summary = summaries[c];
        return (
          <div
            key={column.key}
            role="gridcell"
            aria-colindex={c + 1}
            data-summary-cell
            style={{ width: widths[c] }}
            className="flex shrink-0 items-center gap-1.5 truncate px-2 text-[11px] text-text-muted"
          >
            {summary ? (
              <>
                <span>{column.summary}</span>
                <span className="font-medium tabular-nums text-text-secondary">
                  {summary.type === "error" ? "Error" : summary.display}
                </span>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

interface GridCellProps {
  id: string;
  rowIndex: number;
  colIndex: number;
  column: Column;
  cell: Cell;
  rowPath: string;
  width: number;
  selected: boolean;
  inRange: boolean;
  /** Reason shown as the tooltip, only computed for the focused cell and checkboxes. */
  readOnlyReason: string | null;
  editing: Editing | null;
  actions: CellActions;
  onPointerSelect: (rowIndex: number, colIndex: number, extend: boolean) => void;
  onBeginEdit: (rowIndex: number, colIndex: number) => void;
  onToggle: (rowIndex: number, colIndex: number) => void;
  onCommit: (value: { text: string } | { items: string[] }) => boolean;
  onCancel: () => void;
}

const GridCell = memo(function GridCell(p: GridCellProps) {
  const { cell } = p;
  const isError = cell.type === "error";
  return (
    <div
      id={p.id}
      role="gridcell"
      aria-colindex={p.colIndex + 1}
      aria-selected={p.selected || p.inRange}
      aria-readonly={p.readOnlyReason !== null ? true : undefined}
      data-selected={p.selected || undefined}
      data-cell-type={cell.type}
      title={p.selected && p.readOnlyReason ? p.readOnlyReason : undefined}
      style={{ width: p.width }}
      onMouseDown={(e) => {
        if (p.editing) return;
        p.onPointerSelect(p.rowIndex, p.colIndex, e.shiftKey);
      }}
      onDoubleClick={() => p.onBeginEdit(p.rowIndex, p.colIndex)}
      className={`flex h-full shrink-0 items-center overflow-hidden border-r border-[var(--line-subtler)] text-[13px] text-text-primary ${
        p.editing ? "p-0" : "px-2"
      } ${p.inRange ? "bg-[var(--surface-selected)]" : ""} ${
        p.selected ? "ring-1 ring-inset ring-[var(--focus-border)]" : ""
      } ${isError ? "bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]" : ""}`}
    >
      {p.editing ? (
        <CellEditor
          kind={p.editing.kind}
          raw={p.editing.raw}
          onCommit={p.onCommit}
          onCancel={p.onCancel}
        />
      ) : (
        <CellView
          cell={cell}
          columnKey={p.column.key}
          rowPath={p.rowPath}
          readOnlyReason={p.readOnlyReason}
          actions={p.actions}
          onToggle={() => p.onToggle(p.rowIndex, p.colIndex)}
        />
      )}
    </div>
  );
});

/**
 * The virtualized, editable grid of one query result. Header clicks and column drags go to
 * `config` (they persist into the `.base`); sort and group markers come from the view. Keyboard navigation with the focus kept on the grid element and
 * `aria-activedescendant` pointing at the current cell (cells come and go with the window).
 */
export function BaseTable({ result, view, edits, actions, config, label }: Props) {
  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { collapsed, toggle: toggleGroup } = useGroupCollapse(view?.name ?? "");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const { probeRow, beginEdit: beginCellEdit, toggleCheckbox, notify } = edits;
  const { columns, rows } = result;
  const [dragged, setDragged] = useState<WidthOverrides>({ view, widths: new Map() });
  const baseWidths = useMemo(() => columnWidths(columns, view), [columns, view]);
  const widths = useMemo(() => {
    if (dragged.view !== view) return baseWidths;
    return baseWidths.map((w, i) => dragged.widths.get(columns[i]!.key) ?? w);
  }, [baseWidths, dragged, view, columns]);
  const totalWidth = useMemo(() => widths.reduce((a, b) => a + b, 0), [widths]);
  const rowHeight = rowHeightPx(view);
  const markers = useMemo(() => sortIndicators(view), [view]);

  const layout = useMemo<GridLayout | { error: string }>(() => {
    try {
      return buildGridLayout(result, collapsed);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [result, collapsed]);
  const grid = "error" in layout ? null : layout;

  const rowIndexByPath = useMemo(() => new Map(rows.map((r, i) => [r.path, i])), [rows]);
  const positionOfRow = useMemo(() => {
    const pos = Array.from({ length: rows.length }, () => -1);
    grid?.visibleRows.forEach((r, i) => (pos[r] = i));
    return pos;
  }, [grid, rows.length]);

  const items = grid?.items ?? [];
  const showFooter = !result.groups && result.summaries.some((s) => s !== null);
  const { rangeExtractor, activeRef } = useStickyGroups(items);
  const virtualizer = useVirtualizer({
    count: items.length,
    rangeExtractor,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => itemHeight(items[i]!, rowHeight),
    getItemKey: (i) => itemKey(items[i]!),
    overscan: OVERSCAN,
    scrollMargin: HEADER_HEIGHT,
    // Keyboard reveal must not park a row under the sticky column header or the pinned group header.
    scrollPaddingStart: HEADER_HEIGHT + (result.groups ? GROUP_HEADER_HEIGHT : 0),
  });

  // ---- fit to content -----------------------------------------------------

  /** Double-click on a divider: size the column to its widest header, cell or summary. */
  const fitColumn = (c: number) => {
    const grid_ = scrollRef.current;
    const column = columns[c];
    if (!grid_ || !column) return;
    const values: string[] = [];
    const addSummary = (cell: Cell | null | undefined) => {
      if (cell) values.push(cell.type === "error" ? "Error" : cell.display);
    };
    if (showFooter) addSummary(result.summaries[c]);
    for (const item of items) if (item.kind === "group-summary") addSummary(item.summaries[c]);
    const indicator = markers.sort.get(column.key);
    const width = fitColumnWidth({
      header: column.displayName,
      sortMarker: indicator
        ? `${indicator.direction === "ASC" ? "↑" : "↓"}${indicator.of > 1 ? indicator.priority : ""}`
        : undefined,
      grouped: markers.groupBy === column.key,
      cells: (function* () {
        for (let r = 0; r < rows.length; r++) yield edits.cellAt(r, c);
      })(),
      summary: values.length > 0 ? { label: column.summary ?? "", values } : undefined,
      measure: createMeasure(grid_),
    });
    if (width === widths[c]) return;
    setDragged((d) => ({
      view,
      widths: new Map(d.view === view ? d.widths : []).set(column.key, width),
    }));
    config.setColumnWidth(column.id, width);
  };

  // ---- selection ----------------------------------------------------------

  const resolve = useCallback(
    (p: Position | undefined) => {
      if (!p) return null;
      const row = rowIndexByPath.get(p.path);
      if (row === undefined || positionOfRow[row]! < 0 || p.col >= columns.length) return null;
      return { row, pos: positionOfRow[row]!, col: p.col };
    },
    [rowIndexByPath, positionOfRow, columns.length],
  );
  const anchor = resolve(selection?.anchor);
  const focus = resolve(selection?.focus);
  const range = useMemo(() => {
    if (!anchor || !focus || !grid) return null;
    const p0 = Math.min(anchor.pos, focus.pos);
    const p1 = Math.max(anchor.pos, focus.pos);
    return {
      posStart: p0,
      posEnd: p1,
      colStart: Math.min(anchor.col, focus.col),
      colEnd: Math.max(anchor.col, focus.col),
    };
  }, [anchor, focus, grid]);

  const cellId = (rowIndex: number, colIndex: number) => `${gridId}-r${rowIndex}-c${colIndex}`;

  const focusGrid = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), []);

  const revealCell = useCallback(
    (rowIndex: number, colIndex: number) => {
      const el = scrollRef.current;
      if (!el || !grid) return;
      const itemIndex = grid.itemIndexOfRow[rowIndex]!;
      if (itemIndex >= 0) virtualizer.scrollToIndex(itemIndex, { align: "auto" });
      let left = 0;
      for (let i = 0; i < colIndex; i++) left += widths[i]!;
      const right = left + widths[colIndex]!;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [grid, virtualizer, widths],
  );

  const select = useCallback(
    (rowIndex: number, colIndex: number, extend: boolean) => {
      const row = rows[rowIndex];
      if (!row) return;
      const position = { path: row.path, col: colIndex };
      setSelection((s) =>
        extend && s ? { anchor: s.anchor, focus: position } : { anchor: position, focus: position },
      );
      probeRow(rowIndex);
      focusGrid();
    },
    [probeRow, focusGrid, rows],
  );

  const moveFocus = useCallback(
    (dPos: number, dCol: number, extend: boolean) => {
      if (!grid || grid.visibleRows.length === 0) return;
      const from = focus ?? { pos: 0, col: 0, row: grid.visibleRows[0]! };
      const pos = Math.max(0, Math.min(grid.visibleRows.length - 1, from.pos + dPos));
      const col = Math.max(0, Math.min(columns.length - 1, from.col + dCol));
      const rowIndex = grid.visibleRows[pos]!;
      if (!focus) {
        select(rowIndex, col, false);
      } else {
        select(rowIndex, col, extend);
      }
      revealCell(rowIndex, col);
    },
    [columns.length, focus, grid, revealCell, select],
  );

  // ---- editing ------------------------------------------------------------

  const beginEdit = useCallback(
    async (rowIndex: number, colIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      const begun = await beginCellEdit(rowIndex, colIndex);
      if (!begun.ok) {
        notify("error", begun.reason);
        return;
      }
      if (begun.kind === "checkbox") {
        toggleCheckbox(rowIndex, colIndex);
        return;
      }
      setEditing({ path: row.path, col: colIndex, kind: begun.kind, raw: begun.raw });
    },
    [beginCellEdit, notify, toggleCheckbox, rows],
  );

  const editingRow = editing ? rowIndexByPath.get(editing.path) : undefined;
  const commit = useCallback(
    (value: { text: string } | { items: string[] }) => {
      if (!editing || editingRow === undefined) return true;
      const ok =
        "text" in value
          ? edits.commitText(editingRow, editing.col, editing.kind, value.text)
          : edits.commitList(editingRow, editing.col, value.items);
      if (ok) {
        setEditing(null);
        focusGrid();
      }
      return ok;
    },
    [edits, editing, editingRow, focusGrid],
  );
  const cancel = useCallback(() => {
    setEditing(null);
    focusGrid();
  }, [focusGrid]);

  const toggle = toggleCheckbox;

  // ---- keyboard, clipboard --------------------------------------------------

  /** The selection as data-row indices (visible rows only) and a column span. */
  const selectedRange = (): CellRange | null => {
    if (!range || !grid) return null;
    return {
      rows: grid.visibleRows.slice(range.posStart, range.posEnd + 1),
      colStart: range.colStart,
      colEnd: range.colEnd,
    };
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(mod ? Number.MAX_SAFE_INTEGER : 1, 0, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(mod ? -Number.MAX_SAFE_INTEGER : -1, 0, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(0, mod ? Number.MAX_SAFE_INTEGER : 1, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(0, mod ? -Number.MAX_SAFE_INTEGER : -1, e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        moveFocus(mod ? -Number.MAX_SAFE_INTEGER : 0, -Number.MAX_SAFE_INTEGER, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        moveFocus(mod ? Number.MAX_SAFE_INTEGER : 0, Number.MAX_SAFE_INTEGER, e.shiftKey);
        return;
      case "PageDown":
        e.preventDefault();
        moveFocus(10, 0, e.shiftKey);
        return;
      case "PageUp":
        e.preventDefault();
        moveFocus(-10, 0, e.shiftKey);
        return;
      case "Enter":
      case "F2": {
        if (!focus) return;
        e.preventDefault();
        if (mod && e.key === "Enter") {
          const cell = edits.cellAt(focus.row, focus.col);
          if (cell?.type === "link") actions.openLink(cell.value);
          else if (cell?.type === "file") actions.openFile(cell.value);
          else if (columns[focus.col]?.key === "file.name") actions.openFile(rows[focus.row]!.path);
          return;
        }
        void beginEdit(focus.row, focus.col);
        return;
      }
      case " ": {
        if (!focus) return;
        const cell = edits.cellAt(focus.row, focus.col);
        if (cell?.type === "boolean") {
          e.preventDefault();
          edits.toggleCheckbox(focus.row, focus.col);
        }
        return;
      }
      case "Backspace":
      case "Delete": {
        const selected = selectedRange();
        if (!selected) return;
        e.preventDefault();
        edits.clearRange(selected);
        return;
      }
      case "Escape":
        if (
          selection &&
          range &&
          (range.posStart !== range.posEnd || range.colStart !== range.colEnd)
        ) {
          e.preventDefault();
          setSelection((s) => (s ? { anchor: s.focus, focus: s.focus } : s));
        } else if (edits.notice) {
          edits.dismissNotice();
        }
        return;
      case "z":
      case "Z":
        if (!mod) return;
        e.preventDefault();
        if (e.shiftKey) edits.redo();
        else edits.undo();
        return;
      case "y":
        if (!e.ctrlKey) return;
        e.preventDefault();
        edits.redo();
        return;
      default:
    }
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    const r = selectedRange();
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", edits.copyText(r));
  };
  const onCut = (e: React.ClipboardEvent) => {
    if (editing) return;
    const r = selectedRange();
    if (!r) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", edits.copyText(r));
    edits.clearRange(r);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || !focus || !range || !grid) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    edits.pasteText(text, grid.visibleRows, range.posStart, range.colStart);
  };

  // ---- render ---------------------------------------------------------------

  if (!grid) {
    return (
      <div role="alert" data-base-error className="px-4 py-3 text-[13px] text-[var(--danger)]">
        The query result could not be displayed: {(layout as { error: string }).error}
      </div>
    );
  }

  // `getVirtualItems` runs the range extractor, which sets the active group header.
  const virtualItems = virtualizer.getVirtualItems();
  const pinned = virtualItems.some((vi) => vi.index === activeRef.current)
    ? activeRef.current
    : null;
  const rowCount = items.length + 1 + (showFooter ? 1 : 0);
  const activeId = focus ? cellId(focus.row, focus.col) : undefined;
  const focusedReason = focus ? edits.readOnlyReason(focus.row, focus.col) : null;

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label={label}
      aria-rowcount={rowCount}
      aria-colcount={columns.length}
      aria-multiselectable="true"
      aria-activedescendant={activeId}
      data-base-grid
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
      className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--focus-border)]"
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        <div
          role="row"
          aria-rowindex={1}
          style={{ height: HEADER_HEIGHT, width: totalWidth }}
          className="sticky top-0 z-10 flex border-b border-border bg-surface-primary"
        >
          {columns.map((column, c) => {
            const indicator = markers.sort.get(column.key);
            return (
              <div
                key={column.key}
                role="columnheader"
                aria-colindex={c + 1}
                aria-sort={ariaSort(indicator)}
                title={
                  column.displayName === column.key
                    ? column.key
                    : `${column.displayName} (${column.key})`
                }
                style={{ width: widths[c] }}
                className="relative flex shrink-0 items-center gap-1 overflow-hidden border-r border-[var(--line-subtler)] px-2 text-[12px] font-medium text-text-secondary"
              >
                <button
                  type="button"
                  data-sort-toggle
                  aria-label={`Sort by ${column.displayName}`}
                  onClick={(e) => config.cycleSort(column.id, e.shiftKey)}
                  className="min-w-0 flex-1 cursor-pointer truncate bg-transparent p-0 text-left text-[12px] font-medium text-text-secondary hover:text-text-primary"
                >
                  {column.displayName}
                </button>
                {indicator ? (
                  <span aria-hidden="true" data-sort-indicator className="text-text-muted">
                    {indicator.direction === "ASC" ? "↑" : "↓"}
                    {indicator.of > 1 ? indicator.priority : ""}
                  </span>
                ) : null}
                {markers.groupBy === column.key ? (
                  <span data-group-indicator className="text-[10px] text-text-muted">
                    grouped
                  </span>
                ) : null}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${column.displayName}`}
                  data-resize-handle
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startWidth = widths[c]!;
                    const target = e.currentTarget;
                    target.setPointerCapture?.(e.pointerId);
                    let width = startWidth;
                    const move = (ev: PointerEvent) => {
                      width = Math.min(
                        MAX_COLUMN_WIDTH,
                        Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + ev.clientX - startX)),
                      );
                      setDragged((d) => ({
                        view,
                        widths: new Map(d.view === view ? d.widths : []).set(column.key, width),
                      }));
                    };
                    const up = () => {
                      target.removeEventListener("pointermove", move);
                      target.removeEventListener("pointerup", up);
                      target.removeEventListener("pointercancel", up);
                      if (width !== startWidth) config.setColumnWidth(column.id, width);
                    };
                    target.addEventListener("pointermove", move);
                    target.addEventListener("pointerup", up);
                    target.addEventListener("pointercancel", up);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    fitColumn(c);
                  }}
                  title="Drag to resize, double-click to fit the content"
                  className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-[var(--focus-border)]"
                />
              </div>
            );
          })}
        </div>

        {items.length === 0 ? (
          <div role="row" aria-rowindex={2}>
            <div
              role="gridcell"
              aria-colspan={Math.max(1, columns.length)}
              data-empty
              className="px-3 py-6 text-[13px] text-text-muted"
            >
              No results
            </div>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((vi) => {
              const item = items[vi.index]!;
              const top = vi.start - HEADER_HEIGHT;
              const isPinned = vi.index === pinned;
              const common = {
                role: "row" as const,
                "aria-rowindex": vi.index + 2,
                style: isPinned
                  ? {
                      // The pinned group header sits in flow and sticks under the column header.
                      position: "sticky" as const,
                      top: HEADER_HEIGHT,
                      zIndex: 5,
                      width: totalWidth,
                      height: vi.size,
                      // --surface-subtle is translucent: paint it over an opaque base so rows
                      // scrolling underneath do not show through.
                      backgroundColor: "var(--surface-primary)",
                      backgroundImage:
                        "linear-gradient(var(--surface-subtle), var(--surface-subtle))",
                    }
                  : {
                      position: "absolute" as const,
                      top: 0,
                      left: 0,
                      width: totalWidth,
                      height: vi.size,
                      transform: `translateY(${top}px)`,
                    },
              };
              if (item.kind === "group") {
                return (
                  <div
                    key={vi.key}
                    {...common}
                    data-group-header
                    data-sticky-group={isPinned ? "" : undefined}
                    className={`flex ${isPinned ? "border-b border-border" : ""} bg-[var(--surface-subtle)]`}
                  >
                    <div
                      role="gridcell"
                      aria-colspan={Math.max(1, columns.length)}
                      aria-expanded={!item.collapsed}
                      className="sticky left-0 flex items-center"
                    >
                      <button
                        type="button"
                        aria-label={`${item.collapsed ? "Expand" : "Collapse"} group ${item.label}`}
                        aria-expanded={!item.collapsed}
                        onClick={() => toggleGroup(item.key)}
                        className="flex cursor-pointer items-center gap-2 bg-transparent px-2 text-[13px] font-medium text-text-primary"
                      >
                        <span aria-hidden="true" className="w-3 text-text-muted">
                          {item.collapsed ? "▸" : "▾"}
                        </span>
                        <span>{item.label}</span>
                        <span data-group-count className="text-[11px] font-normal text-text-muted">
                          {item.count}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              }
              if (item.kind === "group-summary") {
                return (
                  <div
                    key={vi.key}
                    {...common}
                    data-group-summary
                    className="flex border-b border-[var(--line-subtler)]"
                  >
                    <SummaryCells columns={columns} widths={widths} summaries={item.summaries} />
                  </div>
                );
              }
              const rowIndex = item.row;
              const row = rows[rowIndex]!;
              const inRowRange =
                range !== null &&
                positionOfRow[rowIndex]! >= range.posStart &&
                positionOfRow[rowIndex]! <= range.posEnd;
              return (
                <div
                  key={vi.key}
                  {...common}
                  data-row-path={row.path}
                  className="flex border-b border-[var(--line-subtler)] hover:bg-[var(--item-hover-bg)]"
                >
                  {columns.map((column, c) => {
                    const cell = edits.cellAt(rowIndex, c) ?? MISSING_CELL;
                    const isFocus = focus?.row === rowIndex && focus.col === c;
                    return (
                      <GridCell
                        key={column.key}
                        id={cellId(rowIndex, c)}
                        rowIndex={rowIndex}
                        colIndex={c}
                        column={column}
                        cell={cell}
                        rowPath={row.path}
                        width={widths[c]!}
                        selected={isFocus}
                        inRange={inRowRange && c >= range.colStart && c <= range.colEnd && !isFocus}
                        readOnlyReason={
                          isFocus
                            ? focusedReason
                            : cell.type === "boolean"
                              ? edits.readOnlyReason(rowIndex, c)
                              : null
                        }
                        editing={
                          editing && editing.path === row.path && editing.col === c ? editing : null
                        }
                        actions={actions}
                        onPointerSelect={select}
                        onBeginEdit={beginEdit}
                        onToggle={toggle}
                        onCommit={commit}
                        onCancel={cancel}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {showFooter ? (
          <div
            role="row"
            aria-rowindex={items.length + 2}
            data-summary-row
            style={{ height: rowHeight, width: totalWidth }}
            className="sticky bottom-0 z-10 flex border-t border-border bg-surface-primary"
          >
            <SummaryCells columns={columns} widths={widths} summaries={result.summaries} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
