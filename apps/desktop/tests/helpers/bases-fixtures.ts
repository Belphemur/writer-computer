// Synthetic Bases data for tests: invented notes, never real vault content.
import type {
  BaseDocument,
  BaseQueryResult,
  BaseView,
  Cell,
  Column,
  Group,
  Row,
} from "../../src/lib/bases/types";

export const str = (value: string): Cell => ({ type: "string", value, display: value });
export const num = (value: number): Cell => ({ type: "number", value, display: String(value) });
export const bool = (value: boolean): Cell => ({ type: "boolean", value, display: String(value) });
export const nul = (): Cell => ({ type: "null", display: "" });
export const date = (value: string): Cell => ({
  type: "date",
  value,
  hasTime: false,
  display: value,
});
export const list = (...items: string[]): Cell => ({
  type: "list",
  value: items.map((value) => ({ type: "string", value })),
  display: items.join(", "),
});
export const link = (target: string, resolved: string | null = `${target}.md`): Cell => ({
  type: "link",
  value: { target, display: null, resolved },
  display: target,
});
export const err = (message: string): Cell => ({
  type: "error",
  value: { kind: "Type", message },
  display: `#ERROR ${message}`,
});

export const column = (id: string, displayName = id, summary: string | null = null): Column => ({
  id,
  key: id.startsWith("note.") ? id.slice(5) : id,
  displayName,
  summary,
});

export const BASE_PATH = "/vault/Projects/tasks.base";
export const BASE_REL = "Projects/tasks.base";

export function baseView(partial: Partial<BaseView> = {}): BaseView {
  return {
    type: "table",
    name: "Table",
    filters: null,
    groupBy: null,
    sort: [],
    order: null,
    limit: null,
    columnSize: {},
    summaries: {},
    extra: {},
    ...partial,
  };
}

export function baseDocument(partial: Partial<BaseDocument> = {}): BaseDocument {
  return {
    name: null,
    filters: null,
    formulas: {},
    properties: {},
    summaries: {},
    views: [baseView(), baseView({ name: "Board" })],
    warnings: [],
    ...partial,
  };
}

/** Three invented task notes with name, status, done, tags, due and a formula column. */
export function taskResult(partial: Partial<BaseQueryResult> = {}): BaseQueryResult {
  const columns = [
    column("file.name", "Name"),
    column("status", "Status"),
    column("done", "Done"),
    column("tags", "Tags"),
    column("due", "Due"),
    column("formula.age", "Age"),
  ];
  const rows: Row[] = [
    {
      path: "Tasks/alpha.md",
      cells: [str("alpha"), str("open"), bool(false), list("x", "y"), date("2024-01-05"), num(3)],
    },
    {
      path: "Tasks/beta.md",
      cells: [str("beta"), str("done"), bool(true), list("z"), date("2024-02-10"), num(9)],
    },
    {
      path: "Tasks/gamma.md",
      cells: [str("gamma"), nul(), bool(false), nul(), nul(), err("bad formula")],
    },
  ];
  return {
    view: { name: "Table", type: "table", index: 0 },
    availableViews: ["Table", "Board"],
    columns,
    rows,
    groups: null,
    summaries: columns.map(() => null),
    totalMatched: rows.length,
    error: null,
    warnings: [],
    ...partial,
  };
}

export function manyRowsResult(count: number): BaseQueryResult {
  const columns = [column("file.name", "Name"), column("n", "N")];
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({
    path: `Notes/n${i}.md`,
    cells: [str(`n${i}`), num(i)],
  }));
  return {
    view: { name: "Table", type: "table", index: 0 },
    availableViews: ["Table"],
    columns,
    rows,
    groups: null,
    summaries: [null, null],
    totalMatched: count,
    error: null,
    warnings: [],
  };
}

export function groupedResult(): BaseQueryResult {
  const base = taskResult();
  const groups: Group[] = [
    {
      key: str("open"),
      start: 0,
      len: 2,
      summaries: [{ type: "number", value: 2, display: "2" }, null, null, null, null, null],
    },
    { key: str("done"), start: 2, len: 1, summaries: base.columns.map(() => null) },
  ];
  return {
    ...base,
    columns: base.columns.map((c) => (c.key === "file.name" ? { ...c, summary: "Count" } : c)),
    groups,
  };
}

/** `groupCount` groups of `perGroup` rows each (group g is "g{g}", rows "Notes/g{g}-{i}.md"). */
export function manyGroupsResult(
  groupCount: number,
  perGroup: number,
  type = "table",
): BaseQueryResult {
  const columns = [column("file.name", "Name"), column("n", "N")];
  const rows: Row[] = [];
  const groups: Group[] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push({ key: str(`g${g}`), start: rows.length, len: perGroup, summaries: [null, null] });
    for (let i = 0; i < perGroup; i++)
      rows.push({ path: `Notes/g${g}-${i}.md`, cells: [str(`g${g}-${i}`), num(i)] });
  }
  return {
    view: { name: "Table", type, index: 0 },
    availableViews: ["Table"],
    columns,
    rows,
    groups,
    summaries: [null, null],
    totalMatched: rows.length,
    error: null,
    warnings: [],
  };
}
