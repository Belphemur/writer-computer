// The month grid of the `calendar` view (Dataview's CALENDAR, spec `SPECs/dataview-spec.md`).
// Pure: no React, no IPC. Days are `YYYY-MM-DD` text, weeks start on Monday (ISO).
import { canonicalPropertyKey } from "./cells";
import type { BaseQueryResult, BaseView } from "./types";

export interface MonthRef {
  year: number;
  /** 1 to 12. */
  month: number;
}

export interface GridDay {
  /** `YYYY-MM-DD`. */
  day: string;
  inMonth: boolean;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function dayKey(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function monthOfDay(day: string): MonthRef | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(day);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function monthTitle(ref: MonthRef): string {
  return new Date(Date.UTC(ref.year, ref.month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Weeks of a month as rows of seven days, Monday first, padded with the days around it. */
export function monthGrid({ year, month }: MonthRef): GridDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const total = Math.ceil((lead + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7) * 7;
  const days: GridDay[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    const day = dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    days.push({ day, inMonth: d.getUTCMonth() === month - 1 });
  }
  const weeks: GridDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** The option naming the date column (`dateProperty`, written by the DQL lowering). */
export function dateColumnIndex(
  result: Pick<BaseQueryResult, "columns">,
  view: BaseView | undefined,
): number {
  const wanted = view?.extra?.dateProperty;
  if (typeof wanted === "string") {
    const key = canonicalPropertyKey(wanted);
    const at = result.columns.findIndex((c) => c.key === key);
    if (at >= 0) return at;
  }
  return Math.max(0, result.columns.length - 1);
}

/** Row indexes by day, for the rows whose date column holds a date. */
export function rowsByDay(result: BaseQueryResult, column: number): Map<string, number[]> {
  const byDay = new Map<string, number[]>();
  result.rows.forEach((row, i) => {
    const cell = row.cells[column];
    if (!cell || cell.type !== "date" || typeof cell.value !== "string") return;
    const day = cell.value.slice(0, 10);
    if (!monthOfDay(day)) return;
    const list = byDay.get(day);
    if (list) list.push(i);
    else byDay.set(day, [i]);
  });
  return byDay;
}

/** The month to open on: today's when it has entries or there are none, else the nearest entry. */
export function initialMonth(byDay: ReadonlyMap<string, number[]>, today: MonthRef): MonthRef {
  const months = [...byDay.keys()]
    .map(monthOfDay)
    .filter((m): m is MonthRef => m !== null)
    .map((m) => m.year * 12 + m.month - 1);
  if (months.length === 0) return today;
  const here = today.year * 12 + today.month - 1;
  if (months.includes(here)) return today;
  const nearest = months.reduce((a, b) => (Math.abs(b - here) < Math.abs(a - here) ? b : a));
  return { year: Math.floor(nearest / 12), month: (nearest % 12) + 1 };
}
