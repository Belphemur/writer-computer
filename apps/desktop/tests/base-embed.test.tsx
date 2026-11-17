// @vitest-environment jsdom
// Bases embedded in notes: which ranges become embeds, the decoration shape, widget identity and
// React root lifecycle in a live EditorView, and the embedded view (read-only, explicit error
// states, requery, open base, source edit). The backend is a fake; the data is invented.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// jsdom has no layout: CodeMirror measures text through Range rects, which jsdom lacks. Without
// these, a measure pass that lands after a test ends raises an unhandled error and fails the run.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("../src/lib/tauri", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  fileExists: vi.fn(),
  resolveWikiLinkTarget: vi.fn(),
}));
vi.mock("../src/lib/bases/ipc", () => ({
  baseList: vi.fn(),
  baseRead: vi.fn(),
  baseParseText: vi.fn(),
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

import {
  BaseEmbedWidget,
  __testBaseEmbed,
  baseEmbedDecorations,
  findBaseEmbeds,
} from "../src/components/editor-area/base-embed-decorations";
import {
  dragFrozenSelectionField,
  shouldStartDragGate,
} from "../src/components/editor-area/drag-selection-gate";
import { EmbeddedBase, EMBED_MAX_HEIGHT } from "../src/components/base-view/embedded";
import { TEXT_DEBOUNCE_MS } from "../src/components/base-view/use-base-query";
import {
  embedKey,
  isBaseFenceInfo,
  parseBaseEmbedLine,
  parseBaseEmbedTarget,
} from "../src/lib/bases/embeds";
import { foldExtension, prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import * as ipc from "../src/lib/bases/ipc";
import * as tauri from "../src/lib/tauri";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import type { BaseQueryResult, IndexChangedEvent } from "../src/lib/bases/types";
import { BASE_PATH, baseDocument, taskResult } from "./helpers/bases-fixtures";
import { withFullParse } from "./helpers/parsed-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "/vault/Notes/Plan.md";

const m = {
  baseRead: vi.mocked(ipc.baseRead),
  baseParseText: vi.mocked(ipc.baseParseText),
  baseQuery: vi.mocked(ipc.baseQuery),
  baseQueryText: vi.mocked(ipc.baseQueryText),
  baseWriteText: vi.mocked(ipc.baseWriteText),
  notePropertySet: vi.mocked(ipc.notePropertySet),
  onIndexChanged: vi.mocked(ipc.onIndexChanged),
  fileExists: vi.mocked(tauri.fileExists),
  resolveWikiLinkTarget: vi.mocked(tauri.resolveWikiLinkTarget),
};

let indexHandler: ((e: IndexChangedEvent) => void) | null;
let unlisten: ReturnType<typeof vi.fn>;
let opened: string[];

function stubLayout(height = 400, width = 900) {
  for (const [name, value] of [
    ["clientHeight", height],
    ["clientWidth", width],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubLayout();
  indexHandler = null;
  unlisten = vi.fn();
  opened = [];
  m.baseRead.mockResolvedValue({ text: "", document: baseDocument(), error: null });
  m.baseParseText.mockResolvedValue({ document: baseDocument(), error: null });
  m.baseQuery.mockImplementation(async () => taskResult());
  m.baseQueryText.mockImplementation(async () => taskResult());
  m.resolveWikiLinkTarget.mockResolvedValue(BASE_PATH);
  m.fileExists.mockResolvedValue(true);
  m.onIndexChanged.mockImplementation(async (handler) => {
    indexHandler = handler;
    return unlisten as unknown as () => void;
  });
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
    openFileInNewTab: async (path: string) => void opened.push(path),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

describe("embed grammar", () => {
  it("parses a base embed with and without view, ignoring an alias", () => {
    expect(parseBaseEmbedTarget("tasks.base")).toEqual({ kind: "file", target: "tasks.base" });
    expect(parseBaseEmbedTarget("tasks.base#Board")).toEqual({
      kind: "file",
      target: "tasks.base",
      view: "Board",
    });
    expect(parseBaseEmbedTarget("Projects/tasks.base#Open items|My alias")).toEqual({
      kind: "file",
      target: "Projects/tasks.base",
      view: "Open items",
    });
    expect(parseBaseEmbedTarget("tasks.base|alias")).toEqual({
      kind: "file",
      target: "tasks.base",
    });
  });

  it("refuses anything that is not a base", () => {
    expect(parseBaseEmbedTarget("Note")).toBeNull();
    expect(parseBaseEmbedTarget("pic.png")).toBeNull();
    expect(parseBaseEmbedTarget("#Heading")).toBeNull();
  });

  it("only a line that is exactly one embed counts", () => {
    expect(parseBaseEmbedLine("![[a.base]]")).not.toBeNull();
    expect(parseBaseEmbedLine("  ![[a.base#V]]  ")).not.toBeNull();
    expect(parseBaseEmbedLine("[[a.base]]")).toBeNull();
    expect(parseBaseEmbedLine("see ![[a.base]]")).toBeNull();
    expect(parseBaseEmbedLine("![[a.base]] and more")).toBeNull();
    expect(parseBaseEmbedLine("![[a.base]] ![[b.base]]")).toBeNull();
  });

  it("recognises the base fence info string only", () => {
    expect(isBaseFenceInfo("base")).toBe(true);
    expect(isBaseFenceInfo(" BASE ")).toBe(true);
    expect(isBaseFenceInfo("base yaml")).toBe(false);
    expect(isBaseFenceInfo("basement")).toBe(false);
  });

  it("keys differ by target, view and text", () => {
    const a = embedKey({ kind: "file", target: "a.base" });
    expect(a).not.toBe(embedKey({ kind: "file", target: "a.base", view: "V" }));
    expect(embedKey({ kind: "block", text: "x" })).not.toBe(embedKey({ kind: "block", text: "y" }));
  });
});

// ---------------------------------------------------------------------------
// Finding embeds
// ---------------------------------------------------------------------------

function stateOf(doc: string, selection?: { anchor: number; head?: number }) {
  return withFullParse(
    EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
        baseEmbedDecorations(() => NOTE),
      ],
      ...(selection ? { selection: EditorSelection.single(selection.anchor, selection.head) } : {}),
    }),
  );
}

describe("finding embeds", () => {
  it("finds file embeds (with and without view, with alias) and fenced blocks", () => {
    const doc = [
      "intro",
      "",
      "![[tasks.base]]",
      "",
      "![[tasks.base#Board|alias]]",
      "",
      "```base",
      "views:",
      "  - type: table",
      "```",
    ].join("\n");
    const found = findBaseEmbeds(stateOf(doc));
    expect(found.map((f) => f.embed)).toEqual([
      { kind: "file", target: "tasks.base" },
      { kind: "file", target: "tasks.base", view: "Board" },
      { kind: "block", text: "views:\n  - type: table" },
    ]);
    expect(doc.slice(found[0]!.from, found[0]!.to)).toBe("![[tasks.base]]");
    expect(doc.slice(found[2]!.from, found[2]!.to).startsWith("```base")).toBe(true);
  });

  it("ignores embeds in code, frontmatter, comments, lists, quotes and running text", () => {
    const doc = [
      "---",
      "x: ![[in-frontmatter.base]]",
      "---",
      "",
      "```md",
      "![[in-fence.base]]",
      "```",
      "",
      "    ![[indented-code.base]]",
      "",
      "`![[inline.base]]`",
      "",
      "<!--",
      "![[comment.base]]",
      "-->",
      "",
      "- ![[list.base]]",
      "",
      "> ![[quote.base]]",
      "",
      "text ![[running.base]]",
      "",
      "![[line.base]]",
      "continues here",
      "",
      "![[note.md]] and ![[pic.png]]",
      "",
      "```base",
      "```",
      "",
      "```python",
      "views: []",
      "```",
    ].join("\n");
    expect(findBaseEmbeds(stateOf(doc))).toEqual([]);
  });

  it("an unclosed base fence being typed stays source", () => {
    expect(findBaseEmbeds(stateOf("```base\nviews:"))).toEqual([]);
  });
});

describe("decoration shape: replace away, widget below when the selection touches", () => {
  const doc = "before\n\n![[tasks.base]]\n\nafter";
  const from = doc.indexOf("![[");
  const to = from + "![[tasks.base]]".length;

  function kinds(state: EditorState): string[] {
    const out: string[] = [];
    state.field(foldExtension).between(0, doc.length, (f, t, deco) => {
      const spec = deco.spec as { widget?: unknown; block?: boolean };
      if (spec.widget instanceof BaseEmbedWidget) {
        out.push(f === from && t === to ? "replace" : f === to && t === to ? "widget-after" : "?");
        expect(spec.block).toBe(true);
      }
    });
    return out;
  }

  it("caret away: replace", () => {
    expect(kinds(stateOf(doc, { anchor: 0 }))).toEqual(["replace"]);
  });

  it("caret inside or a range selecting the line: widget after the source", () => {
    expect(kinds(stateOf(doc, { anchor: from + 4 }))).toEqual(["widget-after"]);
    expect(kinds(stateOf(doc, { anchor: to, head: from }))).toEqual(["widget-after"]);
  });

  it("the widget carries the embedding note as `this`", () => {
    let notePath = "";
    stateOf(doc, { anchor: 0 })
      .field(foldExtension)
      .between(0, doc.length, (_f, _t, deco) => {
        const w = (deco.spec as { widget?: unknown }).widget;
        if (w instanceof BaseEmbedWidget) notePath = w.notePath;
      });
    expect(notePath).toBe(NOTE);
  });
});

describe("drag-selection gate", () => {
  it("a pointerdown inside the embed does not arm the gate", () => {
    const state = EditorState.create({ doc: "x", extensions: [dragFrozenSelectionField] });
    const inside = {
      closest: (sel: string) => (sel === ".cm-base-embed" ? ({} as Element) : null),
    };
    const outside = { closest: () => null };
    const event = (target: unknown) => ({ isPrimary: true, button: 0, target }) as never;
    expect(shouldStartDragGate(state, event(inside))).toBeNull();
    expect(shouldStartDragGate(state, event(outside))).not.toBeNull();
  });
});

describe("widget identity", () => {
  const file = { kind: "file", target: "a.base" } as const;
  it("eq compares what is embedded and for which note, never positions", () => {
    expect(new BaseEmbedWidget(file, NOTE).eq(new BaseEmbedWidget({ ...file }, NOTE))).toBe(true);
    expect(new BaseEmbedWidget(file, NOTE).eq(new BaseEmbedWidget(file, "/vault/Other.md"))).toBe(
      false,
    );
    expect(
      new BaseEmbedWidget(file, NOTE).eq(new BaseEmbedWidget({ ...file, view: "V" }, NOTE)),
    ).toBe(false);
    const a = new BaseEmbedWidget({ kind: "block", text: "x" }, NOTE);
    expect(a.eq(new BaseEmbedWidget({ kind: "block", text: "y" }, NOTE))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live EditorView
// ---------------------------------------------------------------------------

function mountEditor(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: stateOf(doc, { anchor: 0 }) });
  return {
    view,
    cleanup: () => {
      view.destroy();
      parent.remove();
    },
  };
}

const widgetEl = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-base-embed");

describe("widget in a live editor", () => {
  const doc = "intro\n\n![[tasks.base]]\n\noutro";

  it("renders the base, and typing elsewhere keeps the same DOM, root and data", async () => {
    const { view, cleanup } = mountEditor(doc);
    await flush();
    const el = widgetEl(view)!;
    expect(el.querySelector('[role="grid"]')).not.toBeNull();
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    expect(m.baseQuery.mock.calls[0]![0]).toMatchObject({ path: BASE_PATH, thisPath: NOTE });

    view.dispatch({ changes: { from: 0, insert: "typed " } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: " more" } });
    await flush();
    expect(widgetEl(view)).toBe(el);
    expect(el.querySelector('[role="grid"]')).not.toBeNull();
    expect(m.baseQuery).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("unmounts the React root when the view is destroyed", async () => {
    const { view, cleanup } = mountEditor(doc);
    await flush();
    const el = widgetEl(view)!;
    expect(el.childElementCount).toBeGreaterThan(0);
    cleanup();
    await flush();
    expect(el.childElementCount).toBe(0);
    expect(unlisten).toHaveBeenCalled();
  });

  it("Edit range-selects the line, unfolds the source and keeps a widget below", async () => {
    const { view, cleanup } = mountEditor(doc);
    await flush();
    const edit = widgetEl(view)!.querySelector<HTMLButtonElement>("[data-embed-edit]")!;
    // docs/editor.md: the in-widget button must not take focus from the editor.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => void edit.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    await act(async () => edit.click());
    const from = doc.indexOf("![[");
    const to = from + "![[tasks.base]]".length;
    const { main } = view.state.selection;
    expect([main.anchor, main.head]).toEqual([to, from]);
    expect(view.contentDOM.textContent).toContain("![[tasks.base]]");
    const widget = widgetEl(view)!;
    expect(widget).not.toBeNull();
    // Below its source line (side: 1), not above it.
    const source = [...view.contentDOM.querySelectorAll(".cm-line")].find((l) =>
      l.textContent?.includes("![[tasks.base]]"),
    )!;
    expect(source.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
  });

  it("a fenced block updates in place while its source is edited", async () => {
    const fenced = "intro\n\n```base\nviews:\n  - type: table\n    name: T\n```\n\nout";
    const { view, cleanup } = mountEditor(fenced);
    await flush();
    const el = widgetEl(view)!;
    expect(m.baseQueryText).toHaveBeenCalledTimes(1);
    expect(m.baseQueryText.mock.calls[0]![0]).toMatchObject({
      text: "views:\n  - type: table\n    name: T",
      thisPath: NOTE,
    });
    const at = fenced.indexOf("name: T");
    view.dispatch({
      selection: EditorSelection.single(at),
      changes: { from: at, to: at + 7, insert: "name: Renamed" },
    });
    view.dispatch({ changes: { from: at, to: at + 4, insert: "name" } });
    await flush();
    await flush(TEXT_DEBOUNCE_MS + 60);
    expect(widgetEl(view)).toBe(el);
    const last = m.baseQueryText.mock.calls.at(-1)![0];
    expect(last.text).toContain("name: Renamed");
    // Two quick edits, one query after the quiet period.
    expect(m.baseQueryText).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("remembers the measured height and asks the view to re-measure", async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { view, cleanup } = mountEditor(doc);
    await flush();
    const el = widgetEl(view)!;
    el.getBoundingClientRect = () => ({ height: 311 }) as DOMRect;
    const measure = vi.spyOn(view, "requestMeasure");
    for (const cb of observers) cb();
    expect(measure).toHaveBeenCalled();
    expect(new BaseEmbedWidget({ kind: "file", target: "tasks.base" }, NOTE).estimatedHeight).toBe(
      311,
    );
    __testBaseEmbed.heightCache.clear();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// The embedded view
// ---------------------------------------------------------------------------

let host: HTMLDivElement;
let root: Root;

async function mountEmbed(embed: Parameters<typeof EmbeddedBase>[0]["embed"], onEdit = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<EmbeddedBase embed={embed} notePath={NOTE} onEdit={onEdit} />);
  });
  await flush();
  return onEdit;
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

const fileEmbed = { kind: "file", target: "tasks.base" } as const;
const errorText = () => host.querySelector("[data-base-error]")?.textContent ?? "";

describe("embedded base: states", () => {
  it("bounds the height with an internal scroll", async () => {
    await mountEmbed(fileEmbed);
    const frame = host.querySelector<HTMLElement>("[data-base-embed]")!;
    expect(frame.style.maxHeight).toBe(`${EMBED_MAX_HEIGHT}px`);
    expect(frame.className).toContain("overflow-hidden");
  });

  it("a missing base file is an explicit error, with an Edit button", async () => {
    m.resolveWikiLinkTarget.mockResolvedValue(null);
    const onEdit = await mountEmbed({ kind: "file", target: "gone.base" });
    expect(errorText()).toContain("Base not found: gone.base");
    host.querySelector<HTMLButtonElement>("[data-embed-edit]")!.click();
    expect(onEdit).toHaveBeenCalled();
    expect(m.baseQuery).not.toHaveBeenCalled();
  });

  it("a file that appears later shows up on the next index change", async () => {
    m.resolveWikiLinkTarget.mockResolvedValue(null);
    await mountEmbed(fileEmbed);
    expect(errorText()).toContain("Base not found");
    m.resolveWikiLinkTarget.mockResolvedValue(BASE_PATH);
    await act(async () =>
      indexHandler!({ epoch: 1, root: "/vault", paths: ["x.base"], full: false }),
    );
    await flush();
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("a resolution failure is shown, not swallowed", async () => {
    m.resolveWikiLinkTarget.mockRejectedValue(new Error("lookup exploded"));
    await mountEmbed(fileEmbed);
    expect(errorText()).toContain("lookup exploded");
  });

  it("an unparsable base shows the parse error and no rows", async () => {
    m.baseRead.mockResolvedValue({ text: "views: [oops", document: null, error: "bad yaml" });
    m.baseQuery.mockResolvedValue({
      ...taskResult({ rows: [], columns: [], totalMatched: 0 }),
      error: { kind: "document", message: "bad yaml", expression: null, path: null },
    });
    await mountEmbed(fileEmbed);
    expect(errorText()).toContain("could not be parsed");
    expect(host.querySelector("[data-base-raw-text]")).toBeNull();
  });

  it("a view that does not exist is the view-not-found state", async () => {
    m.baseQuery.mockResolvedValue({
      ...taskResult({ rows: [] }),
      error: { kind: "viewNotFound", message: "Nope", expression: null, path: null },
    });
    await mountEmbed({ ...fileEmbed, view: "Nope" });
    expect(errorText()).toContain("View not found: Nope");
    expect(m.baseQuery.mock.calls[0]![0]).toMatchObject({ view: "Nope" });
  });

  it("a query that rejects is shown, and the embed does not throw", async () => {
    m.baseQuery.mockRejectedValue("the vault index is still being built");
    await mountEmbed(fileEmbed);
    expect(errorText()).toContain("The query failed");
    expect(errorText()).toContain("still being built");
  });

  it("an inline block with bad YAML shows the error without the raw text", async () => {
    m.baseParseText.mockResolvedValue({ document: null, error: "bad yaml" });
    m.baseQueryText.mockResolvedValue({
      ...taskResult({ rows: [], columns: [] }),
      error: { kind: "document", message: "bad yaml", expression: null, path: null },
    });
    await mountEmbed({ kind: "block", text: "views: [oops" });
    expect(errorText()).toContain("could not be parsed");
    expect(host.querySelector("[data-base-raw-text]")).toBeNull();
  });
});

describe("embedded base: behaviour", () => {
  it("`this` is the embedding note, for files and blocks", async () => {
    await mountEmbed(fileEmbed);
    expect(m.baseQuery.mock.calls[0]![0].thisPath).toBe(NOTE);
    await act(async () => root.unmount());
    host.remove();
    await mountEmbed({ kind: "block", text: "views: []" });
    expect(m.baseQueryText.mock.calls[0]![0].thisPath).toBe(NOTE);
  });

  it("selects the view named in the embed and lets the switcher change it", async () => {
    await mountEmbed({ ...fileEmbed, view: "Board" });
    expect(m.baseQuery.mock.calls[0]![0]).toMatchObject({ view: "Board" });
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Table", "Board"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[0]!.click());
    await flush();
    expect(m.baseQuery.mock.calls.at(-1)![0]).toMatchObject({ view: "Table" });
  });

  it("cannot edit cells and never writes: typing, header clicks and the checkbox only notify", async () => {
    await mountEmbed(fileEmbed);
    const cell = host.querySelector<HTMLElement>(
      '[data-row-path="Tasks/alpha.md"] [aria-colindex="2"]',
    )!;
    await act(async () => cell.click());
    const grid = host.querySelector<HTMLElement>('[role="grid"]')!;
    await act(async () => {
      grid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(host.querySelector("input[type=text], textarea")).toBeNull();
    await act(async () => {
      host.querySelector<HTMLElement>('[role="columnheader"] button')!.click();
    });
    await flush();
    expect(m.notePropertySet).not.toHaveBeenCalled();
    expect(m.baseWriteText).not.toHaveBeenCalled();
    expect(host.querySelector("[data-base-notice]")?.textContent).toContain("read-only");
  });

  it("Open base opens the file in a new tab with the chosen view", async () => {
    await mountEmbed(fileEmbed);
    await act(async () => host.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.click());
    await flush();
    const { consumePendingAnchor } = await import("../src/lib/pending-anchor");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-embed-open]")!.click());
    await flush();
    expect(opened).toEqual([BASE_PATH]);
    expect(consumePendingAnchor(BASE_PATH)).toBe("Board");
  });

  it("an inline block has no Open base button; Edit enters the source", async () => {
    const onEdit = await mountEmbed({ kind: "block", text: "views: []" });
    expect(host.querySelector("[data-embed-open]")).toBeNull();
    host.querySelector<HTMLButtonElement>("[data-embed-edit]")!.click();
    expect(onEdit).toHaveBeenCalled();
  });

  it("requeries on index://changed and when the embedded .base file changes", async () => {
    await mountEmbed(fileEmbed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const queries = () => m.baseQuery.mock.calls.length;
    const reads = () => m.baseRead.mock.calls.length;
    const q0 = queries();
    const r0 = reads();
    // A note changed: requery only.
    await act(async () => {
      indexHandler!({ epoch: 1, root: "/vault", paths: ["Tasks/alpha.md"], full: false });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(queries()).toBe(q0 + 1);
    expect(reads()).toBe(r0);
    // The embedded base itself changed: re-read and requery.
    await act(async () => {
      indexHandler!({ epoch: 1, root: "/vault", paths: ["Projects/tasks.base"], full: false });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(reads()).toBe(r0 + 1);
    expect(queries()).toBeGreaterThan(q0 + 1);
    // Another workspace's batch is ignored.
    const q1 = queries();
    await act(async () => {
      indexHandler!({ epoch: 9, root: "/other", paths: ["a.md"], full: false });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(queries()).toBe(q1);
  });

  it("links in cells open notes in new tabs", async () => {
    const result: BaseQueryResult = taskResult();
    result.rows[0]!.cells[0] = {
      type: "link",
      value: { target: "alpha", display: null, resolved: "Tasks/alpha.md" },
      display: "alpha",
    };
    m.baseQuery.mockResolvedValue(result);
    await mountEmbed(fileEmbed);
    const link = host.querySelector<HTMLElement>("[data-cell-link]");
    expect(link).not.toBeNull();
    await act(async () => link!.click());
    await flush();
    expect(opened).toEqual(["/vault/Tasks/alpha.md"]);
  });
});
