import { describe, expect, it } from "vite-plus/test";
import {
  addView,
  BaseYamlError,
  deleteView,
  duplicateView,
  moveView,
  renameView,
  setColumnSize,
  setDisplayName,
  setFilters,
  setGroupBy,
  setLimit,
  setOrder,
  setSort,
  setViewValue,
  uniqueViewName,
  withExtraColumns,
} from "../src/lib/bases/base-yaml";

// Synthetic base with comments, an unknown plugin key, quoting variety and odd spacing.
const SRC = `# Project board
name: Board # U1: kept verbatim
filters:
  and:
    - file.inFolder("Projects") # only projects
    - 'status != "archived"'
formulas:
  age: 'if(due, (today() - date(due)).days, "")'
properties:
  status:
    displayName: State # shown as State
  formula.age:
    displayName: Age
views:
  - type: table # main
    name: Table
    order:
      - file.name
      - status
    sort:
      - property: due
        direction: ASC
    columnSize:
      file.name: 300
    rowHeight: medium
    pluginKey: { a: 1, b: [x, y] }
  - type: cards
    name: Gallery
    cardSize: 220
`;

/** Lines that differ between two texts (order-preserving diff on whole lines). */
function changedLines(a: string, b: string): { removed: string[]; added: string[] } {
  const al = a.split("\n");
  const bl = b.split("\n");
  const removed = al.filter((l) => !bl.includes(l));
  const added = bl.filter((l) => !al.includes(l));
  return { removed, added };
}

describe("base-yaml: byte-level guarantees", () => {
  it("returns the input unchanged when nothing changes", () => {
    expect(setLimit(SRC, 0, null)).toBe(SRC);
    expect(setViewValue(SRC, 1, "cardSize", 220)).toBe(SRC);
    expect(setSort(SRC, 1, [])).toBe(SRC);
  });

  it("setting a limit only adds that line; comments, order and unknown keys survive", () => {
    const next = setLimit(SRC, 0, 25);
    expect(changedLines(SRC, next)).toEqual({ removed: [], added: ["    limit: 25"] });
    expect(next).toContain("# Project board");
    expect(next).toContain("pluginKey: { a: 1, b: [x, y] }");
    expect(next).toContain("name: Board # U1: kept verbatim");
    expect(next.replace("    limit: 25\n", "")).toBe(SRC);
  });

  it("changing a scalar in place keeps its comment", () => {
    const next = setViewValue(SRC, 1, "cardSize", 300);
    expect(changedLines(SRC, next)).toEqual({
      removed: ["    cardSize: 220"],
      added: ["    cardSize: 300"],
    });
  });

  it("replaces only the sort node", () => {
    const next = setSort(SRC, 0, [{ property: "status", direction: "DESC" }]);
    expect(changedLines(SRC, next)).toEqual({
      removed: ["      - property: due", "        direction: ASC"],
      added: ["      - property: status", "        direction: DESC"],
    });
    expect(setSort(next, 0, [])).not.toContain("sort:");
  });

  it("group by add and remove", () => {
    const grouped = setGroupBy(SRC, 0, { property: "status", direction: "ASC" });
    expect(changedLines(SRC, grouped).removed).toEqual([]);
    expect(grouped).toContain("groupBy:");
    expect(grouped).toContain("      property: status");
    expect(setGroupBy(grouped, 0, null)).toBe(SRC);
  });

  it("order edits keep sibling keys and comments", () => {
    const next = setOrder(SRC, 0, ["file.name", "status", "formula.age"]);
    expect(changedLines(SRC, next)).toEqual({ removed: [], added: ["      - formula.age"] });
    expect(next).toContain("- type: table # main");
  });

  it("filters: view scope and base scope touch only their node", () => {
    const view = setFilters(SRC, 0, { and: ['status == "open"'] });
    expect(view).toContain("    filters:\n");
    expect(view).toContain("# only projects");
    const base = setFilters(SRC, "base", { or: ['status == "x"', "done"] });
    expect(base).toContain("# Project board");
    expect(base).not.toContain("# only projects"); // that node was replaced
    expect(base).toContain("pluginKey: { a: 1, b: [x, y] }");
    expect(setFilters(base, "base", null)).not.toMatch(/^filters:/m);
  });

  it("column size: updates the existing key by canonical id, adds, removes", () => {
    const next = setColumnSize(SRC, 0, "file.name", 410);
    expect(changedLines(SRC, next)).toEqual({
      removed: ["      file.name: 300"],
      added: ["      file.name: 410"],
    });
    const added = setColumnSize(SRC, 1, "note.status", 150);
    expect(added).toContain("columnSize:\n      note.status: 150");
    // `note.status` and `status` are the same property: no duplicate key.
    const twice = setColumnSize(added, 1, "status", 160);
    expect(twice.match(/status:/g)!.length).toBe(added.match(/status:/g)!.length);
    expect(setColumnSize(SRC, 0, "file.name", null)).not.toContain("columnSize");
  });

  it("display names: edit in place (comment kept), add, remove", () => {
    const next = setDisplayName(SRC, "status", "Status");
    expect(changedLines(SRC, next)).toEqual({
      removed: ["    displayName: State # shown as State"],
      added: ["    displayName: Status # shown as State"],
    });
    const added = setDisplayName(SRC, "due", "Due date");
    expect(added).toContain("  due:\n    displayName: Due date");
    const removed = setDisplayName(SRC, "formula.age", null);
    expect(removed).not.toContain("formula.age:\n    displayName");
    expect(setDisplayName("views: []\n", "a", "A")).toBe(
      "views: []\nproperties:\n  a:\n    displayName: A\n",
    );
  });

  it("view operations", () => {
    const added = addView(SRC, { type: "list", name: "Plain" });
    expect(added.endsWith("  - type: list\n    name: Plain\n")).toBe(true);
    expect(changedLines(SRC, added).removed).toEqual([]);

    const copy = duplicateView(SRC, 0, "Table 2");
    expect(copy.indexOf("name: Table 2")).toBeGreaterThan(copy.indexOf("name: Table\n"));
    expect(copy.indexOf("name: Table 2")).toBeLessThan(copy.indexOf("name: Gallery"));
    expect(copy.match(/pluginKey/g)!.length).toBe(2);

    const renamed = renameView(SRC, 1, "Cards");
    expect(changedLines(SRC, renamed)).toEqual({
      removed: ["    name: Gallery"],
      added: ["    name: Cards"],
    });

    const moved = moveView(SRC, 1, 0);
    expect(moved.indexOf("type: cards")).toBeLessThan(moved.indexOf("type: table"));
    expect(moved).toContain("rowHeight: medium");

    const deleted = deleteView(SRC, 1);
    expect(deleted).not.toContain("Gallery");
    expect(deleted).toContain("# Project board");
  });

  it("refuses duplicate names, the last deletion and bad ranges explicitly", () => {
    expect(() => renameView(SRC, 1, "Table")).toThrow(BaseYamlError);
    expect(() => duplicateView(SRC, 0, "Gallery")).toThrow(/already exists/);
    expect(() => addView(SRC, { type: "table", name: "" })).toThrow(/needs a name/);
    expect(() => deleteView("views:\n  - type: table\n    name: T\n", 0)).toThrow(/at least one/);
    expect(() => moveView(SRC, 0, 5)).toThrow(/out of range/);
    expect(() => setLimit(SRC, 0, 0)).toThrow(/at least 1/);
    expect(() => setSort(SRC, 9, [])).toThrow(/does not exist/);
    expect(() => setLimit("views: [oops\n", 0, 1)).toThrow(/not valid YAML/);
    expect(() => setLimit("- a\n- b\n", 0, 1)).toThrow(/mapping/);
  });

  it("an implicit table is written out when the first view is added", () => {
    expect(addView("filters: 'a'\n", { type: "cards", name: "Cards" })).toBe(
      "filters: 'a'\nviews:\n  - type: table\n    name: Table\n  - type: cards\n    name: Cards\n",
    );
  });

  it("keeps flush sequences flush", () => {
    const flush = "views:\n- type: table\n  name: T\n  order:\n  - file.name\n";
    const next = setLimit(flush, 0, 3);
    expect(next).toBe("views:\n- type: table\n  name: T\n  order:\n  - file.name\n  limit: 3\n");
  });

  it("uniqueViewName", () => {
    expect(uniqueViewName(["A"], "B")).toBe("B");
    expect(uniqueViewName(["A", "A 2"], "A")).toBe("A 3");
  });

  it("withExtraColumns appends missing ids to the effective order, in memory only", () => {
    const next = withExtraColumns(SRC, 0, ["cover", "note.status"], ["file.name"]);
    expect(next).toContain("      - cover");
    expect(next.match(/- status/g)!.length).toBe(1); // `note.status` is `status`: not duplicated
    const noOrder = withExtraColumns(
      "views:\n  - type: cards\n    name: C\n",
      0,
      ["cover"],
      ["file.name"],
    );
    expect(noOrder).toContain("order:\n      - file.name\n      - cover");
    expect(withExtraColumns(SRC, null, ["x"], [])).toBe(SRC);
  });
});
