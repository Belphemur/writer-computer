// @vitest-environment jsdom
// Sticky group headers (table, cards, list), group order editing in the Group menu, collapse state
// kept per view, and the formula editor's completion wired into the menus. The backend is a fake:
// `baseRead`/`baseWriteText` share one in-memory `.base` text so assertions are on exact YAML.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ writeFile: vi.fn(), readFile: vi.fn() }));
vi.mock("../web/ipc", () => ({
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

import { BaseView } from "../web/view";
import { resetFunctionRegistry } from "../web/lib/function-registry";
import * as ipc from "../web/ipc";
import type { BaseQueryResult } from "../web/lib/types";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { FUNCTIONS } from "./helpers/bases-functions";
import { BASE_PATH, baseDocument, baseView, manyGroupsResult } from "./helpers/bases-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = {
  baseRead: vi.mocked(ipc.baseRead),
  baseQuery: vi.mocked(ipc.baseQuery),
  baseQueryText: vi.mocked(ipc.baseQueryText),
  baseWriteText: vi.mocked(ipc.baseWriteText),
  indexProperties: vi.mocked(ipc.indexProperties),
  onIndexChanged: vi.mocked(ipc.onIndexChanged),
};

const GROUPS = 30;
const PER_GROUP = 40;

const BASE_TEXT = `# grouped
formulas:
  age: file.size
views:
  - type: table
    name: Table
    order:
      - file.name
      - n
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - g1 # urgent
      - g0
  - type: table
    name: Second
    groupBy:
      property: status
      direction: DESC
  - type: cards
    name: Gallery
    groupBy:
      property: status
      direction: ASC
  - type: list
    name: Items
    groupBy:
      property: status
      direction: ASC
`;

const VIEWS = [
  { name: "Table", type: "table" },
  { name: "Second", type: "table" },
  { name: "Gallery", type: "cards" },
  { name: "Items", type: "list" },
];

function documentFor() {
  return baseDocument({
    formulas: { age: "file.size" },
    views: [
      baseView({
        name: "Table",
        order: ["file.name", "n"],
        groupBy: { property: "status", direction: "ASC" },
        groupOrder: ["g1", "g0"],
      }),
      baseView({ name: "Second", groupBy: { property: "status", direction: "DESC" } }),
      baseView({
        type: "cards",
        name: "Gallery",
        groupBy: { property: "status", direction: "ASC" },
      }),
      baseView({ type: "list", name: "Items", groupBy: { property: "status", direction: "ASC" } }),
    ],
  });
}

function resultFor(index: number): BaseQueryResult {
  const base = manyGroupsResult(GROUPS, PER_GROUP, VIEWS[index]!.type);
  return {
    ...base,
    view: { name: VIEWS[index]!.name, type: VIEWS[index]!.type, index },
    availableViews: VIEWS.map((v) => v.name),
  };
}

let text: string;
let host: HTMLDivElement;
let root: Root;

function stubLayout(height = 400, width = 900) {
  for (const [name, value] of [
    ["clientHeight", height],
    ["clientWidth", width],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

function installBackend() {
  m.baseRead.mockImplementation(async () => ({ text, document: documentFor(), error: null }));
  m.baseQuery.mockImplementation(async (args) => {
    const i = VIEWS.findIndex((v) => v.name === args.view);
    return resultFor(i < 0 ? 0 : i);
  });
  m.baseQueryText.mockImplementation(async () => resultFor(0));
  m.baseWriteText.mockImplementation(async (_path, content) => {
    text = content;
  });
  m.indexProperties.mockResolvedValue([
    { key: "status", count: 3, types: { text: 3 } },
    { key: "due", count: 2, types: { date: 2 } },
  ]);
  m.onIndexChanged.mockResolvedValue(() => {});
  vi.mocked(ipc.noteProperties).mockResolvedValue({
    properties: {},
    order: [],
    types: {},
    error: null,
  });
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

async function change(
  el: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
  await flush();
}

async function keydown(el: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
const byLabel = <T extends Element = HTMLElement>(label: string) =>
  host.querySelector<T>(`[aria-label="${label}"]`)!;
const written = () => m.baseWriteText.mock.calls.map((c) => c[1]);

async function openMenu(name: string) {
  await click($(`[data-toolbar-menu="${name}"] button`));
}

async function scrollTo(el: HTMLElement, top: number) {
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFunctionRegistry();
  vi.mocked(ipc.baseFunctions).mockResolvedValue(FUNCTIONS);
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubLayout();
  text = BASE_TEXT;
  installBackend();
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [{ id: "tab-1", location: { kind: "base", path: BASE_PATH }, back: [], forward: [] }],
    activeTabId: "tab-1",
    activeFilePath: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.getElementById("writer-popup-layer")?.remove();
});

// ---------------------------------------------------------------------------

describe("sticky group headers: table", () => {
  const ROW = 28;
  const HEADER = 32;
  const COLUMN_HEADER = 32;
  /** scrollTop at which item `item` of the flattened table starts. */
  const groupSpan = HEADER + PER_GROUP * ROW;
  const headerTop = (g: number) => COLUMN_HEADER + g * groupSpan;
  const grid = () => $<HTMLDivElement>("[data-base-grid]");
  const pinned = () => $$<HTMLElement>("[data-sticky-group]");
  const headers = () => $$<HTMLElement>("[data-group-header]");

  it("pins the first group header at the top before any scrolling", async () => {
    await mount("Second");
    expect(pinned()).toHaveLength(1);
    expect(pinned()[0]!.textContent).toContain("g0");
    expect(pinned()[0]!.style.position).toBe("sticky");
    // under the column header row
    expect(pinned()[0]!.style.top).toBe(`${COLUMN_HEADER}px`);
  });

  it("pins the group whose rows are on screen and replaces it as the next one arrives", async () => {
    await mount("Second");
    await scrollTo(grid(), headerTop(3) + HEADER + 10 * ROW);
    expect(pinned()).toHaveLength(1);
    expect(pinned()[0]!.querySelector("[data-group-count]")).not.toBeNull();
    expect(pinned()[0]!.textContent).toContain("g3");
    // its own slot has scrolled out of the window but it is still rendered, once
    expect(headers().filter((h) => h.textContent?.includes("g3"))).toHaveLength(1);

    // one pixel before the next header reaches the top: still g3
    await scrollTo(grid(), headerTop(4) - 1);
    expect(pinned()[0]!.textContent).toContain("g3");
    // the next header has reached the top: g4 takes over
    await scrollTo(grid(), headerTop(4) + 5);
    expect(pinned()).toHaveLength(1);
    expect(pinned()[0]!.textContent).toContain("g4");
    expect(headers().filter((h) => h.textContent?.includes("g3"))).toHaveLength(0);

    await scrollTo(grid(), 0);
    expect(pinned()[0]!.textContent).toContain("g0");
  });

  it("keeps aria-rowcount, row indices and the window size", async () => {
    await mount("Second");
    const count = GROUPS * (1 + PER_GROUP) + 1;
    expect(grid().getAttribute("aria-rowcount")).toBe(String(count));
    await scrollTo(grid(), headerTop(20) + HEADER + 5 * ROW);
    expect(grid().getAttribute("aria-rowcount")).toBe(String(count));
    const rows = $$("[data-row-path], [data-group-header]");
    expect(rows.length).toBeLessThan(60);
    const idx = (el: Element) => Number(el.getAttribute("aria-rowindex"));
    const pinnedRow = pinned()[0]!;
    // group 20 header is item 20 * 41, aria-rowindex = item + 2
    expect(idx(pinnedRow)).toBe(20 * (1 + PER_GROUP) + 2);
    for (const r of rows) expect(idx(r)).toBeGreaterThanOrEqual(2);
  });

  it("collapses the pinned group from the pinned header", async () => {
    await mount("Second");
    await scrollTo(grid(), headerTop(2) + HEADER + 3 * ROW);
    const count = Number(grid().getAttribute("aria-rowcount"));
    await click(pinned()[0]!.querySelector("button")!);
    expect(grid().getAttribute("aria-rowcount")).toBe(String(count - PER_GROUP));
    expect(
      $$<HTMLElement>("[data-group-header] button")
        .find((b) => b.getAttribute("aria-label")?.includes("group g2"))!
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps keyboard navigation working while a header is pinned", async () => {
    await mount("Second");
    await scrollTo(grid(), headerTop(1) + HEADER + 3 * ROW);
    const cell = $<HTMLElement>("[data-row-path] [role='gridcell']");
    await act(async () => {
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const before = grid().getAttribute("aria-activedescendant");
    expect(before).toBeTruthy();
    await keydown(grid(), "ArrowDown");
    expect(grid().getAttribute("aria-activedescendant")).not.toBe(before);
  });

  it("has no pinned header without groups", async () => {
    m.baseQuery.mockImplementation(async () => ({
      ...resultFor(0),
      groups: null,
    }));
    await mount();
    expect(pinned()).toHaveLength(0);
  });
});

describe("sticky group headers: list and cards", () => {
  it("list: pins the active group header at the top of the scroller", async () => {
    await mount("Items");
    const scroller = $<HTMLDivElement>("[data-base-list]");
    const row = 24;
    const span = 32 + PER_GROUP * row;
    expect($$("[data-sticky-group]")[0]!.textContent).toContain("g0");
    await scrollTo(scroller, 3 * span + 32 + 10 * row);
    const pinned = $$<HTMLElement>("[data-sticky-group]");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.getAttribute("role")).toBe("listitem");
    expect(pinned[0]!.style.position).toBe("sticky");
    expect(pinned[0]!.style.top).toBe("0px");
    expect(pinned[0]!.textContent).toContain("g3");
    expect($$("[data-group-header]").filter((h) => h.textContent?.includes("g3"))).toHaveLength(1);
    await scrollTo(scroller, 4 * span + 4);
    expect($$("[data-sticky-group]")[0]!.textContent).toContain("g4");
    // the window stays small: 1200 rows are not in the DOM
    expect($$("[data-list-row]").length).toBeLessThan(60);
  });

  it("cards: pins the active group header", async () => {
    await mount("Gallery");
    const scroller = $<HTMLDivElement>("[data-base-cards]");
    expect($$("[data-sticky-group]")[0]!.textContent).toContain("g0");
    // 4 cards per row at 900px / 200px cards; rows are 60 + 12 px; 10 card rows per group
    const span = 32 + 10 * 72;
    await scrollTo(scroller, 5 * span + 32 + 3 * 72);
    const pinned = $$<HTMLElement>("[data-sticky-group]");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.textContent).toContain("g5");
    expect($$("[data-card]").length).toBeLessThan(60);
  });

  it("list: collapsing the pinned group removes its rows and keeps one pinned header", async () => {
    await mount("Items");
    const scroller = $<HTMLDivElement>("[data-base-list]");
    await scrollTo(scroller, 2 * (32 + PER_GROUP * 24) + 32 + 5 * 24);
    await click($$<HTMLElement>("[data-sticky-group] button")[0]!);
    expect($$("[data-sticky-group]")).toHaveLength(1);
    expect(
      $$("[data-list-row]").every((r) => !r.getAttribute("data-list-row")!.includes("g2-")),
    ).toBe(true);
  });
});

describe("collapse state", () => {
  it("is kept per view while the tab is open", async () => {
    await mount("Second");
    const toggleOf = (g: string) =>
      $$<HTMLElement>("[data-group-header] button").find((b) =>
        b.getAttribute("aria-label")?.endsWith(`group ${g}`),
      )!;
    await click(toggleOf("g0"));
    expect(toggleOf("g0").getAttribute("aria-expanded")).toBe("false");
    // another view of the same base starts expanded
    await mount("Table");
    expect(toggleOf("g0").getAttribute("aria-expanded")).toBe("true");
    // and the first view still has it collapsed
    await mount("Second");
    expect(toggleOf("g0").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("group order editing", () => {
  const rowsText = () => $$("[data-group-order-row] [tabindex='0']").map((r) => r.textContent);
  const mode = () => $("[data-group-order-mode]").textContent;

  it("shows the explicit list in order with its mode", async () => {
    await mount("Table");
    await openMenu("Group");
    expect(mode()).toBe("Manual");
    expect(rowsText()).toEqual(["g1", "g0"]);
    expect(byLabel("g1, position 1 of 2")).not.toBeNull();
    expect(byLabel<HTMLButtonElement>("Move g1 up").disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>("Move g0 down").disabled).toBe(true);
  });

  it("shows automatic mode with the direction when there is no list", async () => {
    await mount("Second");
    await openMenu("Group");
    expect(mode()).toBe("Automatic (descending)");
    expect(host.querySelector("[data-group-order-row]")).toBeNull();
    expect(host.textContent).not.toContain("Reset to automatic");
  });

  it("moves an entry down with the button, touching only the list", async () => {
    await mount("Table");
    await openMenu("Group");
    await click(byLabel("Move g1 down"));
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace("      - g1 # urgent\n      - g0\n", "      - g0\n      - g1 # urgent\n"),
    );
  });

  it("moves with Alt+Arrow and removes with Delete on a focused row", async () => {
    await mount("Table");
    await openMenu("Group");
    await keydown(byLabel("g0, position 2 of 2"), "ArrowUp", { altKey: true });
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace("      - g1 # urgent\n      - g0\n", "      - g0\n      - g1 # urgent\n"),
    );
    text = BASE_TEXT;
    await keydown(byLabel("g1, position 1 of 2"), "Delete");
    expect(written().at(-1)).toBe(BASE_TEXT.replace("      - g1 # urgent\n", ""));
  });

  it("removes an entry with the button", async () => {
    await mount("Table");
    await openMenu("Group");
    await click(byLabel("Remove g0 from the order"));
    expect(written().at(-1)).toBe(BASE_TEXT.replace("      - g0\n", ""));
  });

  it("adds a value present in the groups, not one that is already listed", async () => {
    await mount("Table");
    await openMenu("Group");
    const add = byLabel<HTMLSelectElement>("Add group value");
    const options = [...add.options].map((o) => o.textContent);
    expect(options).toContain("g2");
    expect(options).not.toContain("g0");
    expect(options).not.toContain("g1");
    await change(add, String([...add.options].findIndex((o) => o.textContent === "g2") - 1));
    expect(written().at(-1)).toBe(BASE_TEXT.replace("      - g0\n", "      - g0\n      - g2\n"));
  });

  it("adds the first value to a view without a list, creating the key", async () => {
    await mount("Second");
    await openMenu("Group");
    const add = byLabel<HTMLSelectElement>("Add group value");
    await change(add, "0");
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace(
        "      direction: DESC\n",
        "      direction: DESC\n    groupOrder:\n      - g0\n",
      ),
    );
  });

  it("resets to automatic by removing the key", async () => {
    await mount("Table");
    await openMenu("Group");
    await click([...$$("button")].find((b) => b.textContent === "Reset to automatic")!);
    expect(written().at(-1)).toBe(
      BASE_TEXT.replace("    groupOrder:\n      - g1 # urgent\n      - g0\n", ""),
    );
  });

  it("has no group order section without grouping", async () => {
    m.baseRead.mockImplementation(async () => ({
      text,
      document: baseDocument({ views: [baseView({ name: "Table" })] }),
      error: null,
    }));
    m.baseQuery.mockImplementation(async () => ({ ...resultFor(0), groups: null }));
    await mount();
    await openMenu("Group");
    expect(host.querySelector("[data-group-order]")).toBeNull();
  });

  it("lists group values that cannot be ordered instead of hiding them", async () => {
    m.baseQuery.mockImplementation(async () => {
      const r = resultFor(0);
      return {
        ...r,
        groups: [
          ...r.groups!.slice(0, 2),
          {
            ...r.groups![2]!,
            key: { type: "date", value: "2024-01-01", hasTime: false, display: "2024-01-01" },
          },
        ],
        rows: r.rows.slice(0, r.groups![0]!.len * 2 + r.groups![2]!.len),
      };
    });
    await mount("Table");
    await openMenu("Group");
    expect($("[data-group-order-blocked]").textContent).toContain("2024-01-01");
    expect($("[data-group-order-blocked]").textContent).toContain(
      "date values cannot be ordered by hand",
    );
  });

  it("dims a listed entry that no group has any more", async () => {
    m.baseRead.mockImplementation(async () => {
      const doc = documentFor();
      doc.views[0]!.groupOrder = ["gone", "g0"];
      return { text, document: doc, error: null };
    });
    await mount("Table");
    await openMenu("Group");
    const gone = byLabel("gone, position 1 of 2");
    expect(gone.title).toContain("No group has this value");
    expect(byLabel("g0, position 2 of 2").title).toBe("");
  });
});

describe("formula editor", () => {
  const field = () => byLabel<HTMLTextAreaElement>("Formula expression");
  const popupLayer = () => document.getElementById("writer-popup-layer");
  const options = () =>
    [...(popupLayer()?.querySelectorAll("[role='option']") ?? [])].map(
      (o) => o.querySelector("span span")?.textContent,
    );

  async function type(value: string) {
    await act(async () => field().focus());
    await change(field(), value);
  }

  it("adds a formula and its column in one write", async () => {
    await mount("Table");
    await openMenu("Properties");
    await change(byLabel<HTMLInputElement>("Formula name"), "size_kb");
    await type("file.size");
    await click([...$$("button")].find((b) => b.textContent === "Add formula")!);
    const out = written().at(-1)!;
    expect(out).toContain("formulas:\n  age: file.size\n  size_kb: file.size\n");
    expect(out).toContain("      - file.name\n      - n\n      - formula.size_kb\n");
    expect(byLabel<HTMLInputElement>("Formula name").value).toBe("");
  });

  it("refuses a duplicate name with a visible error and writes nothing", async () => {
    await mount("Table");
    await openMenu("Properties");
    await change(byLabel<HTMLInputElement>("Formula name"), "age");
    await type("1");
    await click([...$$("button")].find((b) => b.textContent === "Add formula")!);
    expect(m.baseWriteText).not.toHaveBeenCalled();
    expect($("[data-base-notice='error']").textContent).toContain('"age" already exists');
  });

  it("completes in the field: ARIA combobox and listbox, in the popup layer", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("file.na");
    expect(field().getAttribute("role")).toBe("combobox");
    expect(field().getAttribute("aria-expanded")).toBe("true");
    const list = popupLayer()!.querySelector("[role='listbox']")!;
    expect(list).not.toBeNull();
    expect(field().getAttribute("aria-controls")).toBe(list.id);
    expect(options()[0]).toBe("name");
    const active = popupLayer()!.querySelector("[aria-selected='true']")!;
    expect(field().getAttribute("aria-activedescendant")).toBe(active.id);
    expect(host.contains(list)).toBe(false);
  });

  it("inserts with Tab, with Enter, and navigates with arrows", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("file.na");
    await keydown(field(), "Tab");
    expect(field().value).toBe("file.name");
    await type("file.");
    const first = options()[0];
    await keydown(field(), "ArrowDown");
    const second = popupLayer()!
      .querySelector("[aria-selected='true']")!
      .querySelector("span span")!.textContent;
    expect(second).not.toBe(first);
    await keydown(field(), "ArrowUp");
    expect(
      popupLayer()!.querySelector("[aria-selected='true']")!.querySelector("span span")!
        .textContent,
    ).toBe(first);
    await keydown(field(), "ArrowUp"); // wraps to the last
    await keydown(field(), "Enter");
    expect(field().value).toMatch(/^file\.\w+(\(\))?$/);
    expect(field().value).not.toBe("file.");
  });

  it("closes on Escape without closing the menu, and reopens on typing", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("file.na");
    await keydown(field(), "Escape");
    expect(popupLayer()?.querySelector("[role='listbox']") ?? null).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
    // the Properties panel is still open
    expect(host.querySelector("[role='dialog'][aria-label='Properties']")).not.toBeNull();
    await type("file.nam");
    expect(popupLayer()!.querySelector("[role='listbox']")).not.toBeNull();
  });

  it("clicking a suggestion inserts it and a click on the list keeps the menu open", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("status.tr");
    const option = popupLayer()!.querySelector<HTMLElement>("[role='option']")!;
    await act(async () => {
      option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector("[role='dialog'][aria-label='Properties']")).not.toBeNull();
    await click(option);
    expect(field().value).toBe("status.trim()");
  });

  it("offers vault properties with bracket syntax for names with spaces, and formulas", async () => {
    m.indexProperties.mockResolvedValue([
      { key: "creation date", count: 2, types: { date: 2 } },
      { key: "status", count: 3, types: { text: 3 } },
    ]);
    await mount("Table");
    await openMenu("Properties");
    await type("cre");
    await keydown(field(), "Enter");
    expect(field().value).toBe('note["creation date"]');
    await type("formula.ag");
    expect(options()).toEqual(["age"]);
  });

  it("shows signature help for the argument being typed", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("status.slice(1, ");
    const help = popupLayer()!.querySelector("[data-signature-help]")!;
    expect(help.textContent).toContain("string.slice(start, end?): string");
    expect(help.querySelector("[data-active-param]")!.textContent).toBe("end?");
    expect(help.getAttribute("role")).toBe("status");
  });

  it("opens with Ctrl+Space and shows nothing for an empty field otherwise", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("");
    expect(popupLayer()?.querySelector("[role='option']") ?? null).toBeNull();
    await keydown(field(), " ", { ctrlKey: true });
    expect(options().length).toBeGreaterThan(5);
  });

  it("says when the function list could not be loaded, and still completes the rest", async () => {
    resetFunctionRegistry();
    vi.mocked(ipc.baseFunctions).mockRejectedValue("registry unavailable");
    await mount("Table");
    await openMenu("Properties");
    expect($("[data-completion-error]").textContent).toContain("registry unavailable");
    await type("fil");
    expect(options()).toContain("file");
    expect(options()).not.toContain("date");
  });

  it("loads the registry once for every editor of the session", async () => {
    await mount("Table");
    await openMenu("Properties");
    await openMenu("Filter");
    expect(vi.mocked(ipc.baseFunctions)).toHaveBeenCalledTimes(1);
  });

  it("closes the list when the field loses focus", async () => {
    await mount("Table");
    await openMenu("Properties");
    await type("file.na");
    await act(async () => {
      field().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      field().blur();
    });
    expect(popupLayer()?.querySelector("[role='listbox']") ?? null).toBeNull();
  });
});

describe("filter expression field", () => {
  it("completes in the raw expression editor of the Filter menu", async () => {
    text = BASE_TEXT.replace(
      "    groupBy:\n      property: status\n      direction: DESC\n",
      "    filters:\n      and:\n        - 'status.lower() == \"x\"'\n    groupBy:\n      property: status\n      direction: DESC\n",
    );
    m.baseRead.mockImplementation(async () => {
      const doc = documentFor();
      doc.views[0]!.filters = { and: ['status.lower() == "x"'] };
      return { text, document: doc, error: null };
    });
    await mount("Table");
    await openMenu("Filter");
    const field = byLabel<HTMLTextAreaElement>("Filter expression");
    expect(field.getAttribute("role")).toBe("combobox");
    await act(async () => field.focus());
    await change(field, "status.tr");
    expect(
      document.getElementById("writer-popup-layer")!.querySelector("[role='option']")!.textContent,
    ).toContain("trim");
    // a literal string value is never completed
    await change(field, 'status == "op');
    expect(
      document.getElementById("writer-popup-layer")?.querySelector("[role='option']") ?? null,
    ).toBeNull();
  });
});
