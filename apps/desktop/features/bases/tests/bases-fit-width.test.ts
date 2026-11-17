// Fit-to-content width of a table column: pure function with a stubbed measurer.
import { describe, expect, it } from "vite-plus/test";
import {
  CELL_CHROME,
  FIT_MAX_COLUMN_WIDTH,
  FIT_MEASURE_LIMIT,
  fitColumnWidth,
  type Measure,
} from "../web/lib/fit-width";
import { MIN_COLUMN_WIDTH } from "../web/lib/grid";
import { bool, err, list, nul, num, str } from "./helpers/bases-fixtures";

/** 10px per character in every font, so expectations are exact. */
const measure: Measure = (text) => text.length * 10;
const fit = (extra: Partial<Parameters<typeof fitColumnWidth>[0]> = {}) =>
  fitColumnWidth({ header: "Name", cells: [], measure, ...extra });

describe("fitColumnWidth", () => {
  it("uses the header when it is the widest, plus chrome", () => {
    expect(fit({ header: "Description", cells: [str("ab")] })).toBe(110 + CELL_CHROME);
  });

  it("uses the widest cell over every row", () => {
    expect(fit({ cells: [str("ab"), str("a long cell value"), nul(), undefined] })).toBe(
      170 + CELL_CHROME,
    );
  });

  it("adds the sort marker and grouped tag to the header", () => {
    expect(fit({ header: "Status", sortMarker: "↑2" })).toBe(60 + 4 + 20 + CELL_CHROME);
    expect(fit({ header: "Status", grouped: true })).toBe(60 + 4 + 70 + CELL_CHROME);
  });

  it("includes summary label and value", () => {
    expect(fit({ summary: { label: "Sum", values: ["12345", "1"] } })).toBe(
      30 + 6 + 50 + CELL_CHROME,
    );
  });

  it("measures checkboxes, lists and errors by their rendering", () => {
    expect(fit({ header: "x", cells: [bool(true)] })).toBe(MIN_COLUMN_WIDTH); // 14 + chrome is below the minimum;
    // two chips: (10+20) + (10+20) with one trailing gap removed.
    expect(fit({ header: "x", cells: [list("a", "b")] })).toBe(10 + 20 + 10 + 20 - 4 + CELL_CHROME);
    expect(fit({ header: "x", cells: [err("bad")] })).toBe(
      `! Error: bad`.length * 10 + 12 + CELL_CHROME,
    );
    expect(fit({ header: "", cells: [num(12345)] })).toBe(50 + CELL_CHROME);
  });

  it("clamps to the minimum and to the fit maximum", () => {
    expect(fit({ header: "", cells: [] })).toBe(MIN_COLUMN_WIDTH);
    expect(fit({ cells: [str("x".repeat(500))] })).toBe(FIT_MAX_COLUMN_WIDTH);
  });

  it("measures only the longest cells of a huge result but still finds the widest", () => {
    const calls: string[] = [];
    const counting: Measure = (t) => (calls.push(t), t.length * 10);
    const cells = Array.from({ length: 5000 }, (_, i) => str(i === 4321 ? "w".repeat(30) : "ab"));
    const width = fitColumnWidth({ header: "H", cells, measure: counting });
    expect(width).toBe(300 + CELL_CHROME);
    expect(calls.length).toBeLessThanOrEqual(FIT_MEASURE_LIMIT + 1);
  });
});
