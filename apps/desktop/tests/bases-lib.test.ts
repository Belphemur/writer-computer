import { describe, expect, it } from "vite-plus/test";
import {
  canonicalPropertyKey,
  classifyValue,
  columnReadOnlyReason,
  editTargetFor,
  inferColumnKind,
  jsonEqual,
  parseCellText,
  parseListText,
  parseWikiLinkText,
  propertyNamespace,
  rawToCell,
  rawToEditText,
  READ_ONLY_REASONS,
  toWikiLinkText,
  valueTypeOfRaw,
} from "../src/lib/bases/cells";
import { indexChangeEffect } from "../src/lib/bases/events";
import {
  ariaSort,
  buildGridLayout,
  columnWidths,
  groupLabel,
  rowHeightPx,
  sortIndicators,
  viewNames,
  viewOfResult,
} from "../src/lib/bases/grid";
import { isBasePath, toAbsolutePath, toRelativePath } from "../src/lib/bases/paths";
import {
  baseDocument,
  baseView,
  bool,
  column,
  groupedResult,
  list,
  nul,
  num,
  str,
  taskResult,
} from "./helpers/bases-fixtures";

describe("property ids", () => {
  it("classifies canonical column keys by namespace", () => {
    expect(propertyNamespace("status")).toBe("note");
    expect(propertyNamespace("file.name")).toBe("file");
    expect(propertyNamespace("formula.age")).toBe("formula");
    expect(canonicalPropertyKey("note.status")).toBe("status");
    expect(canonicalPropertyKey("file.name")).toBe("file.name");
  });

  it("reports why formula and file columns are read-only", () => {
    expect(columnReadOnlyReason(column("formula.x"))).toBe(READ_ONLY_REASONS.formula);
    expect(columnReadOnlyReason(column("file.mtime"))).toBe(READ_ONLY_REASONS.file);
    expect(columnReadOnlyReason(column("status"))).toBeNull();
  });
});

describe("cell classification", () => {
  it("maps tagged values to editor kinds", () => {
    expect(classifyValue(str("a"))).toEqual({ editable: true, kind: "text" });
    expect(classifyValue(num(1))).toEqual({ editable: true, kind: "number" });
    expect(classifyValue(bool(true))).toEqual({ editable: true, kind: "checkbox" });
    expect(classifyValue({ type: "date", value: "2024-01-05", hasTime: false })).toEqual({
      editable: true,
      kind: "date",
    });
    expect(classifyValue({ type: "date", value: "2024-01-05T10:00:00", hasTime: true })).toEqual({
      editable: true,
      kind: "datetime",
    });
    expect(classifyValue(list("a", "b"))).toEqual({ editable: true, kind: "list" });
    expect(classifyValue(nul())).toEqual({ editable: true, kind: null });
    expect(
      classifyValue({ type: "link", value: { target: "x", display: null, resolved: null } }),
    ).toEqual({ editable: true, kind: "link" });
  });

  it("refuses errors, objects, nested lists and exotic types with a reason", () => {
    expect(classifyValue({ type: "error", value: { kind: "Type", message: "m" } })).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.error,
    });
    expect(classifyValue({ type: "object", value: {} })).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.object,
    });
    expect(classifyValue({ type: "list", value: [{ type: "number", value: 1 }] })).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.complexList,
    });
    expect(classifyValue({ type: "duration", value: { months: 0, millis: 1 } })).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.unsupported,
    });
  });

  it("infers the kind of a null cell from the column majority", () => {
    const result = taskResult();
    expect(inferColumnKind(result.rows, 2)).toBe("checkbox");
    expect(inferColumnKind(result.rows, 4)).toBe("date");
    expect(inferColumnKind([], 0)).toBe("text");
    const target = editTargetFor(result.columns[4]!, result.rows[2]!.cells[4]!, result.rows, 4);
    expect(target).toEqual({ editable: true, kind: "date" });
    const formula = editTargetFor(result.columns[5]!, result.rows[0]!.cells[5]!, result.rows, 5);
    expect(formula).toEqual({ editable: false, reason: READ_ONLY_REASONS.formula });
  });
});

describe("parseCellText", () => {
  it("treats empty text as clear for every kind", () => {
    for (const kind of ["text", "number", "checkbox", "date", "datetime", "list", "link"] as const)
      expect(parseCellText(kind, "  ")).toEqual({ ok: true, clear: true });
  });

  it("parses valid values with their value type", () => {
    expect(parseCellText("text", "hello")).toEqual({
      ok: true,
      clear: false,
      value: "hello",
      valueType: "text",
    });
    expect(parseCellText("number", " 4.5 ")).toMatchObject({ value: 4.5, valueType: "number" });
    expect(parseCellText("checkbox", "Yes")).toMatchObject({ value: true });
    expect(parseCellText("checkbox", "0")).toMatchObject({ value: false });
    expect(parseCellText("date", "2024-02-29")).toMatchObject({ value: "2024-02-29" });
    expect(parseCellText("datetime", "2024-02-29 10:30")).toMatchObject({
      value: "2024-02-29T10:30",
    });
    expect(parseCellText("list", "a, b ,, c")).toMatchObject({ value: ["a", "b", "c"] });
    expect(parseCellText("link", "Note")).toMatchObject({ value: "[[Note]]", valueType: "link" });
    expect(parseCellText("link", "[[Note|alias]]")).toMatchObject({ value: "[[Note|alias]]" });
  });

  it("rejects invalid text instead of coercing it", () => {
    expect(parseCellText("number", "abc")).toMatchObject({ ok: false });
    expect(parseCellText("number", "Infinity")).toMatchObject({ ok: false });
    expect(parseCellText("checkbox", "maybe")).toMatchObject({ ok: false });
    expect(parseCellText("date", "2023-02-29")).toMatchObject({ ok: false });
    expect(parseCellText("date", "02/03/2024")).toMatchObject({ ok: false });
    expect(parseCellText("datetime", "2024-01-01T25:00")).toMatchObject({ ok: false });
  });

  it("splits list text and wraps links", () => {
    expect(parseListText("a,b, ,c")).toEqual(["a", "b", "c"]);
    expect(toWikiLinkText("x")).toBe("[[x]]");
    expect(toWikiLinkText("[[x]]")).toBe("[[x]]");
  });
});

describe("raw values", () => {
  it("renders editor text from raw frontmatter values", () => {
    expect(rawToEditText("text", undefined)).toBe("");
    expect(rawToEditText("number", 3)).toBe("3");
    expect(rawToEditText("list", ["a", "b"])).toBe("a, b");
    expect(rawToEditText("date", "2024-01-05")).toBe("2024-01-05");
  });

  it("compares JSON structurally and infers a write type", () => {
    expect(jsonEqual(["a", { b: 1 }], ["a", { b: 1 }])).toBe(true);
    expect(jsonEqual(["a"], ["a", "b"])).toBe(false);
    expect(jsonEqual(undefined, null)).toBe(false);
    expect(valueTypeOfRaw(true)).toBe("checkbox");
    expect(valueTypeOfRaw(2)).toBe("number");
    expect(valueTypeOfRaw(["a"])).toBe("list");
    expect(valueTypeOfRaw("[[x]]")).toBe("link");
    expect(valueTypeOfRaw("plain")).toBeUndefined();
  });

  it("builds the optimistic cell a write will show", () => {
    expect(rawToCell(undefined, undefined)).toEqual({ type: "null", display: "" });
    expect(rawToCell(true, "checkbox")).toMatchObject({ type: "boolean", value: true });
    expect(rawToCell("2024-01-05", "date")).toMatchObject({ type: "date", hasTime: false });
    expect(rawToCell("[[Note|alias]]", "link")).toMatchObject({
      type: "link",
      display: "alias",
      value: { target: "Note", display: "alias", resolved: null },
    });
    expect(rawToCell(["a", "[[b]]"], "list")).toMatchObject({ type: "list", display: "a, b" });
    expect(parseWikiLinkText("not a link")).toBeNull();
  });
});

describe("grid layout", () => {
  it("lists every row when there are no groups", () => {
    const layout = buildGridLayout(taskResult(), new Set());
    expect(layout.items.map((i) => i.kind)).toEqual(["row", "row", "row"]);
    expect(layout.visibleRows).toEqual([0, 1, 2]);
    expect(layout.itemIndexOfRow).toEqual([0, 1, 2]);
  });

  it("emits a header, a summary row and the rows of each group", () => {
    const layout = buildGridLayout(groupedResult(), new Set());
    expect(layout.items.map((i) => i.kind)).toEqual([
      "group",
      "group-summary",
      "row",
      "row",
      "group",
      "row",
    ]);
    const header = layout.items[0]!;
    expect(header).toMatchObject({ kind: "group", label: "open", count: 2, collapsed: false });
  });

  it("hides the rows of a collapsed group", () => {
    const result = groupedResult();
    const layout = buildGridLayout(result, new Set(["string:open"]));
    expect(layout.items.map((i) => i.kind)).toEqual(["group", "group-summary", "group", "row"]);
    expect(layout.visibleRows).toEqual([2]);
    expect(layout.itemIndexOfRow).toEqual([-1, -1, 3]);
  });

  it("throws on groups that do not describe the rows", () => {
    const result = groupedResult();
    result.groups![1] = { ...result.groups![1]!, start: 5 };
    expect(() => buildGridLayout(result, new Set())).toThrow(/Invalid group range/);
    const short = groupedResult();
    short.groups = [short.groups![0]!];
    expect(() => buildGridLayout(short, new Set())).toThrow(/cover 2 of 3/);
  });

  it("labels an empty group key", () => {
    expect(groupLabel({ key: nul(), start: 0, len: 0, summaries: [] })).toBe("No value");
    expect(groupLabel({ key: str("x"), start: 0, len: 0, summaries: [] })).toBe("x");
  });
});

describe("columns and view helpers", () => {
  it("reads widths by canonical key, clamps them and defaults the rest", () => {
    const view = baseView({
      columnSize: { "file.name": 420, "note.status": 20, due: "wide" },
    });
    const widths = columnWidths(taskResult().columns, view);
    expect(widths[0]).toBe(420);
    expect(widths[1]).toBe(60);
    expect(widths[4]).toBe(180);
    expect(columnWidths(taskResult().columns, undefined)[0]).toBe(180);
  });

  it("maps the documented row heights", () => {
    expect(rowHeightPx(baseView({ extra: { rowHeight: "tall" } }))).toBe(52);
    expect(rowHeightPx(baseView({ extra: { rowHeight: "Extra Tall" } }))).toBe(72);
    expect(rowHeightPx(baseView())).toBe(28);
  });

  it("derives sort and group markers from the view", () => {
    const view = baseView({
      sort: [
        { property: "note.due", direction: "DESC" },
        { property: "file.name", direction: "ASC" },
      ],
      groupBy: { property: "status", direction: "ASC" },
    });
    const { sort, groupBy } = sortIndicators(view);
    expect(sort.get("due")).toEqual({ direction: "DESC", priority: 1, of: 2 });
    expect(sort.get("file.name")).toMatchObject({ direction: "ASC", priority: 2 });
    expect(groupBy).toBe("status");
    expect(ariaSort(sort.get("due"))).toBe("descending");
    expect(ariaSort(sort.get("file.name"))).toBe("ascending");
    expect(ariaSort(undefined)).toBe("none");
  });

  it("finds the view of a result and the tab names", () => {
    const doc = baseDocument();
    expect(viewNames(doc)).toEqual(["Table", "Board"]);
    expect(viewNames(null)).toEqual([]);
    expect(viewOfResult(doc, taskResult())?.name).toBe("Table");
    expect(viewOfResult(doc, { view: { name: "x", type: "table", index: null } })).toBeUndefined();
  });
});

describe("paths", () => {
  it("recognises base files and converts between vault-relative and absolute", () => {
    expect(isBasePath("/v/a.base")).toBe(true);
    expect(isBasePath("/v/a.BASE")).toBe(true);
    expect(isBasePath("/v/a.md")).toBe(false);
    expect(toAbsolutePath("/v/", "a/b.md")).toBe("/v/a/b.md");
    expect(toRelativePath("/v", "/v/a/b.md")).toBe("a/b.md");
    expect(toRelativePath("/v", "/other/a.md")).toBeNull();
  });
});

describe("indexChangeEffect", () => {
  const rows = new Set(["Tasks/alpha.md"]);
  it("reloads the document for a full batch or a change to the base itself", () => {
    expect(indexChangeEffect({ full: true, paths: [] }, "x.base", rows)).toBe("reload-document");
    expect(indexChangeEffect({ full: false, paths: ["x.base"] }, "x.base", rows)).toBe(
      "reload-document",
    );
  });
  it("requeries for notes and row files, ignores unrelated bases", () => {
    expect(indexChangeEffect({ full: false, paths: ["Other/new.md"] }, "x.base", rows)).toBe(
      "requery",
    );
    expect(indexChangeEffect({ full: false, paths: ["Tasks/alpha.md"] }, "x.base", rows)).toBe(
      "requery",
    );
    expect(indexChangeEffect({ full: false, paths: ["other.base"] }, "x.base", rows)).toBe("none");
    expect(
      indexChangeEffect({ full: false, paths: ["other.base"] }, "x.base", new Set(["other.base"])),
    ).toBe("requery");
  });
});
