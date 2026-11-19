// @vitest-environment jsdom
// A drawing embedded in a note opens full screen (ADR 2026-11-18, the last line): a click or Enter
// shows it read-only (view mode) with Edit and Done, over the shared full-screen shell; Esc closes
// and flushes; Cmd/middle click open the tab; the canvas chunk loads on the first open only; the
// canvas and the tab share one session. The canvas is a fake that behaves like Excalidraw's
// component (hands over its API, reports onChange, keeps its props); the editor is a real
// EditorView.
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEVER = Symbol("never");
type El = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};
const el = (id: string, version = 1): El => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 1,
  isDeleted: false,
});
const textOf = (elements: El[]) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "s",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  });

const env = vi.hoisted(() => ({
  disk: {} as Record<string, string>,
  natively: true,
  loads: 0,
  saves: [] as string[],
  canvases: [] as {
    api: {
      elements: readonly unknown[];
      updateScene(d: { elements?: readonly unknown[] }): void;
      getSceneElementsIncludingDeleted(): readonly unknown[];
      getAppState(): Record<string, unknown>;
      getFiles(): Record<string, unknown>;
      addFiles(f: unknown[]): void;
    };
    props: Record<string, (...a: unknown[]) => void> & { theme?: string };
  }[],
  opened: [] as { path: string; intent: string }[],
  urls: [] as string[],
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async (u: string) => void env.urls.push(u)),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@/lib/tauri", () => ({
  readFile: vi.fn(async (p: string) => ({ content: env.disk[p] ?? "" })),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
  resolveWikiLinkTarget: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  describeError: (e: unknown) => ({ message: String(e) }),
}));
vi.mock("@/lib/drawing-files", () => ({ drawingsHandledNatively: () => env.natively }));
vi.mock("@/hooks/editor-api", () => ({
  navigateToFile: vi.fn(async (path: string) => void env.opened.push({ path, intent: "current" })),
  openFileInNewTab: vi.fn(
    async (path: string) => void env.opened.push({ path, intent: "new-tab-background" }),
  ),
  getActiveFilePath: () => null,
}));
vi.mock("@/lib/link-activation", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/link-activation")>()),
  resolveVaultLink: async (raw: string) => ({ kind: "internal", path: `/v/${raw}` }),
  // the resolver and the opening are the shared module's own (tested there): record the call
  wikiLinkTarget: (raw: string, getSource: () => string | null) => ({
    kind: "custom",
    open: (intent: string) => void env.opened.push({ path: `${getSource()} -> ${raw}`, intent }),
  }),
}));
vi.mock("../web/lib/takeover", () => ({ offerTakeover: async () => false }));
vi.mock("../web/lib/draw-in", async (importActual) => ({
  ...(await importActual<typeof import("../web/lib/draw-in")>()),
  prefersReducedMotion: () => true,
}));
vi.mock("../web/lib/export-svg", () => ({
  renderSvg: async (_p: string, content: string) =>
    `<svg xmlns='http://www.w3.org/2000/svg' data-n='${(JSON.parse(content).elements as unknown[]).length}'/>`,
  scheduleAutoExport: vi.fn(),
  exportSvgFile: vi.fn(),
  svgPathOf: (p: string) => p.replace(/\.excalidraw$/, ".svg"),
}));
vi.mock("../web/lib/drawing-file", async () => {
  const { parseDrawing } = await import("../web/lib/excalidraw-md");
  return {
    loadDrawingText: async (_p: string, text: string) => ({
      parsed: parseDrawing(text, "plain"),
      files: {},
    }),
    saveDrawing: async (
      path: string,
      _baseline: unknown,
      snap: { elements: readonly { isDeleted?: boolean }[] },
    ) => {
      env.saves.push(path);
      env.disk[path] = JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "s",
        elements: snap.elements.filter((e) => e.isDeleted !== true),
        appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
        files: {},
      });
      return { parsed: parseDrawing(env.disk[path]!, "plain"), wrote: true };
    },
  };
});
vi.mock("../web/lib/excalidraw-lib", () => {
  function FakeExcalidraw(props: Record<string, never>) {
    const mine = useRef<(typeof env.canvases)[number] | null>(null);
    if (mine.current) mine.current.props = props;
    useEffect(() => {
      const api = {
        elements: (props.initialData as { elements: unknown[] }).elements,
        updateScene(d: { elements?: readonly unknown[] }) {
          if (d.elements) this.elements = d.elements;
        },
        getSceneElementsIncludingDeleted() {
          return this.elements;
        },
        getAppState: () => ({ viewBackgroundColor: "#ffffff" }),
        getFiles: () => ({}),
        addFiles: () => {},
      };
      const entry = { api, props };
      mine.current = entry;
      env.canvases.push(entry);
      (props.excalidrawAPI as (a: unknown) => void)(api);
      return () => {
        env.canvases.splice(env.canvases.indexOf(entry), 1);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="fake-excalidraw" />;
  }
  return {
    loadExcalidraw: async () => {
      env.loads += 1;
      return { Excalidraw: FakeExcalidraw, CaptureUpdateAction: { NEVER, IMMEDIATELY: 1 } };
    },
  };
});

import { editorNotePath } from "@/lib/editor-views";
import { closeFullscreen } from "@/lib/fullscreen-overlay";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/main";
import { drawingEmbedDecorations } from "../web/embed-decorations";
import { DrawingView } from "../web/components/drawing-view";
import { useDiskStore } from "../web/disk-sync";
import { flushLiveView } from "../web/lib/live-views";

const NOTE = "/v/Note.md";
const A = "/v/a.excalidraw";
const B = "/v/b.excalidraw";

let parent: HTMLElement;
let view: EditorView;
let changes: number;
let root: Root | null = null;

function mount(doc: string) {
  parent = document.createElement("div");
  document.body.append(parent);
  changes = 0;
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(0),
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
        editorNotePath.of(() => NOTE),
        drawingEmbedDecorations(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) changes += 1;
        }),
      ],
    }),
  });
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
/** Wait for the lazy chunk, the session and the canvas: `n` canvases are up. */
const canvasesUp = (n: number) =>
  act(async () => {
    await vi.waitFor(() => expect(env.canvases).toHaveLength(n), { timeout: 3000 });
  });
const pictures = () => [
  ...view.dom.querySelectorAll<HTMLElement>("[data-drawing-embed][role=link]"),
];
const overlays = () => document.querySelectorAll<HTMLElement>(".writer-drawing-fullscreen");
const modeButton = () =>
  document.querySelector<HTMLButtonElement>("[data-testid=drawing-fullscreen-mode]");
const viewMode = () => env.canvases[0]!.props.viewModeEnabled as unknown as boolean;

async function ready(doc: string) {
  mount(doc);
  await settle();
  await settle();
}
const click = (target: Element, init: MouseEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
const press = (target: EventTarget, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
const edit = async (elements: El[]) => {
  const canvas = env.canvases[0]!;
  canvas.api.elements = elements;
  await act(async () =>
    canvas.props.onChange!(canvas.api.elements, { viewBackgroundColor: "#ffffff" }, {}),
  );
};
/** A note with one embed, opened full screen. */
async function opened() {
  await ready("![[a.excalidraw]]\n");
  await click(pictures()[0]!);
  await canvasesUp(1);
}

beforeEach(() => {
  env.disk[A] = textOf([el("a")]);
  env.disk[B] = textOf([el("b")]);
  env.natively = true;
  env.loads = 0;
  env.saves.length = 0;
  env.opened.length = 0;
  env.urls.length = 0;
  env.canvases.length = 0;
  useDiskStore.setState({ views: {} });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  closeFullscreen();
  await settle();
  view?.destroy();
  parent?.remove();
  document.body.querySelectorAll(".writer-fullscreen").forEach((n) => n.remove());
});

describe("opening", () => {
  it("a plain click opens it full screen, read-only, and loads the canvas chunk only then", async () => {
    await ready("![[a.excalidraw]]\n");
    expect(pictures()).toHaveLength(1);
    expect(env.loads).toBe(0);
    await click(pictures()[0]!.querySelector("img")!);
    await canvasesUp(1);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.getAttribute("aria-label")).toBe("Drawing a");
    expect(overlays()[0]!.querySelector(".writer-fullscreen-title")!.textContent).toBe("a");
    expect(viewMode()).toBe(true);
    expect(modeButton()!.textContent).toBe("Edit");
    expect(env.loads).toBe(1);
    expect(env.opened).toEqual([]);
    // the note keeps its picture; the canvas is not inside it
    expect(pictures()).toHaveLength(1);
    expect(view.dom.querySelector("[data-testid=fake-excalidraw]")).toBeNull();
  });

  it("Enter on the focused picture opens it too", async () => {
    await ready("![[a.excalidraw]]\n");
    await press(pictures()[0]!, "Enter");
    await canvasesUp(1);
    expect(overlays()).toHaveLength(1);
    expect(viewMode()).toBe(true);
  });

  it("Cmd or Ctrl click and middle click open the tab and no full screen", async () => {
    await ready("![[a.excalidraw]]\n");
    await click(pictures()[0]!, { metaKey: true, ctrlKey: true });
    await act(async () =>
      pictures()[0]!.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
      ),
    );
    await settle();
    expect(env.opened).toEqual([
      { path: A, intent: "new-tab-background" },
      { path: A, intent: "new-tab-background" },
    ]);
    expect(overlays()).toHaveLength(0);
    expect(env.loads).toBe(0);
  });

  it("with the drawings handed to the Obsidian plugin a click opens the tab, no canvas", async () => {
    env.natively = false;
    await ready("![[a.excalidraw]]\n");
    await click(pictures()[0]!);
    await settle();
    expect(env.opened).toEqual([{ path: A, intent: "current" }]);
    expect(overlays()).toHaveLength(0);
    expect(env.loads).toBe(0);
  });

  it("the canvas follows the app theme", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await opened();
    expect(env.canvases[0]!.props.theme).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  it("only one is open: opening a second drawing replaces the first", async () => {
    await ready("![[a.excalidraw]]\n\ntext\n\n![[b.excalidraw]]\n");
    await click(pictures()[0]!);
    await canvasesUp(1);
    expect(overlays()[0]!.getAttribute("aria-label")).toBe("Drawing a");
    await click(pictures()[1]!);
    await vi.waitFor(() => expect(overlays()[0]!.getAttribute("aria-label")).toBe("Drawing b"));
    expect(overlays()).toHaveLength(1);
    await vi.waitFor(() => expect(env.canvases).toHaveLength(1));
  });
});

describe("Edit and Done", () => {
  it("Edit switches the same screen to editing and Done back to viewing", async () => {
    await opened();
    expect(viewMode()).toBe(true);
    await click(modeButton()!);
    expect(viewMode()).toBe(false);
    expect(modeButton()!.textContent).toBe("Done");
    expect(env.canvases).toHaveLength(1); // the same canvas, not a new one
    expect(env.loads).toBe(1);
    await click(modeButton()!);
    expect(viewMode()).toBe(true);
    expect(modeButton()!.textContent).toBe("Edit");
    expect(overlays()).toHaveLength(1);
  });

  it("an edit is saved once through the session, and is not an edit of the note", async () => {
    await opened();
    const doc = view.state.doc.toString();
    changes = 0;
    await click(modeButton()!);
    await edit([el("a"), el("n")]);
    await click(modeButton()!); // Done
    await act(async () => await flushLiveView(A));
    expect(env.saves).toEqual([A]);
    expect(JSON.parse(env.disk[A]!).elements.map((e: El) => e.id)).toEqual(["a", "n"]);
    expect(view.state.doc.toString()).toBe(doc);
    expect(changes).toBe(0);
  });

  it("viewing alone writes nothing", async () => {
    await opened();
    await edit([el("a")]); // the canvas reports its (unchanged) scene on pan or zoom
    await press(document, "Escape");
    await settle();
    expect(env.saves).toEqual([]);
  });
});

describe("closing", () => {
  it("Esc closes it, even while editing, and saves what was drawn", async () => {
    await opened();
    await click(modeButton()!);
    await edit([el("a"), el("n")]);
    await press(document, "Escape");
    await settle();
    await settle();
    expect(overlays()).toHaveLength(0);
    expect(env.saves).toEqual([A]);
    expect(JSON.parse(env.disk[A]!).elements.map((e: El) => e.id)).toEqual(["a", "n"]);
  });

  it("Esc first leaves a text box of the canvas, then closes", async () => {
    await opened();
    await click(modeButton()!);
    const box = document.createElement("textarea");
    overlays()[0]!.querySelector("[data-testid=fake-excalidraw]")!.append(box);
    box.focus();
    await press(box, "Escape");
    expect(overlays()).toHaveLength(1);
    box.blur();
    await press(document, "Escape");
    expect(overlays()).toHaveLength(0);
  });

  it("the close button and a backdrop press close it", async () => {
    await opened();
    await click(document.querySelector(".writer-fullscreen-close")!);
    expect(overlays()).toHaveLength(0);
    await click(pictures()[0]!);
    await canvasesUp(1);
    await act(async () => {
      overlays()[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(overlays()).toHaveLength(0);
  });

  it("destroying the note's editor closes it", async () => {
    await opened();
    view.destroy();
    expect(overlays()).toHaveLength(0);
  });

  it("the canvas lets go of the session when it closes", async () => {
    await opened();
    await press(document, "Escape");
    await vi.waitFor(() => expect(env.canvases).toHaveLength(0));
    await vi.waitFor(() =>
      expect(useDiskStore.getState().views[A]?.refs ?? 0).toBeLessThanOrEqual(1),
    );
  });
});

describe("the note", () => {
  it("is not touched while the full screen is used: no selection, no document change", async () => {
    await ready("intro\n\n![[a.excalidraw]]\n\nafter\n");
    const doc = view.state.doc.toString();
    const selection = view.state.selection;
    changes = 0;
    await click(pictures()[0]!);
    await canvasesUp(1);
    await click(modeButton()!);
    const stage = document.querySelector("[data-testid=fake-excalidraw]")!;
    for (const key of ["a", "Backspace", "Enter"]) await press(stage, key);
    await press(document, "Escape");
    await settle();
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(changes).toBe(0);
  });
});

describe("one session per file", () => {
  function Tab() {
    return <DrawingView location={{ kind: "drawing", path: A } as never} isActive tabId="t" />;
  }

  async function both() {
    await opened();
    await click(modeButton()!);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Tab />));
    await canvasesUp(2);
  }

  it("an edit in the full screen is seen by the tab, and saved once", async () => {
    await both();
    const [full, tab] = env.canvases as [
      (typeof env.canvases)[number],
      (typeof env.canvases)[number],
    ];
    await edit([el("a"), el("n")]);
    expect(tab.api.elements.map((e) => (e as El).id)).toEqual(["a", "n"]);
    await act(async () =>
      tab.props.onChange!(tab.api.elements, { viewBackgroundColor: "#ffffff" }, {}),
    );
    await act(async () => await flushLiveView(A));
    expect(env.saves).toEqual([A]);
    expect(full.api.elements).toHaveLength(2);
    expect(env.loads).toBe(1);
  });
});

describe("live reload", () => {
  async function changeOnDisk() {
    env.disk[A] = textOf([el("a"), el("cli")]);
    await act(async () => useDiskStore.getState().reload(A));
    await settle();
    await settle();
  }

  it.each([
    ["viewing", false],
    ["editing", true],
  ])("a change on disk (the CLI) reaches the open full screen while %s", async (_n, editing) => {
    await opened();
    if (editing) await click(modeButton()!);
    await changeOnDisk();
    await vi.waitFor(() =>
      expect(env.canvases[0]!.api.elements.map((e) => (e as El).id)).toEqual(["a", "cli"]),
    );
    expect(viewMode()).toBe(!editing);
  });

  it("and the picture in the note", async () => {
    await opened();
    const src = () => pictures()[0]!.querySelector("img")!.getAttribute("src")!;
    expect(decodeURIComponent(src())).toContain("data-n='1'");
    await changeOnDisk();
    await vi.waitFor(() => expect(decodeURIComponent(src())).toContain("data-n='2'"));
  });
});

/** What Excalidraw hands `onLinkOpen`: the element and a cancelable event wrapping the click. */
function followLink(link: string, init: MouseEventInit & { button?: number } = {}, index = 0) {
  const event = new CustomEvent("excalidraw-link", {
    cancelable: true,
    detail: { nativeEvent: new MouseEvent("pointerup", { button: 0, ...init }) },
  });
  const props = env.canvases[index]!.props as unknown as {
    onLinkOpen: (el: { link: string }, e: CustomEvent) => void;
  };
  act(() => props.onLinkOpen({ link }, event));
  return event;
}

describe("element links in the full screen", () => {
  it("a [[Note]] link opens in the current tab and closes the full screen first", async () => {
    await opened();
    const event = followLink("[[Note#Part|alias]]");
    expect(event.defaultPrevented).toBe(true); // Excalidraw never navigates the webview
    expect(env.opened).toEqual([{ path: `${A} -> Note#Part|alias`, intent: "current" }]);
    expect(overlays()).toHaveLength(0);
  });

  it("Cmd/Ctrl click and middle click open a background tab and keep the full screen", async () => {
    await opened();
    followLink("[[Note]]", { metaKey: true, ctrlKey: true });
    followLink("[[Note]]", { button: 1 });
    expect(env.opened.map((o) => o.intent)).toEqual(["new-tab-background", "new-tab-background"]);
    expect(overlays()).toHaveLength(1);
  });

  it("an http(s) link goes to the system browser, never the webview; other schemes do nothing", async () => {
    const open = vi.spyOn(window, "open");
    await opened();
    expect(followLink("https://example.com/x").defaultPrevented).toBe(true);
    followLink("javascript:alert(1)");
    expect(env.urls).toEqual(["https://example.com/x"]);
    expect(open).not.toHaveBeenCalled();
    expect(overlays()).toHaveLength(1);
  });
});

describe("element links in the tab", () => {
  it("resolve against the drawing and open in the current tab, a new tab with a modifier", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <DrawingView location={{ kind: "drawing", path: A } as never} isActive tabId="t" />,
      ),
    );
    await canvasesUp(1);
    expect(followLink("[[Note]]").defaultPrevented).toBe(true);
    followLink("[[Other|x]]", { metaKey: true, ctrlKey: true });
    followLink("http://example.com");
    expect(env.opened).toEqual([
      { path: `${A} -> Note`, intent: "current" },
      { path: `${A} -> Other|x`, intent: "new-tab-background" },
    ]);
    expect(env.urls).toEqual(["http://example.com"]);
  });
});

describe("Esc defers to Excalidraw's own layers", () => {
  it.each([".popover", ".dropdown-menu", ".context-menu", ".Modal", ".Dialog"])(
    "an open %s gets the first Esc; the next closes the full screen",
    async (cls) => {
      await opened();
      await click(modeButton()!);
      const layer = document.createElement("div");
      layer.className = cls.slice(1);
      overlays()[0]!.querySelector("[data-testid=fake-excalidraw]")!.append(layer);
      await press(document, "Escape");
      expect(overlays()).toHaveLength(1);
      layer.remove(); // Excalidraw closed it
      await press(document, "Escape");
      expect(overlays()).toHaveLength(0);
    },
  );
});
