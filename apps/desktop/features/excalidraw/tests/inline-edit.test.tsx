// @vitest-environment jsdom
// A drawing embedded in a note is edited in place (ADR 2026-11-18, "edit in place"): a click swaps
// the picture for the canvas (a lazy chunk), Cmd/middle click open the tab, Esc or a click outside
// goes back, one editor at a time, and the inline canvas and the tab share one session. The canvas
// is a fake that behaves like Excalidraw's component (hands over its API, reports onChange); the
// editor is a real EditorView.
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
}));
vi.mock("../web/lib/takeover", () => ({ offerTakeover: async () => false }));
vi.mock("../web/lib/draw-in", async (importActual) => ({
  ...(await importActual<typeof import("../web/lib/draw-in")>()),
  prefersReducedMotion: () => true,
}));
vi.mock("../web/lib/export-svg", () => ({
  renderSvg: async () => "<svg xmlns='http://www.w3.org/2000/svg'/>",
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
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/main";
import { drawingEmbedDecorations } from "../web/embed-decorations";
import { DrawingView } from "../web/components/drawing-view";
import { useDiskStore } from "../web/disk-sync";
import { useInlineEditor } from "../web/lib/inline-editor";
import { flushLiveView } from "../web/lib/live-views";
import { acquireDrawingSession } from "../web/lib/sessions";

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
const editors = () => view.dom.querySelectorAll("[data-drawing-embed-editor]");

async function ready(doc: string) {
  mount(doc);
  await settle();
  await settle();
}
const click = (target: Element, init: MouseEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });

beforeEach(() => {
  env.disk[A] = textOf([el("a")]);
  env.disk[B] = textOf([el("b")]);
  env.natively = true;
  env.loads = 0;
  env.saves.length = 0;
  env.opened.length = 0;
  env.canvases.length = 0;
  useInlineEditor.setState({ host: null });
  useDiskStore.setState({ views: {} });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  await settle();
  view?.destroy();
  parent?.remove();
});

describe("click to edit", () => {
  it("a plain click turns the picture into the canvas, whose chunk loads only then", async () => {
    await ready("![[a.excalidraw]]\n");
    expect(pictures()).toHaveLength(1);
    expect(env.loads).toBe(0);
    await click(pictures()[0]!.querySelector("img")!);
    await canvasesUp(1);
    expect(editors()).toHaveLength(1);
    expect(view.dom.querySelector("[data-testid=fake-excalidraw]")).not.toBeNull();
    expect(env.loads).toBe(1);
    expect(env.opened).toEqual([]);
  });

  it("Cmd or Ctrl click and middle click open the tab and leave the picture", async () => {
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
    expect(editors()).toHaveLength(0);
    expect(env.loads).toBe(0);
  });

  it("with the drawings handed to the Obsidian plugin a click opens the tab, no canvas", async () => {
    env.natively = false;
    await ready("![[a.excalidraw]]\n");
    await click(pictures()[0]!);
    await settle();
    expect(env.opened).toEqual([{ path: A, intent: "current" }]);
    expect(editors()).toHaveLength(0);
  });

  it("the canvas keeps the picture's height and the app theme", async () => {
    await ready("![[a.excalidraw]]\n");
    pictures()[0]!.getBoundingClientRect = () => ({ height: 321 }) as DOMRect;
    document.documentElement.setAttribute("data-theme", "dark");
    await click(pictures()[0]!);
    await canvasesUp(1);
    expect((editors()[0] as HTMLElement).style.height).toBe("321px");
    expect(env.canvases[0]!.props.theme).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
  });
});

describe("leaving edit mode", () => {
  async function editing() {
    await ready("![[a.excalidraw]]\n");
    await click(pictures()[0]!);
    await canvasesUp(1);
  }

  it("Esc returns to the picture and saves what was drawn", async () => {
    await editing();
    const focus = vi.spyOn(view, "focus");
    const canvas = env.canvases[0]!;
    canvas.api.elements = [el("a"), el("n")];
    await act(async () =>
      canvas.props.onChange!(canvas.api.elements, { viewBackgroundColor: "#ffffff" }, {}),
    );
    const stage = view.dom.querySelector("[data-testid=fake-excalidraw]")!;
    await act(async () => {
      stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    await settle();
    expect(editors()).toHaveLength(0);
    expect(pictures()).toHaveLength(1);
    expect(env.saves).toEqual([A]);
    expect(JSON.parse(env.disk[A]!).elements.map((e: El) => e.id)).toEqual(["a", "n"]);
    expect(focus).toHaveBeenCalled(); // the keyboard goes back to the note
  });

  it("a press outside returns to the picture; a press inside does not", async () => {
    await editing();
    const stage = view.dom.querySelector("[data-testid=fake-excalidraw]")!;
    await act(async () => {
      stage.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(editors()).toHaveLength(1);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    await settle();
    expect(editors()).toHaveLength(0);
    expect(pictures()).toHaveLength(1);
  });

  it("only one editor is open: opening a second closes the first", async () => {
    await ready("![[a.excalidraw]]\n\ntext\n\n![[b.excalidraw]]\n");
    expect(pictures()).toHaveLength(2);
    await click(pictures()[0]!);
    await canvasesUp(1);
    expect(pictures().map((p) => p.getAttribute("aria-label"))).toEqual(["Drawing b.excalidraw"]);
    await click(pictures()[0]!);
    await vi.waitFor(() =>
      expect(pictures().map((p) => p.getAttribute("aria-label"))).toEqual(["Drawing a.excalidraw"]),
    );
    await canvasesUp(1);
    expect(editors()).toHaveLength(1);
    expect(editors()[0]!.getAttribute("data-path")).toBe(B);
  });
});

describe("one session per file", () => {
  function Tab() {
    return <DrawingView location={{ kind: "drawing", path: A } as never} isActive tabId="t" />;
  }

  async function both() {
    await ready("![[a.excalidraw]]\n");
    await click(pictures()[0]!);
    await canvasesUp(1);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Tab />));
    await canvasesUp(2);
    return host;
  }

  it("an edit in the inline canvas is seen by the tab, and saved once", async () => {
    await both();
    const [inline, tab] = env.canvases as [
      (typeof env.canvases)[number],
      (typeof env.canvases)[number],
    ];
    inline.api.elements = [el("a"), el("n")];
    await act(async () =>
      inline.props.onChange!(inline.api.elements, { viewBackgroundColor: "#ffffff" }, {}),
    );
    expect(tab.api.elements.map((e) => (e as El).id)).toEqual(["a", "n"]);
    // the tab echoes what it now holds
    await act(async () =>
      tab.props.onChange!(tab.api.elements, { viewBackgroundColor: "#ffffff" }, {}),
    );
    await act(async () => await flushLiveView(A));
    expect(env.saves).toEqual([A]);
    expect(env.loads).toBe(1);
  });

  it("a change on disk (the CLI) reaches the inline canvas and the tab", async () => {
    await both();
    env.disk[A] = textOf([el("a"), el("cli")]);
    await act(async () => useDiskStore.getState().reload(A));
    await settle();
    await settle();
    for (const c of env.canvases) {
      await vi.waitFor(() => expect(c.api.elements.map((e) => (e as El).id)).toEqual(["a", "cli"]));
    }
  });
});

describe("the session registry", () => {
  it("hands every holder of a path one session, and closes it with the last", async () => {
    const [one, two] = await Promise.all([acquireDrawingSession(A), acquireDrawingSession(A)]);
    expect(one.session).toBe(two.session);
    expect(useDiskStore.getState().views[A]?.refs).toBe(1); // one watcher subscription
    one.session.handleChange([el("a"), el("n")] as never, { viewBackgroundColor: "#ffffff" }, {});
    one.release();
    one.release(); // twice is once
    await settle();
    expect(env.saves).toEqual([]); // still held
    two.release();
    await vi.waitFor(() => expect(env.saves).toEqual([A])); // closing saves what is pending
    await vi.waitFor(() => expect(useDiskStore.getState().views[A]).toBeUndefined());
    const again = await acquireDrawingSession(A);
    expect(again.session).not.toBe(one.session);
    again.release();
  });
});

describe("the note", () => {
  it("is not touched while the canvas is used: no selection, no document change", async () => {
    await ready("intro\n\n![[a.excalidraw]]\n\nafter\n");
    const doc = view.state.doc.toString();
    const selection = view.state.selection;
    changes = 0;
    await click(pictures()[0]!);
    await canvasesUp(1);
    const stage = view.dom.querySelector("[data-testid=fake-excalidraw]")!;
    await act(async () => {
      for (const init of [
        { key: "a" },
        { key: "Backspace" },
        { key: "z", ctrlKey: true },
        { key: "z", metaKey: true },
        { key: "Enter" },
      ]) {
        stage.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        );
      }
      stage.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(changes).toBe(0);
  });
});
