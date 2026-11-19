import { useMemo, useState } from "react";
import {
  dateColumnIndex,
  initialMonth,
  monthGrid,
  monthTitle,
  rowsByDay,
  shiftMonth,
  type MonthRef,
} from "../lib/calendar";
import type { BaseViewProps } from "../lib/view-registry";
import { CellView } from "./cell-view";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NOOP = () => {};
const READ_ONLY = "Edit cells in the table view";

function thisMonth(): MonthRef {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

const navButton =
  "cursor-pointer rounded-md bg-transparent px-2 py-1 text-[12px] text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary";

/** A month grid: each row of the result sits on the day its date column holds. The first column
 *  is the entry's label (a link when it is one); rows without a date are not shown. */
export function CalendarView({ result, view, actions }: BaseViewProps) {
  const column = dateColumnIndex(result, view);
  const byDay = useMemo(() => rowsByDay(result, column), [result, column]);
  const [month, setMonth] = useState<MonthRef>(() => initialMonth(byDay, thisMonth()));
  const weeks = useMemo(() => monthGrid(month), [month]);
  const labelColumn = 0;
  const undated = result.rows.length - [...byDay.values()].reduce((n, rows) => n + rows.length, 0);
  return (
    <div data-calendar-view className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-1 px-3 py-2">
        <span data-calendar-title className="mr-2 text-[13px] font-medium text-text-primary">
          {monthTitle(month)}
        </span>
        <button
          type="button"
          aria-label="Previous month"
          className={navButton}
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          Prev
        </button>
        <button type="button" className={navButton} onClick={() => setMonth(thisMonth())}>
          Today
        </button>
        <button
          type="button"
          aria-label="Next month"
          className={navButton}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          Next
        </button>
        {undated > 0 ? (
          <span data-calendar-undated className="ml-auto text-[12px] text-text-muted">
            {undated} without a date
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-7 border-t border-[var(--line-subtler)] text-[11px] text-text-muted">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 border-t border-l border-[var(--line-subtler)]">
        {weeks.flat().map(({ day, inMonth }) => {
          const rows = byDay.get(day) ?? [];
          return (
            <div
              key={day}
              data-calendar-day={day}
              data-in-month={inMonth}
              className={`flex min-h-[72px] min-w-0 flex-col gap-0.5 border-r border-b border-[var(--line-subtler)] px-1.5 py-1 text-[12px] ${
                inMonth ? "text-text-primary" : "text-text-muted opacity-60"
              }`}
            >
              <span className="text-[11px] text-text-muted">{Number(day.slice(8))}</span>
              {rows.map((i) => {
                const row = result.rows[i]!;
                const cell = row.cells[labelColumn];
                return cell ? (
                  <div key={i} data-calendar-entry className="min-w-0 truncate">
                    <CellView
                      cell={cell}
                      columnKey={result.columns[labelColumn]?.key ?? ""}
                      rowPath={row.path}
                      readOnlyReason={READ_ONLY}
                      actions={actions}
                      onToggle={NOOP}
                    />
                  </div>
                ) : null;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
