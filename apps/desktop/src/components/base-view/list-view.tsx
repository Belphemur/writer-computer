import { Fragment, useMemo } from "react";
import {
  GROUP_HEADER_HEIGHT,
  LIST_LINE_HEIGHT,
  listItems,
  listOptions,
  listRowLines,
  markerText,
  sectionsOf,
  type ListItem,
  type ListOptions,
} from "@/lib/bases/collections";
import type { Cell, Column } from "@/lib/bases/types";
import type { BaseViewProps, ViewActions } from "@/lib/bases/view-registry";
import { CellView } from "./cell-view";
import { GroupHeader } from "./group-header";
import { useGroupCollapse } from "./use-group-collapse";
import { WindowedList } from "./windowed-list";

const NOOP = () => {};
const READ_ONLY = "Edit cells in the table view";

const isEmptyCell = (cell: Cell | undefined) => !cell || cell.type === "null";

function Value({
  cell,
  column,
  rowPath,
  actions,
}: {
  cell: Cell;
  column: Column;
  rowPath: string;
  actions: ViewActions;
}) {
  return (
    <CellView
      cell={cell}
      columnKey={column.key}
      rowPath={rowPath}
      readOnlyReason={READ_ONLY}
      actions={actions}
      onToggle={NOOP}
    />
  );
}

function Row({
  item,
  rowPath,
  cells,
  columns,
  options,
  actions,
}: {
  item: Extract<ListItem, { kind: "row" }>;
  rowPath: string;
  cells: readonly Cell[];
  columns: readonly Column[];
  options: ListOptions;
  actions: ViewActions;
}) {
  const marker = markerText(options.markers, item.ordinal);
  const others = columns
    .map((column, i) => ({ column, cell: cells[i] }))
    .slice(1)
    .filter((o) => !isEmptyCell(o.cell));
  return (
    <div
      data-list-row={rowPath}
      className="px-3 text-[13px] text-text-primary"
      style={{ height: "100%" }}
    >
      <div className="flex items-center gap-2 overflow-hidden" style={{ height: LIST_LINE_HEIGHT }}>
        {marker ? (
          <span
            data-list-marker
            aria-hidden="true"
            className="w-6 shrink-0 text-right text-text-muted"
          >
            {marker}
          </span>
        ) : null}
        <span className="flex min-w-0 items-center overflow-hidden">
          {cells[0] ? (
            <Value cell={cells[0]} column={columns[0]!} rowPath={rowPath} actions={actions} />
          ) : null}
          {!options.indent
            ? others.map((o) => (
                <Fragment key={o.column.key}>
                  <span data-list-separator className="whitespace-pre text-text-muted">
                    {options.separator}
                  </span>
                  <Value cell={o.cell!} column={o.column} rowPath={rowPath} actions={actions} />
                </Fragment>
              ))
            : null}
        </span>
      </div>
      {options.indent
        ? others.map((o) => (
            <div
              key={o.column.key}
              data-list-nested
              className="flex items-center gap-1.5 overflow-hidden text-[12px]"
              style={{ height: LIST_LINE_HEIGHT, paddingLeft: marker ? 32 : 8 }}
            >
              <span className="shrink-0 text-text-muted">{o.column.displayName}</span>
              <Value cell={o.cell!} column={o.column} rowPath={rowPath} actions={actions} />
            </div>
          ))
        : null}
    </div>
  );
}

/** The registered `list` view: one line per file, properties inline or indented, with groups. */
export function ListView({ result, shown, view, actions, label }: BaseViewProps) {
  const options = useMemo(() => listOptions(view), [view]);
  const { collapsed, toggle } = useGroupCollapse(view?.name ?? "");
  const columns = useMemo(
    () => result.columns.slice(0, Math.max(1, shown)),
    [result.columns, shown],
  );

  const layout = useMemo(() => {
    try {
      const sections = sectionsOf(result);
      const linesOf = (row: number) => {
        const cells = result.rows[row]!.cells;
        let others = 0;
        for (let c = 1; c < columns.length; c++) if (!isEmptyCell(cells[c])) others++;
        return listRowLines(options, others);
      };
      return { items: listItems(sections, collapsed, linesOf) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [result, columns.length, options, collapsed]);

  if ("error" in layout)
    return (
      <div
        role="alert"
        data-base-error
        className="px-4 py-3 text-[13px] text-[var(--danger,#e5484d)]"
      >
        The query result could not be displayed: {layout.error}
      </div>
    );
  if (layout.items.length === 0)
    return (
      <div data-empty className="px-3 py-6 text-[13px] text-text-muted">
        No results
      </div>
    );

  return (
    <WindowedList<ListItem>
      items={layout.items}
      label={label}
      marker="data-base-list"
      heightOf={(item) =>
        item.kind === "group" ? GROUP_HEADER_HEIGHT : item.lines * LIST_LINE_HEIGHT
      }
      keyOf={(item) => (item.kind === "group" ? `g:${item.key}` : `r:${item.row}`)}
      render={(item) => {
        if (item.kind === "group") return <GroupHeader item={item} onToggle={toggle} />;
        const row = result.rows[item.row]!;
        return (
          <Row
            item={item}
            rowPath={row.path}
            cells={row.cells}
            columns={columns}
            options={options}
            actions={actions}
          />
        );
      }}
    />
  );
}
