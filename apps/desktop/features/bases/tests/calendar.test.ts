// The calendar view's pure month grid: Monday-first weeks, month arithmetic, rows placed by day.
import { describe, expect, it } from "vite-plus/test";
import {
  dateColumnIndex,
  initialMonth,
  monthGrid,
  monthOfDay,
  rowsByDay,
  shiftMonth,
} from "../web/lib/calendar";
import type { BaseQueryResult } from "../web/lib/types";

const date = (value: string) => ({ type: "date", value, hasTime: false, display: value });
const result = (cells: unknown[]) =>
  ({
    columns: [{ key: "file.name" }, { key: "note.due" }],
    rows: cells.map((c) => ({ cells: [{ type: "text", value: "x" }, c] })),
  }) as unknown as BaseQueryResult;

describe("calendar grid", () => {
  it("starts on Monday and pads to whole weeks", () => {
    const weeks = monthGrid({ year: 2024, month: 3 });
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toEqual({ day: "2024-02-26", inMonth: false });
    expect(weeks[0][4]).toEqual({ day: "2024-03-01", inMonth: true });
    expect(weeks.flat().filter((d) => d.inMonth)).toHaveLength(31);
  });

  it("shifts across years", () => {
    expect(shiftMonth({ year: 2024, month: 12 }, 1)).toEqual({ year: 2025, month: 1 });
    expect(shiftMonth({ year: 2024, month: 1 }, -1)).toEqual({ year: 2023, month: 12 });
  });

  it("places rows by day and ignores cells that are not dates", () => {
    const byDay = rowsByDay(
      result([date("2024-03-15"), { type: "text", value: "no" }, date("2024-03-15")]),
      1,
    );
    expect([...byDay]).toEqual([["2024-03-15", [0, 2]]]);
  });

  it("finds the date column by name, else the last", () => {
    const r = result([]);
    expect(dateColumnIndex(r, { extra: { dateProperty: "due" } } as never)).toBe(1);
    expect(dateColumnIndex(r, undefined)).toBe(1);
  });

  it("opens on today's month, or the nearest month with entries", () => {
    const today = { year: 2024, month: 3 };
    expect(initialMonth(new Map(), today)).toEqual(today);
    expect(initialMonth(new Map([["2024-03-02", [0]]]), today)).toEqual(today);
    expect(initialMonth(new Map([["2024-05-02", [0]]]), today)).toEqual({ year: 2024, month: 5 });
    expect(monthOfDay("nope")).toBeNull();
  });
});
