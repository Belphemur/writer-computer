import { describe, expect, test } from "vite-plus/test";
import {
  HEADER_ROW,
  cellAtOffset,
  deleteColumn,
  deleteRow,
  detectDelimiter,
  displayWidth,
  duplicateRow,
  escapeCell,
  findTableBounds,
  formatTable,
  insertColumn,
  insertRow,
  layoutTable,
  moveColumn,
  moveRow,
  parseDelimited,
  parseLooseTable,
  parseTable,
  plainCellText,
  scanRow,
  setAlignment,
  sortRows,
  tableFromDelimited,
  tableFromGrid,
  transpose,
  type MarkdownTable,
} from "../web/markdown-table";

function table(src: string): MarkdownTable {
  const t = parseTable(src.split("\n"));
  if (!t) throw new Error("not a table");
  return t;
}
const fmt = (t: MarkdownTable) => formatTable(t).join("\n");

describe("displayWidth", () => {
  test("ascii, CJK, emoji, combining", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("🇫🇷")).toBe(2);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("a日b")).toBe(4);
    expect(displayWidth("©")).toBe(1);
  });
});

describe("scanRow", () => {
  test("optional outer pipes and escaped pipes", () => {
    expect(scanRow("| a | b |").map((c) => c.text)).toEqual(["a", "b"]);
    expect(scanRow("a | b").map((c) => c.text)).toEqual(["a", "b"]);
    expect(scanRow("| a \\| b | c |").map((c) => c.text)).toEqual(["a \\| b", "c"]);
    expect(scanRow("| a | b \\|").map((c) => c.text)).toEqual(["a", "b \\|"]);
    expect(scanRow("| [[x\\|y]] | `a\\|b` |").map((c) => c.text)).toEqual(["[[x\\|y]]", "`a\\|b`"]);
  });
  test("empty cells keep a caret slot", () => {
    const cells = scanRow("|  |  |");
    expect(cells.map((c) => c.text)).toEqual(["", ""]);
    expect(cells[0].from).toBe(2);
    expect(scanRow("||").map((c) => c.text)).toEqual([""]);
  });
});

describe("parse and format", () => {
  test("golden: aligns columns and delimiter row", () => {
    const t = table("|a|bb|\n|-|:-:|\n|long cell|x|");
    expect(fmt(t)).toBe(
      ["| a         | bb  |", "| --------- | :-: |", "| long cell |  x  |"].join("\n"),
    );
  });
  test("alignment output", () => {
    const t = table("| a | b | c | d |\n| :-- | --: | :-: | --- |\n| 1 | 2 | 3 | 4 |");
    expect(fmt(t)).toBe(
      ["| a   |   b |  c  | d   |", "| :-- | --: | :-: | --- |", "| 1   |   2 |  3  | 4   |"].join(
        "\n",
      ),
    );
  });
  test("idempotent", () => {
    const t = table("| Name | Count |\n| --- | ---: |\n| Tea | 2 |\n| Coffee | 10 |");
    const once = fmt(t);
    expect(fmt(table(once))).toBe(once);
  });
  test("escaped pipes and wiki link aliases keep their source and width", () => {
    const t = table("| a | b |\n| - | - |\n| [[n\\|alias]] | x \\| y |");
    expect(fmt(t)).toBe(
      [
        "| a            | b      |",
        "| ------------ | ------ |",
        "| [[n\\|alias]] | x \\| y |",
      ].join("\n"),
    );
  });
  test("inline code is cell text", () => {
    const t = table("| c |\n| - |\n| `a\\|b` |");
    expect(t.rows[0][0]).toBe("`a\\|b`");
  });
  test("uneven rows are padded, nothing is dropped", () => {
    const t = table("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |");
    expect(t.header).toEqual(["a", "b", ""]);
    expect(t.rows).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
    expect(formatTable(t)[0].split("|").length).toBe(5);
  });
  test("header/delimiter mismatch is not a table; missing delimiter -> null", () => {
    expect(parseTable(["| a | b |", "| - |"])).toBeNull();
    expect(parseTable(["| a | b |", "| 1 | 2 |"])).toBeNull();
  });
  test("loose table gets a delimiter row", () => {
    const t = parseLooseTable(["a | b", "1 | 2"]);
    expect(t && fmt(t)).toBe(["| a   | b   |", "| --- | --- |", "| 1   | 2   |"].join("\n"));
    expect(parseLooseTable(["a | b", "no pipes"])).toBeNull();
  });
  test("CJK widths pad by display columns", () => {
    const t = table("| 名前 | n |\n| - | - |\n| 日本語 | 😀 |");
    const lines = formatTable(t);
    expect(lines[0]).toBe("| 名前   | n   |");
    expect(lines[2]).toBe("| 日本語 | 😀  |");
  });
  test("empty cells", () => {
    const t = table("| a | b |\n| - | - |\n|  |  |");
    expect(fmt(t).split("\n")[2]).toBe("|     |     |");
  });
  test("blockquote and indented prefixes", () => {
    const q = table("> | a | b |\n> | - | - |\n> | 1 | 2 |");
    expect(q.prefix).toBe("> ");
    expect(fmt(q)).toBe(["> | a   | b   |", "> | --- | --- |", "> | 1   | 2   |"].join("\n"));
    const l = table("- | a | b |\n  | - | - |\n  | 1 | 2 |");
    expect(l.firstPrefix).toBe("- ");
    expect(l.prefix).toBe("  ");
    expect(fmt(insertRow(l, 1))).toBe(
      ["- | a   | b   |", "  | --- | --- |", "  | 1   | 2   |", "  |     |     |"].join("\n"),
    );
  });
  test("cellRange points at content", () => {
    const t = table("| a | bb |\n| - | --: |\n| 1 | 22 |");
    const layout = layoutTable(t);
    const text = layout.lines.join("\n");
    const r = layout.cellRange(0, 1);
    expect(text.slice(r.from, r.to)).toBe("22");
    const h = layout.cellRange(HEADER_ROW, 1);
    expect(text.slice(h.from, h.to)).toBe("bb");
  });
});

describe("findTableBounds", () => {
  const find = (lines: string[], i: number) => findTableBounds((n) => lines[n], lines.length, i);
  test("finds around any line", () => {
    const lines = ["text", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "x | y"];
    expect(find(lines, 2)).toEqual({ startLine: 2, endLine: 4 });
    expect(find(lines, 4)).toEqual({ startLine: 2, endLine: 4 });
    expect(find(lines, 0)).toBeNull();
    expect(find(lines, 6)).toBeNull();
  });
  test("pipe line above the header is not in the table", () => {
    const lines = ["x | y | z", "| a | b |", "| - | - |"];
    expect(find(lines, 0)).toBeNull();
    expect(find(lines, 2)).toEqual({ startLine: 1, endLine: 2 });
  });
  test("no delimiter row -> null", () => {
    expect(find(["| a | b |", "| 1 | 2 |"], 0)).toBeNull();
  });
  test("quote and list prefixes", () => {
    const lines = ["> | a |", "> | - |", "> | 1 |"];
    expect(find(lines, 2)).toEqual({ startLine: 0, endLine: 2 });
    const list = ["- | a | b |", "  | - | - |", "  | 1 | 2 |"];
    expect(find(list, 1)).toEqual({ startLine: 0, endLine: 2 });
  });
});

describe("cellAtOffset", () => {
  const line = "| ab | cd | ef |";
  test("maps offsets to columns and in-cell offsets", () => {
    expect(cellAtOffset(line, 0, 3)).toEqual({ col: 0, offsetInCell: 1 });
    expect(cellAtOffset(line, 0, 8)).toEqual({ col: 1, offsetInCell: 1 });
    expect(cellAtOffset(line, 0, 0)).toEqual({ col: 0, offsetInCell: 0 });
    expect(cellAtOffset(line, 0, line.length).col).toBe(2);
    expect(cellAtOffset("> | a | b |", 2, 8).col).toBe(1);
  });
  test("escaped pipe does not change column", () => {
    expect(cellAtOffset("| a \\| b | c |", 0, 7).col).toBe(0);
  });
});

describe("operations", () => {
  const base = () => table("| a | b |\n| - | - |\n| 1 | x |\n| 2 | y |");
  test("rows", () => {
    expect(insertRow(base(), 1).rows).toEqual([
      ["1", "x"],
      ["", ""],
      ["2", "y"],
    ]);
    expect(deleteRow(base(), 0)?.rows).toEqual([["2", "y"]]);
    expect(deleteRow(base(), HEADER_ROW)).toBeNull();
    expect(duplicateRow(base(), 0)?.rows).toEqual([
      ["1", "x"],
      ["1", "x"],
      ["2", "y"],
    ]);
    expect(moveRow(base(), 0, 1)?.rows).toEqual([
      ["2", "y"],
      ["1", "x"],
    ]);
    expect(moveRow(base(), 0, -1)).toBeNull();
    expect(moveRow(base(), 1, 1)).toBeNull();
  });
  test("columns", () => {
    const ins = insertColumn(base(), 1);
    expect(ins.header).toEqual(["a", "", "b"]);
    expect(ins.rows[0]).toEqual(["1", "", "x"]);
    expect(deleteColumn(base(), 0)?.header).toEqual(["b"]);
    expect(deleteColumn(deleteColumn(base(), 0)!, 0)).toBeNull();
    const moved = moveColumn(setAlignment(base(), 0, "right")!, 0, 1)!;
    expect(moved.header).toEqual(["b", "a"]);
    expect(moved.align).toEqual([null, "right"]);
    expect(moved.rows[0]).toEqual(["x", "1"]);
    expect(moveColumn(base(), 1, 1)).toBeNull();
  });
  test("alignment", () => {
    expect(fmt(setAlignment(base(), 1, "center")!).split("\n")[1]).toBe("| --- | :-: |");
    expect(setAlignment(base(), 9, "left")).toBeNull();
  });
  test("sort: numeric, natural, empties last, stable, header kept", () => {
    const t = table("| n |\n| - |\n| 10 |\n| 2 |\n|  |\n| 33 |\n| 2 |");
    expect(sortRows(t, 0, "asc")?.rows.map((r) => r[0])).toEqual(["2", "2", "10", "33", ""]);
    expect(sortRows(t, 0, "desc")?.rows.map((r) => r[0])).toEqual(["33", "10", "2", "2", ""]);
    const s = table("| s |\n| - |\n| b10 |\n| B2 |\n| [[x\\|a]] |\n| **c** |");
    expect(sortRows(s, 0, "asc")?.rows.map((r) => r[0])).toEqual([
      "[[x\\|a]]",
      "B2",
      "b10",
      "**c**",
    ]);
    expect(sortRows(table("| s |\n| - |\n| a |"), 0, "asc")).toBeNull();
    expect(plainCellText("[[page|Shown]] [l](u) `c`")).toBe("Shown l c");
  });
  test("transpose", () => {
    const t = transpose(base());
    expect(t.header).toEqual(["a", "1", "2"]);
    expect(t.rows).toEqual([["b", "x", "y"]]);
    expect(fmt(transpose(t))).toBe(fmt(base()));
    const only = transpose(table("| a | b |\n| - | - |"));
    expect(only.header).toEqual(["a"]);
    expect(only.rows).toEqual([["b"]]);
  });
});

describe("delimited data", () => {
  test("escapeCell", () => {
    expect(escapeCell("a|b")).toBe("a\\|b");
    expect(escapeCell("a\\|b")).toBe("a\\|b");
    expect(escapeCell("l1\nl2")).toBe("l1<br>l2");
  });
  test("csv with quotes and newlines", () => {
    expect(parseDelimited('a,"b,c","d ""q"""\n1,2,"x\ny"', ",")).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "2", "x\ny"],
    ]);
  });
  test("detect", () => {
    expect(detectDelimiter("a\tb")).toBe("\t");
    expect(detectDelimiter("a,b\n1,2")).toBe(",");
    expect(detectDelimiter("a;b\n1;2")).toBe(";");
    expect(detectDelimiter("hello, world")).toBeNull();
    expect(detectDelimiter("a,b\n1,2,3")).toBeNull();
  });
  test("tableFromDelimited", () => {
    const t = tableFromDelimited("n,v\nx|y,1", "")!;
    expect(fmt(t)).toBe(["| n    | v   |", "| ---- | --- |", "| x\\|y | 1   |"].join("\n"));
    expect(tableFromDelimited("just text")).toBeNull();
    expect(fmt(tableFromGrid([["a"]]))).toBe(["| a   |", "| --- |"].join("\n"));
  });
});
