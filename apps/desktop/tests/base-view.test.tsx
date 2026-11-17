// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/bases/ipc", () => ({
  baseList: vi.fn(),
  baseRead: vi.fn(),
  baseQuery: vi.fn(),
  baseQueryText: vi.fn(),
  noteProperties: vi.fn(),
  notePropertySet: vi.fn(),
  notePropertyRemove: vi.fn(),
  onIndexChanged: vi.fn(),
  baseEval: vi.fn(),
  indexProperties: vi.fn(),
  baseWriteText: vi.fn(),
}));

import { BaseView } from "../src/components/base-view";
import { REQUERY_DEBOUNCE_MS } from "../src/components/base-view/use-base-query";
import * as ipc from "../src/lib/bases/ipc";
import { rawToCell, type EditKind } from "../src/lib/bases/cells";
import type { BaseQueryResult, IndexChangedEvent, NoteProperties } from "../src/lib/bases/types";
import { open, optionNames, options, trigger } from "./helpers/view-switcher";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import {
  BASE_PATH,
  BASE_REL,
  baseDocument,
  baseView,
  groupedResult,
  manyRowsResult,
  taskResult,
} from "./helpers/bases-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = {
  baseRead: vi.mocked(ipc.baseRead),
  baseQuery: vi.mocked(ipc.baseQuery),
  noteProperties: vi.mocked(ipc.noteProperties),
  notePropertySet: vi.mocked(ipc.notePropertySet),
  notePropertyRemove: vi.mocked(ipc.notePropertyRemove),
  onIndexChanged: vi.mocked(ipc.onIndexChanged),
};

// jsdom has no layout: give the scroll element a size so the virtualizer renders a window.
function stubLayout(height = 400, width = 900) {
  // The virtualizer reads the scroll element's client size.
  for (const [name, value] of [
    ["clientHeight", height],
    ["clientWidth", width],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

// ---- fake backend ------------------------------------------------------------

const KINDS: Record<string, EditKind> = {
  status: "text",
  done: "checkbox",
  tags: "list",
  due: "date",
};

type Props = Record<string, Record<string, unknown>>;

let props: Props;
let frontmatterError: Record<string, string>;
let indexHandler: ((e: IndexChangedEvent) => void) | null;
let unlisten: ReturnType<typeof vi.fn>;

function freshProps(): Props {
  return {
    "/vault/Tasks/alpha.md": {
      status: "open",
      done: false,
      tags: ["x", "y"],
      due: "2024-01-05",
    },
    "/vault/Tasks/beta.md": { status: "done", done: true, tags: ["z"], due: "2024-02-10" },
    "/vault/Tasks/gamma.md": {},
  };
}

/** The task result with property cells read from the fake notes, so a write shows up on requery. */
function resultFromProps(): BaseQueryResult {
  const base = taskResult();
  return {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell, i) => {
        const key = base.columns[i]!.key;
        if (!(key in KINDS)) return cell;
        return rawToCell(props[`/vault/${row.path}`]?.[key], KINDS[key]);
      }),
    })),
  };
}

function installBackend() {
  m.baseRead.mockResolvedValue({ text: "", document: baseDocument(), error: null });
  m.baseQuery.mockImplementation(async () => resultFromProps());
  m.noteProperties.mockImplementation(async (path): Promise<NoteProperties> => ({
    properties: { ...props[path] },
    order: Object.keys(props[path] ?? {}),
    types: {},
    error: frontmatterError[path] ?? null,
  }));
  m.notePropertySet.mockImplementation(async ({ path, name, value }) => {
    props[path] = { ...props[path], [name]: value };
  });
  m.notePropertyRemove.mockImplementation(async ({ path, name }) => {
    const next = { ...props[path] };
    delete next[name];
    props[path] = next;
  });
  m.onIndexChanged.mockImplementation(async (handler) => {
    indexHandler = handler;
    return unlisten as unknown as () => void;
  });
}

// ---- DOM helpers ---------------------------------------------------------------

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

type Location = { kind: "base"; path: string; view?: string };

async function mount(opts: { location?: Location; isActive?: boolean } = {}) {
  const location = opts.location ?? { kind: "base" as const, path: BASE_PATH };
  await act(async () => {
    root.render(<BaseView location={location} isActive={opts.isActive ?? true} tabId="tab-1" />);
  });
  await flush();
}

async function rerender(location: Location, isActive: boolean) {
  await act(async () => {
    root.render(<BaseView location={location} isActive={isActive} tabId="tab-1" />);
  });
  await flush();
}

const grid = () => host.querySelector<HTMLElement>('[role="grid"]')!;
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-row-path]")];
const cell = (path: string, col: number) =>
  host.querySelector<HTMLElement>(`[data-row-path="${path}"] [aria-colindex="${col}"]`)!;
const notice = () => host.querySelector<HTMLElement>("[data-base-notice]");

async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    grid().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function selectCell(path: string, col: number) {
  await click(cell(path, col));
  await flush();
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function editorKey(input: HTMLElement, k: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function fireIndex(event: Partial<IndexChangedEvent>) {
  await act(async () => {
    indexHandler!({ epoch: 1, root: "/vault", paths: [], full: false, ...event });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubLayout();
  props = freshProps();
  frontmatterError = {};
  indexHandler = null;
  unlisten = vi.fn();
  installBackend();
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("shows a loading skeleton, then an accessible grid with display names and sizes", async () => {
    let resolve!: (r: BaseQueryResult) => void;
    m.baseQuery.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    m.baseRead.mockResolvedValue({
      text: "",
      error: null,
      document: baseDocument({
        views: [
          baseView({
            columnSize: { "file.name": 320 },
            sort: [{ property: "due", direction: "DESC" }],
          }),
          baseView({ name: "Board" }),
        ],
      }),
    });
    await mount();
    expect(host.querySelector("[data-base-skeleton]")).not.toBeNull();
    expect(host.querySelector('[role="grid"]')).toBeNull();

    await act(async () => resolve(taskResult()));
    await flush();
    expect(host.querySelector("[data-base-skeleton]")).toBeNull();
    const g = grid();
    expect(g.getAttribute("aria-rowcount")).toBe("4");
    expect(g.getAttribute("aria-colcount")).toBe("6");
    const headers = [...host.querySelectorAll('[role="columnheader"]')];
    expect(headers.map((h) => h.textContent?.replace(/[↑↓]/g, ""))).toEqual([
      "Name",
      "Status",
      "Done",
      "Tags",
      "Due",
      "Age",
    ]);
    expect((headers[0] as HTMLElement).style.width).toBe("320px");
    expect(headers[4]!.getAttribute("aria-sort")).toBe("descending");
    expect(headers[0]!.getAttribute("aria-sort")).toBe("none");
    expect(host.querySelector("[data-sort-indicator]")?.textContent).toBe("↓");
    expect(rows()).toHaveLength(3);
    expect(host.querySelector("[data-base-count]")?.textContent).toBe("3 results");
    // The query asks for this view of this file, with the base itself as `this`.
    expect(m.baseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ path: BASE_PATH, thisPath: BASE_PATH }),
    );
  });

  it("renders the view dropdown and switches views through the tab state", async () => {
    await mount();
    expect(trigger(host).textContent).toBe("Table");
    await open(host);
    expect(optionNames()).toEqual(["Table", "Board"]);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    useEditorStore.setState({
      tabs: [{ id: "tab-1", location: { kind: "base", path: BASE_PATH }, back: [], forward: [] }],
      activeTabId: "tab-1",
    });
    await act(async () => options()[1]!.click());
    expect(useEditorStore.getState().tabs[0]!.location).toEqual({
      kind: "base",
      path: BASE_PATH,
      view: "Board",
    });
    // The location is the source of truth: re-rendering with it queries the new view.
    await rerender({ kind: "base", path: BASE_PATH, view: "Board" }, true);
    expect(m.baseQuery).toHaveBeenLastCalledWith(expect.objectContaining({ view: "Board" }));
    expect(trigger(host).textContent).toBe("Board");
  });

  it("shows the count of limited results", async () => {
    m.baseQuery.mockResolvedValue({ ...taskResult(), totalMatched: 40 });
    await mount();
    expect(host.querySelector("[data-base-count]")?.textContent).toBe("3 results of 40");
  });

  it("shows the view's error state instead of rows, with the offending expression", async () => {
    m.baseQuery.mockResolvedValue({
      ...taskResult(),
      rows: [],
      totalMatched: 0,
      error: {
        kind: "filterEval",
        message: "unknown function len",
        expression: "len(tags) > 0",
        path: "Tasks/alpha.md",
      },
    });
    await mount();
    const banner = host.querySelector('[data-base-error][role="alert"]')!;
    expect(banner.textContent).toContain("Filter error: unknown function len");
    expect(banner.textContent).toContain("len(tags) > 0");
    expect(banner.textContent).toContain("Tasks/alpha.md");
    expect(rows()).toHaveLength(0);
    expect(host.querySelector("[data-empty]")?.textContent).toBe("No results");
  });

  it("shows an IPC failure and a document read failure explicitly", async () => {
    m.baseQuery.mockRejectedValue(new Error("index is rebuilding"));
    m.baseRead.mockRejectedValue("invalid YAML at line 3");
    await mount();
    const text = host.textContent!;
    expect(text).toContain("The query failed");
    expect(text).toContain("index is rebuilding");
    expect(text).toContain("tasks.base could not be read");
    expect(text).toContain("invalid YAML at line 3");
    expect(host.querySelector("[data-base-skeleton]")).toBeNull();
  });

  it("renders per-cell errors distinctively and lists warnings", async () => {
    m.baseQuery.mockResolvedValue({ ...taskResult(), warnings: ["views[1]: unknown key ignored"] });
    m.baseRead.mockResolvedValue({
      text: "",
      error: null,
      document: baseDocument({ warnings: ["formulas.age: expected text"] }),
    });
    await mount();
    const err = host.querySelector("[data-cell-error]")!;
    expect(err.textContent).toContain("bad formula");
    expect(err.getAttribute("title")).toBe("bad formula");
    expect(cell("Tasks/gamma.md", 6).getAttribute("data-cell-type")).toBe("error");
    const warnings = host.querySelector("[data-base-warnings]")!;
    expect(warnings.textContent).toContain("2 warnings");
    expect(warnings.textContent).toContain("formulas.age: expected text");
    expect(warnings.textContent).toContain("views[1]: unknown key ignored");
  });

  it("renders checkboxes, list chips, links and dates", async () => {
    const result = taskResult();
    result.rows[0]!.cells[0] = {
      type: "link",
      value: { target: "alpha", display: null, resolved: "Tasks/alpha.md" },
      display: "alpha",
    };
    m.baseQuery.mockResolvedValue(result);
    await mount();
    const done = cell("Tasks/alpha.md", 3).querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(done.checked).toBe(false);
    expect(
      cell("Tasks/beta.md", 3).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    ).toBe(true);
    // Formula column checkbox-less; list chips.
    expect(
      [...cell("Tasks/alpha.md", 4).querySelectorAll("[data-cell-chip]")].map((c) => c.textContent),
    ).toEqual(["x", "y"]);
    expect(cell("Tasks/alpha.md", 5).textContent).toBe("2024-01-05");
    expect(cell("Tasks/alpha.md", 1).querySelector("[data-cell-link]")?.textContent).toBe("alpha");
  });

  it("groups rows with counts, collapses groups and shows group and overall summaries", async () => {
    m.baseQuery.mockResolvedValue(groupedResult());
    await mount();
    const headers = [...host.querySelectorAll("[data-group-header]")];
    expect(headers.map((h) => h.textContent)).toEqual(["▾open2", "▾done1"]);
    expect(host.querySelectorAll("[data-group-summary]")).toHaveLength(1);
    expect(host.querySelector("[data-group-summary]")!.textContent).toContain("Count2");
    expect(rows()).toHaveLength(3);

    const toggle = headers[0]!.querySelector("button")!;
    await click(toggle);
    expect(rows().map((r) => r.dataset.rowPath)).toEqual(["Tasks/gamma.md"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(rows()).toHaveLength(3);
  });

  it("shows the summary footer of an ungrouped view", async () => {
    const result = taskResult();
    result.columns[0] = { ...result.columns[0]!, summary: "Count" };
    result.summaries[0] = { type: "number", value: 3, display: "3" };
    m.baseQuery.mockResolvedValue(result);
    await mount();
    const footer = host.querySelector("[data-summary-row]")!;
    expect(footer.textContent).toBe("Count3");
    expect(grid().getAttribute("aria-rowcount")).toBe("5");
  });
});

describe("base document problems", () => {
  it("shows the parser error once, with the raw text, when the .base does not parse", async () => {
    m.baseRead.mockResolvedValue({
      text: "views: [oops",
      document: null,
      error: "invalid YAML at line 1, column 8",
    });
    m.baseQuery.mockResolvedValue({
      ...taskResult(),
      availableViews: [],
      columns: [],
      rows: [],
      totalMatched: 0,
      error: {
        kind: "document",
        message: "invalid YAML at line 1, column 8",
        expression: null,
        path: null,
      },
    });
    await mount();
    const banners = host.querySelectorAll("[data-base-error]");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toContain("The .base file could not be parsed");
    expect(banners[0]!.textContent).toContain("invalid YAML at line 1, column 8");
    expect(host.querySelector("[data-base-raw-text]")!.textContent).toBe("views: [oops");
  });

  it("uses the view names of the result for the dropdown", async () => {
    m.baseQuery.mockResolvedValue({ ...taskResult(), availableViews: ["One", "Two", "Three"] });
    await mount();
    await open(host);
    expect(optionNames()).toEqual(["One", "Two", "Three"]);
  });
});

describe("link cells", () => {
  it("edits a link as text and writes it as a wikilink string", async () => {
    const result = taskResult();
    result.columns.push({ id: "owner", key: "owner", displayName: "Owner", summary: null });
    result.rows.forEach((row, i) =>
      row.cells.push(
        i === 0
          ? {
              type: "link",
              value: { target: "Old", display: "o", resolved: "People/Old.md" },
              display: "o",
            }
          : { type: "null", display: "" },
      ),
    );
    m.baseQuery.mockResolvedValue(result);
    props["/vault/Tasks/alpha.md"] = { ...props["/vault/Tasks/alpha.md"], owner: "[[Old|o]]" };
    await mount();
    await selectCell("Tasks/alpha.md", 7);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 7).querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("[[Old|o]]");
    await typeInto(input, "New");
    await editorKey(input, "Enter");
    // The backend has no "link" value type: a link is text that looks like a wikilink.
    expect(m.notePropertySet).toHaveBeenCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "owner",
      value: "[[New]]",
      valueType: "text",
    });
  });
});

describe("virtualization", () => {
  it("renders only a window of 10,000 rows", async () => {
    m.baseQuery.mockResolvedValue(manyRowsResult(10_000));
    await mount();
    const rendered = rows();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    expect(grid().getAttribute("aria-rowcount")).toBe("10001");
    expect(host.querySelector("[data-base-count]")?.textContent).toBe("10000 results");
    expect(rendered[0]!.dataset.rowPath).toBe("Notes/n0.md");
    // Row indices are absolute positions in the table, not positions in the window.
    expect(rendered[0]!.getAttribute("aria-rowindex")).toBe("2");
  });
});

describe("keyboard navigation", () => {
  const active = () => grid().getAttribute("aria-activedescendant");
  const idOf = (path: string, col: number) => cell(path, col).id;

  it("moves between cells with the arrow keys and keeps focus on the grid", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    expect(active()).toBe(idOf("Tasks/alpha.md", 2));
    expect(cell("Tasks/alpha.md", 2).getAttribute("aria-selected")).toBe("true");
    await key("ArrowDown");
    expect(active()).toBe(idOf("Tasks/beta.md", 2));
    await key("ArrowRight");
    expect(active()).toBe(idOf("Tasks/beta.md", 3));
    await key("ArrowUp");
    await key("ArrowLeft");
    expect(active()).toBe(idOf("Tasks/alpha.md", 2));
    await key("Home");
    expect(active()).toBe(idOf("Tasks/alpha.md", 1));
    await key("End");
    expect(active()).toBe(idOf("Tasks/alpha.md", 6));
    await key("ArrowDown", { metaKey: true });
    expect(active()).toBe(idOf("Tasks/gamma.md", 6));
    // Edges clamp instead of wrapping.
    await key("ArrowDown");
    await key("ArrowRight");
    expect(active()).toBe(idOf("Tasks/gamma.md", 6));
  });

  it("extends a range with shift and collapses it with Escape", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("ArrowDown", { shiftKey: true });
    await key("ArrowRight", { shiftKey: true });
    const selected = [...host.querySelectorAll('[role="gridcell"][aria-selected="true"]')];
    expect(selected).toHaveLength(4);
    await key("Escape");
    expect(host.querySelectorAll('[role="gridcell"][aria-selected="true"]')).toHaveLength(1);
  });

  it("skips the rows of a collapsed group", async () => {
    m.baseQuery.mockResolvedValue(groupedResult());
    await mount();
    await click(host.querySelector("[data-group-header] button")!);
    await selectCell("Tasks/gamma.md", 1);
    await key("ArrowUp");
    expect(active()).toBe(idOf("Tasks/gamma.md", 1));
  });
});

describe("editing", () => {
  it("edits a text cell: optimistic value, one write, requery", async () => {
    let finishWrite!: () => void;
    m.notePropertySet.mockImplementationOnce(
      ({ path, name, value }) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            props[path] = { ...props[path], [name]: value };
            resolve();
          };
        }),
    );
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 2).querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("open");
    await typeInto(input, "blocked");
    const queries = m.baseQuery.mock.calls.length;
    await editorKey(input, "Enter");
    expect(m.notePropertySet).toHaveBeenCalledTimes(1);

    // Optimistic: shown while the write is still in flight.
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("blocked");
    expect(m.notePropertySet).toHaveBeenCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "status",
      value: "blocked",
      valueType: "text",
    });
    await act(async () => finishWrite());
    await flush();
    expect(m.baseQuery.mock.calls.length).toBe(queries + 1);
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("blocked");
    expect(grid().contains(document.activeElement)).toBe(true);
  });

  it("cancels an edit with Escape without writing", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 2).querySelector<HTMLInputElement>("input")!;
    await typeInto(input, "nope");
    await editorKey(input, "Escape");
    expect(m.notePropertySet).not.toHaveBeenCalled();
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("open");
    expect(host.querySelector('input[aria-label="Edit cell"]')).toBeNull();
  });

  it("rolls back and shows an error when the write fails", async () => {
    m.notePropertySet.mockRejectedValueOnce(new Error("disk is read-only"));
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 2).querySelector<HTMLInputElement>("input")!;
    await typeInto(input, "blocked");
    await editorKey(input, "Enter");
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("open");
    expect(m.notePropertySet).toHaveBeenCalledTimes(1);
    const n = notice()!;
    expect(n.getAttribute("data-base-notice")).toBe("error");
    expect(n.getAttribute("role")).toBe("alert");
    expect(n.textContent).toContain("disk is read-only");
    expect(n.textContent).toContain("status");
    expect(props["/vault/Tasks/alpha.md"]!.status).toBe("open");
    // A failed write leaves nothing to undo.
    await key("z", { metaKey: true });
    expect(notice()!.textContent).toContain("Nothing to undo");
  });

  it("keeps the editor open and reports invalid input", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 5);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 5).querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("date");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "2024-03-09",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await editorKey(input, "Enter");
    expect(m.notePropertySet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "due", value: "2024-03-09", valueType: "date" }),
    );
  });

  it("toggles a checkbox from the keyboard and the mouse", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 3);
    await key(" ");
    expect(m.notePropertySet).toHaveBeenLastCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "done",
      value: true,
      valueType: "checkbox",
    });
    await flush();
    const box = cell("Tasks/beta.md", 3).querySelector<HTMLInputElement>("input")!;
    await act(async () => box.click());
    await flush();
    expect(m.notePropertySet).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/vault/Tasks/beta.md", value: false }),
    );
  });

  it("edits a list with chips", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 4);
    await key("Enter");
    const group = cell("Tasks/alpha.md", 4);
    const input = group.querySelector<HTMLInputElement>('input[aria-label="Add item"]')!;
    expect([...group.querySelectorAll("[data-cell-chip]")].map((c) => c.textContent)).toEqual([
      "x×",
      "y×",
    ]);
    await typeInto(input, "new");
    await editorKey(input, "Enter");
    await typeInto(input, "");
    await editorKey(input, "Backspace");
    await editorKey(input, "Backspace");
    await typeInto(input, "last,");
    await editorKey(input, "Enter");
    expect(m.notePropertySet).toHaveBeenCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "tags",
      value: ["x", "last"],
      valueType: "list",
    });
  });

  it("clears the selected cell with Backspace, then undoes and redoes it", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Backspace");
    expect(m.notePropertyRemove).toHaveBeenCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "status",
    });
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("");

    await key("z", { metaKey: true });
    expect(m.notePropertySet).toHaveBeenLastCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "status",
      value: "open",
      valueType: "text",
    });
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("open");

    await key("Z", { metaKey: true, shiftKey: true });
    expect(m.notePropertyRemove).toHaveBeenCalledTimes(2);
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("");
  });

  it("undoes a date edit with the date value type so the file keeps its bytes", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 5);
    await key("Enter");
    const input = cell("Tasks/alpha.md", 5).querySelector<HTMLInputElement>("input")!;
    await typeInto(input, "2025-12-31");
    await editorKey(input, "Enter");
    await key("z", { metaKey: true });
    expect(m.notePropertySet).toHaveBeenLastCalledWith({
      path: "/vault/Tasks/alpha.md",
      name: "due",
      value: "2024-01-05",
      valueType: "date",
    });
    expect(props["/vault/Tasks/alpha.md"]!.due).toBe("2024-01-05");
  });

  it("refuses to undo a cell that changed on disk since", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Backspace");
    props["/vault/Tasks/alpha.md"] = {
      ...props["/vault/Tasks/alpha.md"],
      status: "edited elsewhere",
    };
    await key("z", { metaKey: true });
    expect(notice()!.textContent).toContain("changed since the edit");
    expect(m.notePropertySet).not.toHaveBeenCalled();
    expect(props["/vault/Tasks/alpha.md"]!.status).toBe("edited elsewhere");
  });

  it("undoes a multi-cell clear as one step", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("ArrowDown", { shiftKey: true });
    await key("Delete");
    expect(m.notePropertyRemove).toHaveBeenCalledTimes(2);
    await key("z", { metaKey: true });
    expect(m.notePropertySet).toHaveBeenCalledTimes(2);
    expect(props["/vault/Tasks/alpha.md"]!.status).toBe("open");
    expect(props["/vault/Tasks/beta.md"]!.status).toBe("done");
  });
});

describe("copy and paste", () => {
  async function paste(text: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string };
    };
    event.clipboardData = { getData: () => text };
    await act(async () => {
      grid().dispatchEvent(event);
    });
    await flush();
    return event;
  }

  it("copies the selected block as tab and newline separated text", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("ArrowDown", { shiftKey: true });
    await key("ArrowRight", { shiftKey: true });
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { setData: typeof setData };
    };
    event.clipboardData = { setData };
    await act(async () => {
      grid().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "open\tfalse\ndone\ttrue");
  });

  it("pastes a block starting at the selected cell, as one undo step", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await paste("fresh\tyes\nstale\tno\n");
    expect(m.notePropertySet).toHaveBeenCalledTimes(4);
    expect(props["/vault/Tasks/alpha.md"]).toMatchObject({ status: "fresh", done: true });
    expect(props["/vault/Tasks/beta.md"]).toMatchObject({ status: "stale", done: false });
    await key("z", { metaKey: true });
    expect(props["/vault/Tasks/alpha.md"]).toMatchObject({ status: "open", done: false });
    expect(props["/vault/Tasks/beta.md"]).toMatchObject({ status: "done", done: true });
  });

  it("writes nothing when any pasted cell is invalid or read-only or outside the table", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 3);
    await paste("true\tpast\tnot a date");
    expect(m.notePropertySet).not.toHaveBeenCalled();
    expect(notice()!.textContent).toContain("Nothing pasted");

    await selectCell("Tasks/alpha.md", 5);
    await paste("2024-01-01\tx");
    expect(notice()!.textContent).toMatch(/Nothing pasted: Formula columns/);

    await selectCell("Tasks/gamma.md", 2);
    await paste("a\nb");
    expect(notice()!.textContent).toMatch(/larger than the table/);
    expect(m.notePropertySet).not.toHaveBeenCalled();
  });
});

describe("read-only cells", () => {
  it("explains formula and file columns on the focused cell and refuses to edit them", async () => {
    await mount();
    await selectCell("Tasks/alpha.md", 6);
    expect(cell("Tasks/alpha.md", 6).getAttribute("title")).toMatch(/Formula columns are computed/);
    expect(cell("Tasks/alpha.md", 6).getAttribute("aria-readonly")).toBe("true");
    await key("Enter");
    expect(notice()!.textContent).toMatch(/Formula columns are computed/);
    expect(host.querySelector('input[aria-label="Edit cell"]')).toBeNull();
    await key("Backspace");
    expect(m.notePropertyRemove).not.toHaveBeenCalled();

    await selectCell("Tasks/alpha.md", 1);
    expect(cell("Tasks/alpha.md", 1).getAttribute("title")).toMatch(/File properties/);
  });

  it("explains an error cell", async () => {
    await mount();
    await selectCell("Tasks/gamma.md", 6);
    expect(cell("Tasks/gamma.md", 6).getAttribute("title")).toMatch(/formula/i);
  });

  it("marks a note with unparsable frontmatter read-only after looking it up", async () => {
    frontmatterError["/vault/Tasks/beta.md"] = "line 2: mapping values are not allowed here";
    await mount();
    await selectCell("Tasks/beta.md", 2);
    expect(cell("Tasks/beta.md", 2).getAttribute("title")).toMatch(/frontmatter cannot be parsed/);
    expect(cell("Tasks/beta.md", 2).getAttribute("title")).toContain("mapping values");
    await key("Enter");
    expect(notice()!.textContent).toMatch(/frontmatter cannot be parsed/);
    await key("Backspace");
    expect(m.notePropertyRemove).not.toHaveBeenCalled();
  });

  it("refuses to write a note that is open in an editor with unsaved changes", async () => {
    await mount();
    useEditorStore.setState({
      openFiles: new Map([
        [
          "/vault/Tasks/alpha.md",
          { path: "/vault/Tasks/alpha.md", isDirty: true, saveError: null } as never,
        ],
      ]),
    });
    await selectCell("Tasks/alpha.md", 2);
    expect(cell("Tasks/alpha.md", 2).getAttribute("title")).toMatch(/unsaved changes/);
    await key("Enter");
    expect(notice()!.textContent).toMatch(/unsaved changes/);
    await key("Backspace");
    expect(m.notePropertyRemove).not.toHaveBeenCalled();
    expect(m.notePropertySet).not.toHaveBeenCalled();
  });

  it("reloads a clean open editor after the write", async () => {
    const reload = vi.fn();
    const readFile = await import("../src/lib/tauri");
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "read_file"
        ? { path: "/vault/Tasks/alpha.md", content: "---\nstatus: new\n---\nbody", modified_at: 0 }
        : undefined,
    );
    expect(readFile.readFile).toBeTypeOf("function");
    useEditorStore.setState({
      openFiles: new Map([
        [
          "/vault/Tasks/alpha.md",
          {
            path: "/vault/Tasks/alpha.md",
            isDirty: false,
            saveError: null,
            diskContent: "---\nstatus: open\n---\nbody",
          } as never,
        ],
      ]),
      reloadFromDisk: reload,
    });
    await mount();
    await selectCell("Tasks/alpha.md", 2);
    await key("Backspace");
    expect(reload).toHaveBeenCalledWith("/vault/Tasks/alpha.md", "---\nstatus: new\n---\nbody");
  });
});

describe("links", () => {
  it("opens a resolved link and a file name in a new main tab", async () => {
    const result = taskResult();
    result.rows[0]!.cells[3] = {
      type: "list",
      value: [
        { type: "link", value: { target: "alpha", display: null, resolved: "People/alpha.md" } },
      ],
      display: "alpha",
    };
    m.baseQuery.mockResolvedValue(result);
    const open = vi.fn().mockResolvedValue(undefined);
    useEditorStore.setState({ openFileInNewTab: open });
    await mount();
    await click(cell("Tasks/alpha.md", 4).querySelector("[data-cell-link]")!);
    expect(open).toHaveBeenLastCalledWith("/vault/People/alpha.md");
    await click(cell("Tasks/beta.md", 1).querySelector("[data-cell-link]")!);
    expect(open).toHaveBeenLastCalledWith("/vault/Tasks/beta.md");
  });
});

describe("live updates", () => {
  it("requeries after a debounce when the index changes, once for a burst", async () => {
    await mount();
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await fireIndex({ paths: ["Tasks/new.md"] });
    await fireIndex({ paths: ["Tasks/new2.md"] });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS - 10));
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(20));
    expect(m.baseQuery).toHaveBeenCalledTimes(2);
    expect(m.baseRead).toHaveBeenCalledTimes(1);
  });

  it("re-reads the document when the .base itself changes or the batch is full", async () => {
    await mount();
    vi.useFakeTimers();
    await fireIndex({ paths: [BASE_REL] });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS + 1));
    expect(m.baseRead).toHaveBeenCalledTimes(2);
    expect(m.baseQuery).toHaveBeenCalledTimes(2);
    await fireIndex({ full: true });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS + 1));
    expect(m.baseRead).toHaveBeenCalledTimes(3);
  });

  it("ignores another base, an old epoch and another workspace", async () => {
    await mount();
    vi.useFakeTimers();
    await fireIndex({ paths: ["other.base"] });
    await fireIndex({ paths: ["Tasks/x.md"], epoch: 0 });
    await fireIndex({ paths: ["Tasks/x.md"], root: "/elsewhere" });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS * 3));
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
  });

  it("an inactive tab refreshes when it becomes active, not before", async () => {
    await mount({ isActive: false });
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await fireIndex({ paths: ["Tasks/x.md"] });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS * 3));
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<BaseView location={{ kind: "base", path: BASE_PATH }} isActive tabId="tab-1" />);
    });
    expect(m.baseQuery).toHaveBeenCalledTimes(2);
  });

  it("never lets a slow stale response overwrite a newer one", async () => {
    const stale = Promise.withResolvers<BaseQueryResult>();
    const fresh = Promise.withResolvers<BaseQueryResult>();
    await mount();
    m.baseQuery.mockReset();
    m.baseQuery.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    vi.useFakeTimers();
    await fireIndex({ paths: ["Tasks/a.md"] });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS + 1));
    await fireIndex({ paths: ["Tasks/b.md"] });
    await act(async () => vi.advanceTimersByTime(REQUERY_DEBOUNCE_MS + 1));
    expect(m.baseQuery).toHaveBeenCalledTimes(2);

    const newer = taskResult();
    newer.rows[0]!.cells[1] = { type: "string", value: "NEWER", display: "NEWER" };
    const older = taskResult();
    older.rows[0]!.cells[1] = { type: "string", value: "OLDER", display: "OLDER" };
    await act(async () => fresh.resolve(newer));
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("NEWER");
    await act(async () => stale.resolve(older));
    expect(cell("Tasks/alpha.md", 2).textContent).toBe("NEWER");
    expect(host.querySelector("[data-base-refreshing]")).toBeNull();
  });

  it("unsubscribes when the view unmounts", async () => {
    await mount();
    await act(async () => root.unmount());
    expect(unlisten).toHaveBeenCalled();
    root = createRoot(host);
  });

  it("reports when live updates cannot be subscribed", async () => {
    m.onIndexChanged.mockRejectedValueOnce(new Error("event bus closed"));
    await mount();
    expect(host.textContent).toContain("Live updates are unavailable");
    expect(host.textContent).toContain("event bus closed");
  });
});
