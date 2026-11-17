// @vitest-environment jsdom
// View registry dispatch, cards and list rendering, the config menus and header sorting writing the
// `.base` text, the filter builder with live validation, Results actions. The backend is a fake:
// `baseRead`/`baseWriteText` share one in-memory `.base` text so every assertion is on exact YAML.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({ writeFile: vi.fn(), readFile: vi.fn() }));
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
  baseFunctions: vi.fn(),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { BaseView } from "../src/components/base-view";
import * as ipc from "../src/lib/bases/ipc";
import { resetFunctionRegistry } from "../src/lib/bases/function-registry";
import * as tauri from "../src/lib/tauri";
import type { BaseQueryResult } from "../src/lib/bases/types";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { FUNCTIONS } from "./helpers/bases-functions";
import {
  BASE_PATH,
  baseDocument,
  baseView,
  column,
  groupedResult,
  manyRowsResult,
  str,
  taskResult,
} from "./helpers/bases-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = {
  baseRead: vi.mocked(ipc.baseRead),
  baseQuery: vi.mocked(ipc.baseQuery),
  baseQueryText: vi.mocked(ipc.baseQueryText),
  baseWriteText: vi.mocked(ipc.baseWriteText),
  indexProperties: vi.mocked(ipc.indexProperties),
  onIndexChanged: vi.mocked(ipc.onIndexChanged),
};

const BASE_TEXT = `filters:
  and:
    - file.inFolder("Tasks") # tasks only
views:
  - type: table
    name: Table
    order:
      - file.name
      - status
      - done
      - tags
      - due
      - formula.age
    sort:
      - property: due
        direction: ASC
    columnSize:
      file.name: 300
  - type: cards
    name: Gallery
    order:
      - file.name
      - status
    cardSize: 220
    image: cover
  - type: list
    name: Items
    order:
      - file.name
      - status
  - type: kanban
    name: Board
    groupBy:
      property: status
      direction: ASC
`;

function document_() {
  return baseDocument({
    filters: { and: ['file.inFolder("Tasks")'] },
    views: [
      baseView({
        name: "Table",
        order: ["file.name", "status", "done", "tags", "due", "formula.age"],
        sort: [{ property: "due", direction: "ASC" }],
        columnSize: { "file.name": 300 },
      }),
      baseView({
        type: "cards",
        name: "Gallery",
        order: ["file.name", "status"],
        extra: { cardSize: 220, image: "cover" },
      }),
      baseView({ type: "list", name: "Items", order: ["file.name", "status"] }),
      baseView({
        type: "kanban",
        name: "Board",
        groupBy: { property: "status", direction: "ASC" },
      }),
    ],
  });
}

const VIEWS = [
  { name: "Table", type: "table" },
  { name: "Gallery", type: "cards" },
  { name: "Items", type: "list" },
  { name: "Board", type: "kanban" },
];

/** The task result relabelled as view `index`; cards get a trailing hidden `cover` column. */
function resultFor(index: number, withCover = false): BaseQueryResult {
  const base = taskResult();
  const info = { name: VIEWS[index]!.name, type: VIEWS[index]!.type, index };
  const availableViews = VIEWS.map((v) => v.name);
  if (index === 0) return { ...base, view: info, availableViews };
  const keep = base.columns.slice(0, 2);
  const covers = [
    "#ff8800",
    "https://example.com/c.png",
    "http://example.com/c.png",
    "Attachments/c.png",
  ];
  const columns = withCover ? [...keep, column("cover")] : keep;
  const rows = base.rows.map((r, i) => ({
    path: r.path,
    cells: [...r.cells.slice(0, 2), ...(withCover ? [str(covers[i] ?? "")] : [])],
  }));
  return {
    ...base,
    view: info,
    availableViews,
    columns,
    rows,
    summaries: columns.map(() => null),
    totalMatched: rows.length,
  };
}

let text: string;
let host: HTMLDivElement;
let root: Root;
let openFileInNewTab: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
let openFileAsTextInNewTab: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;

function stubLayout(height = 400, width = 900) {
  for (const [name, value] of [
    ["clientHeight", height],
    ["clientWidth", width],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

function installBackend() {
  m.baseRead.mockImplementation(async () => ({ text, document: document_(), error: null }));
  m.baseQuery.mockImplementation(async (args) => {
    const i = VIEWS.findIndex((v) => v.name === args.view);
    return resultFor(i < 0 ? 0 : i);
  });
  m.baseQueryText.mockImplementation(async (args) => {
    const i = VIEWS.findIndex((v) => v.name === args.view);
    return resultFor(i < 0 ? 0 : i, true);
  });
  m.baseWriteText.mockImplementation(async (_path, content) => {
    text = content;
  });
  m.indexProperties.mockResolvedValue([
    { key: "status", count: 3, types: { text: 3 } },
    { key: "due", count: 2, types: { date: 2 } },
  ]);
  m.onIndexChanged.mockResolvedValue(() => {});
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function mount(view?: string) {
  await act(async () => {
    root.render(
      <BaseView
        location={{ kind: "base", path: BASE_PATH, ...(view ? { view } : {}) }}
        isActive
        tabId="tab-1"
      />,
    );
  });
  await flush();
  await flush();
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : (el as unknown) instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function blur(el: Element) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    (el as HTMLElement).blur();
  });
  await flush();
}

async function pressEnter(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
const byLabel = <T extends Element = HTMLElement>(label: string) =>
  host.querySelector<T>(`[aria-label="${label}"]`)!;

async function openMenu(name: string) {
  await click($(`[data-toolbar-menu="${name}"] button`));
  await flush();
}

const written = () => m.baseWriteText.mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  resetFunctionRegistry();
  vi.mocked(ipc.baseFunctions).mockResolvedValue(FUNCTIONS);
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubLayout();
  text = BASE_TEXT;
  installBackend();
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  openFileInNewTab = vi.fn(async (_path: string) => {});
  openFileAsTextInNewTab = vi.fn(async (_path: string) => {});
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [{ id: "tab-1", location: { kind: "base", path: BASE_PATH }, back: [], forward: [] }],
    activeTabId: "tab-1",
    activeFilePath: null,
    openFileInNewTab,
    openFileAsTextInNewTab,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

// ---------------------------------------------------------------------------

describe("view dispatch", () => {
  it("renders each registered type with its view and the others with the placeholder", async () => {
    await mount("Table");
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
    await mount("Gallery");
    expect(host.querySelector("[data-base-cards]")).not.toBeNull();
    await mount("Items");
    expect(host.querySelector("[data-base-list]")).not.toBeNull();
  });

  it("shows the placeholder naming an unregistered type, with an Edit YAML action", async () => {
    await mount("Board");
    const placeholder = $("[data-base-unsupported]");
    expect(placeholder.getAttribute("data-base-unsupported")).toBe("kanban");
    expect(placeholder.textContent).toContain("“kanban” view type is not available");
    expect(host.querySelector('[role="grid"]')).toBeNull();
    await click(placeholder.querySelector("button")!);
    expect(openFileAsTextInNewTab).toHaveBeenCalledWith(BASE_PATH);
    // The YAML stays untouched: nothing was written.
    expect(m.baseWriteText).not.toHaveBeenCalled();
  });

  it("the toolbar Edit YAML button opens the file as text", async () => {
    await mount();
    await click($("[data-edit-yaml]"));
    expect(openFileAsTextInNewTab).toHaveBeenCalledWith(BASE_PATH);
  });
});

describe("cards view", () => {
  it("asks for the image property without writing it, hides it, and shows images safely", async () => {
    await mount("Gallery");
    // The query text carries the image property appended to `order`; the file is not written.
    const queried = m.baseQueryText.mock.calls.at(-1)![0];
    expect(queried.text).toContain("      - file.name\n      - status\n      - cover\n");
    expect(queried.view).toBe("Gallery");
    expect(m.baseWriteText).not.toHaveBeenCalled();

    const cards = $$("[data-card-path]");
    expect(cards.map((c) => c.getAttribute("data-card-path"))).toEqual([
      "Tasks/alpha.md",
      "Tasks/beta.md",
      "Tasks/gamma.md",
    ]);
    // The hidden cover column is not a property line on the card.
    expect(cards[0]!.textContent).toContain("alpha");
    expect(cards[0]!.textContent).toContain("Status");
    expect(cards[0]!.textContent).not.toContain("#ff8800");
    expect(cards[0]!.style.width).toBe("220px");

    const images = cards.map((c) =>
      c.querySelector("[data-card-image]")!.getAttribute("data-card-image"),
    );
    expect(images).toEqual(["color", "url", "problem"]); // gamma's http: image is refused
    expect(
      (cards[0]!.querySelector("[data-card-image]") as HTMLElement).style.backgroundColor,
    ).not.toBe("");
    expect(cards[1]!.querySelector("img")!.getAttribute("src")).toBe("https://example.com/c.png");
    expect(cards[1]!.querySelector("img")!.style.objectFit).toBe("cover");
    expect(cards[2]!.querySelector("img")).toBeNull();
    expect(cards[2]!.querySelector("[data-card-image]")!.getAttribute("title")).toContain("https");
  });

  it("loads a vault image through the asset URL of its absolute path", async () => {
    m.baseQueryText.mockImplementation(async () => {
      const r = resultFor(1, true);
      r.rows[0]!.cells[2] = str("Attachments/c.png");
      return r;
    });
    await mount("Gallery");
    expect(host.querySelector("[data-card-path] img")!.getAttribute("src")).toBe(
      "asset://localhost/vault/Attachments/c.png",
    );
  });

  it("renders only a window of a large result", async () => {
    m.baseQueryText.mockImplementation(async () => {
      const big = manyRowsResult(5000);
      return { ...big, view: { name: "Gallery", type: "cards", index: 1 } };
    });
    await mount("Gallery");
    const rendered = $$("[data-card-path]").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(120);
    expect(host.querySelector("[data-base-cards] > div")!.getAttribute("style")).toContain(
      "height",
    );
  });

  it("opens the file on card click and the file name link, and shows groups with collapse", async () => {
    m.baseQueryText.mockImplementation(async () => ({
      ...groupedResult(),
      view: { name: "Gallery", type: "cards", index: 1 },
    }));
    await mount("Gallery");
    expect($$("[data-group-header]")).toHaveLength(2);
    expect($$("[data-group-count]").map((c) => c.textContent)).toEqual(["2", "1"]);
    await click($("[data-card-path='Tasks/beta.md']"));
    expect(openFileInNewTab).toHaveBeenCalledWith("/vault/Tasks/beta.md");
    await click(byLabel("Collapse group open"));
    expect(host.querySelector("[data-card-path='Tasks/alpha.md']")).toBeNull();
    expect(host.querySelector("[data-card-path='Tasks/gamma.md']")).not.toBeNull();
    await click(byLabel("Expand group open"));
    expect(host.querySelector("[data-card-path='Tasks/alpha.md']")).not.toBeNull();
  });
});

describe("list view", () => {
  async function mountList(extra: Record<string, unknown>) {
    const doc = document_();
    doc.views[2]!.extra = extra;
    m.baseRead.mockImplementation(async () => ({ text, document: doc, error: null }));
    await mount("Items");
  }

  it("bullets with comma separators by default", async () => {
    await mountList({});
    expect($$("[data-list-marker]").map((e) => e.textContent)).toEqual(["•", "•", "•"]);
    const first = $("[data-list-row='Tasks/alpha.md']");
    expect(first.textContent).toBe("•alpha, open");
    // gamma has no status: no dangling separator.
    expect($("[data-list-row='Tasks/gamma.md']").textContent).toBe("•gamma");
  });

  it("numbers, custom separator", async () => {
    await mountList({ markers: "numbers", separator: " | " });
    expect($$("[data-list-marker]").map((e) => e.textContent)).toEqual(["1.", "2.", "3."]);
    expect($("[data-list-row='Tasks/beta.md']").textContent).toBe("2.beta | done");
  });

  it("no markers and indented properties", async () => {
    await mountList({ markers: "none", indentProperties: true });
    expect(host.querySelector("[data-list-marker]")).toBeNull();
    const nested = $$("[data-list-nested]");
    expect(nested.map((n) => n.textContent)).toEqual(["Statusopen", "Statusdone"]);
  });

  it("groups restart numbering and collapse", async () => {
    const doc = document_();
    doc.views[2]!.extra = { markers: "numbers" };
    m.baseRead.mockImplementation(async () => ({ text, document: doc, error: null }));
    m.baseQuery.mockImplementation(async () => ({
      ...groupedResult(),
      view: { name: "Items", type: "list", index: 2 },
      columns: groupedResult().columns.slice(0, 2),
      rows: groupedResult().rows.map((r) => ({ ...r, cells: r.cells.slice(0, 2) })),
    }));
    await mount("Items");
    expect($$("[data-list-marker]").map((e) => e.textContent)).toEqual(["1.", "2.", "1."]);
    await click(byLabel("Collapse group open"));
    expect($$("[data-list-marker]")).toHaveLength(1);
  });

  it("a link click opens the file like the table", async () => {
    await mountList({});
    await click($("[data-list-row='Tasks/alpha.md'] [data-cell-link]"));
    expect(openFileInNewTab).toHaveBeenCalledWith("/vault/Tasks/alpha.md");
  });
});

describe("header sorting persists into the YAML", () => {
  it("cycles the sorted column asc to desc, and writes only that node", async () => {
    await mount();
    await click(byLabel("Sort by Due"));
    expect(written()).toEqual([BASE_TEXT.replace("direction: ASC", "direction: DESC")]);
    expect(m.baseWriteText.mock.calls[0]![0]).toBe(BASE_PATH);
    // The document is reloaded after the write.
    expect(m.baseRead.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("an unsorted column becomes the only sort key; shift appends", async () => {
    await mount();
    await click(byLabel("Sort by Status"));
    expect(written()[0]).toBe(
      BASE_TEXT.replace(
        "      - property: due\n        direction: ASC",
        "      - property: status\n        direction: ASC",
      ),
    );
    text = BASE_TEXT;
    await act(async () => {
      byLabel("Sort by Status").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
      );
    });
    await flush();
    expect(written()[1]).toBe(
      BASE_TEXT.replace(
        "        direction: ASC\n    columnSize",
        "        direction: ASC\n      - property: status\n        direction: ASC\n    columnSize",
      ),
    );
  });

  it("refuses while the .base is open in a text tab with unsaved changes", async () => {
    useEditorStore.setState({
      openFiles: new Map([
        [BASE_PATH, { path: BASE_PATH, isDirty: true, saveError: null } as never],
      ]),
    });
    await mount();
    await click(byLabel("Sort by Due"));
    expect(m.baseWriteText).not.toHaveBeenCalled();
    expect($("[data-base-notice='error']").textContent).toContain("unsaved changes");
  });

  it("shows a write failure and leaves the view as it was", async () => {
    m.baseWriteText.mockRejectedValueOnce(new Error("disk full"));
    await mount();
    await click(byLabel("Sort by Due"));
    expect($("[data-base-notice='error']").textContent).toContain("disk full");
  });
});

describe("column resize", () => {
  it("persists the dragged width into columnSize", async () => {
    await mount();
    const handle = $$("[data-resize-handle]")[0]!;
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100 }),
      );
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
      handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 160 }));
    });
    await flush();
    expect(written()).toEqual([BASE_TEXT.replace("file.name: 300", "file.name: 360")]);
  });

  it("a click on the handle writes nothing", async () => {
    await mount();
    const handle = $$("[data-resize-handle]")[0]!;
    await act(async () => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100 }),
      );
      handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    });
    await flush();
    expect(m.baseWriteText).not.toHaveBeenCalled();
  });
});

describe("column fit (double-click on the divider)", () => {
  beforeEach(() => {
    // jsdom has no canvas: 10px per character.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (t: string) => ({ width: t.length * 10 }),
    } as unknown as CanvasRenderingContext2D);
  });

  it("writes the fitted width once, through the resize path, and does not sort", async () => {
    await mount();
    const handle = $$("[data-resize-handle]")[0]!;
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      handle.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true }),
      );
    });
    await flush();
    // Widest of "Name" (40) and "alpha"/"gamma" (50), plus 17 of chrome, replacing 300.
    expect(written()).toEqual([BASE_TEXT.replace("file.name: 300", "file.name: 67")]);
  });
});

describe("config menus write exact YAML", () => {
  it("sort menu: add, change direction, remove", async () => {
    await mount();
    await openMenu("Sort");
    expect(m.indexProperties).toHaveBeenCalled();
    await change(byLabel<HTMLSelectElement>("Add sort"), "status");
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "        direction: ASC\n    columnSize",
        "        direction: ASC\n      - property: status\n        direction: ASC\n    columnSize",
      ),
    );
    text = BASE_TEXT;
    await change(byLabel<HTMLSelectElement>("Sort direction 1"), "DESC");
    expect(written().at(-1)).toBe(BASE_TEXT.replace("direction: ASC", "direction: DESC"));
    await click(byLabel("Remove sort 1"));
    expect(written().at(-1)).not.toContain("sort:");
    expect(written().at(-1)).toContain("columnSize:\n      file.name: 300");
  });

  it("group menu sets and clears groupBy", async () => {
    await mount();
    await openMenu("Group");
    await change(byLabel<HTMLSelectElement>("Group by"), "status");
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "    columnSize:\n      file.name: 300\n",
        "    columnSize:\n      file.name: 300\n    groupBy:\n      property: status\n      direction: ASC\n",
      ),
    );
  });

  it("properties menu: display name, reorder, hide, add", async () => {
    await mount();
    await openMenu("Properties");
    const name = byLabel<HTMLInputElement>("Display name of due");
    await change(name, "Deadline");
    await pressEnter(name);
    expect(written().at(-1)).toBe(`${BASE_TEXT}properties:\n  due:\n    displayName: Deadline\n`);
    expect(written().at(-1)).toContain("properties:\n  due:\n    displayName: Deadline\n");
    expect(written().at(-1)).toContain("# tasks only");

    text = BASE_TEXT;
    await click(byLabel("Move Status up"));
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "      - file.name\n      - status\n      - done\n",
        "      - status\n      - file.name\n      - done\n",
      ),
    );
    text = BASE_TEXT;
    await click(byLabel("Hide Done"));
    expect(written().at(-1)).toContain("      - status\n      - tags\n      - due\n");
    expect(written().at(-1)).not.toContain("      - done\n");
    text = BASE_TEXT;
    await change(byLabel<HTMLSelectElement>("Add property"), "file.path");
    expect(written().at(-1)).toContain("      - formula.age\n      - file.path\n    sort:");
  });

  it("results menu: limit set and cleared, invalid limits refused", async () => {
    await mount();
    await openMenu("Results");
    const limit = byLabel<HTMLInputElement>("Result limit");
    await change(limit, "25");
    await pressEnter(limit);
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "    columnSize:\n      file.name: 300\n",
        "    columnSize:\n      file.name: 300\n    limit: 25\n",
      ),
    );
    await change(limit, "0");
    await pressEnter(limit);
    expect($("[data-base-notice='error']").textContent).toContain("whole number of at least 1");
  });

  it("view menu: add, rename, duplicate, reorder, delete", async () => {
    await mount();
    await openMenu("View");
    await click(
      [...$$("button")].find((b) => b.textContent === "List" && b.title.startsWith("Add"))!,
    );
    expect(written().at(-1)).toBe(`${BASE_TEXT}  - type: list\n    name: List\n`);

    text = BASE_TEXT;
    await openMenu("View");
    const name = byLabel<HTMLInputElement>("View name");
    await change(name, "Tasks");
    await pressEnter(name);
    expect(written().at(-1)).toBe(BASE_TEXT.replace("    name: Table\n", "    name: Tasks\n"));
    expect(useEditorStore.getState().tabs[0]!.location).toEqual({
      kind: "base",
      path: BASE_PATH,
      view: "Tasks",
    });

    text = BASE_TEXT;
    await openMenu("View");
    await click([...$$("button")].find((b) => b.textContent === "Move right")!);
    const moved = written().at(-1)!;
    expect(moved.indexOf("name: Gallery")).toBeLessThan(moved.indexOf("name: Table"));

    text = BASE_TEXT;
    await openMenu("View");
    await click([...$$("button")].find((b) => b.textContent === "Duplicate")!);
    expect(written().at(-1)).toContain("name: Table copy");
    expect(
      written()
        .at(-1)!
        .match(/columnSize:/g),
    ).toHaveLength(2);

    text = BASE_TEXT;
    await openMenu("View");
    await click([...$$("button")].find((b) => b.textContent === "Delete")!);
    const writes = m.baseWriteText.mock.calls.length; // the first click only asks to confirm
    await click([...$$("button")].find((b) => b.textContent === "Confirm delete")!);
    expect(m.baseWriteText.mock.calls.length).toBe(writes + 1);
    expect(written().at(-1)).not.toContain("name: Table\n");
    expect(written().at(-1)).toContain("# tasks only");
  });

  it("view settings persist option values under their keys", async () => {
    await mount("Gallery");
    await openMenu("Settings");
    const slider = byLabel<HTMLInputElement>("Card size");
    await change(slider, "300");
    await blur(slider);
    expect(written().at(-1)).toBe(BASE_TEXT.replace("cardSize: 220", "cardSize: 300"));
    text = BASE_TEXT;
    await change(byLabel<HTMLSelectElement>("Image fit"), "contain");
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace("    image: cover\n", "    image: cover\n    imageFit: contain\n"),
    );
  });
});

describe("filter builder", () => {
  async function addRow() {
    await openMenu("Filter");
    await click([...$$("button")].find((b) => b.textContent === "Add filter")!);
  }
  const apply = () => [...$$("button")].find((b) => b.textContent === "Apply")!;

  it("compiles rows to expression strings and saves them for this view", async () => {
    m.baseQueryText.mockImplementation(async () => resultFor(0));
    await mount();
    await addRow();
    await change(byLabel<HTMLSelectElement>("Filter property"), "status");
    await change(byLabel<HTMLSelectElement>("Filter operator"), "is");
    await change(byLabel<HTMLInputElement>("Filter value"), "open");
    expect($("[data-filter-row] code").textContent).toBe('status == "open"');
    await flush(400);
    expect(m.baseQueryText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('filters: "status == \\"open\\""'),
        thisPath: BASE_PATH,
      }),
    );
    expect((apply() as HTMLButtonElement).disabled).toBe(false);
    await click(apply());
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "    columnSize:\n      file.name: 300\n",
        '    columnSize:\n      file.name: 300\n    filters:\n      and:\n        - status == "open"\n',
      ),
    );
  });

  it("base-wide scope edits the top-level filters and keeps the existing leaf", async () => {
    m.baseQueryText.mockImplementation(async () => resultFor(0));
    await mount();
    await openMenu("Filter");
    await click(byLabel("Filter scope").querySelectorAll("button")[1]!);
    // The existing leaf is not one the builder wrote: it is edited as a raw expression.
    expect(byLabel<HTMLTextAreaElement>("Filter expression").value).toBe('file.inFolder("Tasks")');
    await change(byLabel<HTMLSelectElement>("Combine filters"), "or");
    await flush(400);
    await click(apply());
    expect(written().at(-1)).toContain('filters:\n  or:\n    - file.inFolder("Tasks")\n');
  });

  it("an invalid expression shows its error inline and nothing is saved", async () => {
    m.baseQueryText.mockImplementation(async () => ({
      ...resultFor(0),
      error: {
        kind: "filterSyntax",
        message: "unexpected token at 5",
        expression: "len(x) >",
        path: null,
      },
    }));
    await mount();
    await openMenu("Filter");
    await click([...$$("button")].find((b) => b.textContent === "Add expression")!);
    const area = byLabel<HTMLTextAreaElement>("Filter expression");
    await change(area as unknown as HTMLInputElement, "len(x) >");
    await flush(400);
    expect($("[data-filter-error]").textContent).toBe("unexpected token at 5");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    await click(apply());
    expect(m.baseWriteText).not.toHaveBeenCalled();
  });

  it("an empty expression and a failed validation call are invalid too", async () => {
    await mount();
    await openMenu("Filter");
    await click([...$$("button")].find((b) => b.textContent === "Add expression")!);
    await flush(400);
    expect($("[data-filter-error]").textContent).toBe("The expression is empty");
    m.baseQueryText.mockRejectedValueOnce(new Error("index is still being built"));
    await change(byLabel("Filter expression") as unknown as HTMLInputElement, "a == 1");
    await flush(400);
    expect($("[data-filter-error]").textContent).toContain("still being built");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("results actions", () => {
  it("copies the shown rows as a markdown table", async () => {
    await mount();
    await openMenu("Results");
    await click([...$$("button")].find((b) => b.textContent === "Copy results to clipboard")!);
    const copied = vi.mocked(writeText).mock.calls[0]![0];
    expect(copied.split("\n").slice(0, 2)).toEqual([
      "| Name | Status | Done | Tags | Due | Age |",
      "| --- | --- | --- | --- | --- | --- |",
    ]);
    expect(copied).toContain("| alpha | open | false | x, y | 2024-01-05 | 3 |");
    expect($("[data-base-notice='info']").textContent).toContain("Copied 3 rows");
  });

  it("exports CSV through the save dialog and the file write path", async () => {
    vi.mocked(save).mockResolvedValue("/vault/tasks.csv");
    vi.mocked(tauri.writeFile).mockResolvedValue({
      path: "/vault/tasks.csv",
      modifiedAt: 1,
    } as never);
    await mount();
    await openMenu("Results");
    await click([...$$("button")].find((b) => b.textContent === "Export CSV…")!);
    expect(vi.mocked(save).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ defaultPath: "/vault/tasks.csv" }),
    );
    const [path, content] = vi.mocked(tauri.writeFile).mock.calls[0]!;
    expect(path).toBe("/vault/tasks.csv");
    expect(content.split("\n")[0]).toBe("Name,Status,Done,Tags,Due,Age");
    expect(content).toContain("beta,done,true,z,2024-02-10,9");
    expect($("[data-base-notice='info']").textContent).toContain(
      "Exported 3 rows to /vault/tasks.csv",
    );
  });

  it("a cancelled dialog writes nothing; a failed write is reported", async () => {
    vi.mocked(save).mockResolvedValueOnce(null);
    await mount();
    await openMenu("Results");
    await click([...$$("button")].find((b) => b.textContent === "Export CSV…")!);
    expect(tauri.writeFile).not.toHaveBeenCalled();
    vi.mocked(save).mockResolvedValueOnce("/elsewhere/x.csv");
    vi.mocked(tauri.writeFile).mockRejectedValueOnce("path is outside the workspace");
    await openMenu("Results");
    await click([...$$("button")].find((b) => b.textContent === "Export CSV…")!);
    expect($("[data-base-notice='error']").textContent).toContain("outside the workspace");
  });
});
