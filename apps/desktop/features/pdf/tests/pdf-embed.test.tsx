// A PDF in a note: which lines become embeds (only a paragraph of its own, never code or a list),
// the embed itself (default 480 px, `#height=`, its own scroller, `#page=` start, page `x / n`,
// Open in tab as a browser-like link) and the widget's identity.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeDoc, type FakeDoc } from "./helpers/fake-doc";

const host = vi.hoisted(() => ({
  doc: null as unknown,
  resolved: "/v/Papers/paper.pdf" as string | null,
  opened: [] as (string | [string, string])[],
  calls: [] as [string, unknown][],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    host.calls.push([cmd, args]);
    if (cmd === "read_document") return new ArrayBuffer(8);
    if (cmd === "resolve_wiki_link") return host.resolved;
    return undefined;
  }),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));
vi.mock("@/hooks/editor-api", async (orig) => ({
  ...(await orig<object>()),
  getActiveFilePath: () => "/v/Notes/plan.md",
  navigateToFile: (p: string) => void host.opened.push(p),
  openFileInNewTab: (p: string, o?: { activate?: boolean }) =>
    void host.opened.push([p, o?.activate === false ? "bg" : "tab"]),
}));
vi.mock("@/hooks/workspace-api", async (orig) => ({
  ...(await orig<object>()),
  getWorkspaceRoot: () => "/v",
}));
vi.mock("../web/lib/pdf-lib", () => ({ openDocument: vi.fn(async () => host.doc) }));

import { PdfEmbed } from "../web/components/pdf-embed";
import { PDF_EMBED_DEFAULT_HEIGHT } from "../web/lib/embeds";
import { pdfEmbedInParagraph, pdfEmbedDecorations } from "../web/embed-decorations";
import { FIT_MARGIN, layoutPages, scrollTopOfPage } from "../web/lib/page-layout";
import { takePendingAnchor } from "@/lib/pending-anchor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("which lines are embeds", () => {
  const stateOf = (doc: string) =>
    EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
  const found = (doc: string) => {
    const state = stateOf(doc);
    const out: { from: number; to: number; page: number; height: number }[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        const f = pdfEmbedInParagraph(state, node);
        if (f) out.push({ from: f.from, to: f.to, page: f.embed.page, height: f.embed.height });
      },
    });
    return out;
  };

  it("a paragraph that is one PDF embed, with its page and height", () => {
    const doc = "# Notes\n\n![[paper.pdf#page=3&height=600]]\n\ntext";
    const [one, ...rest] = found(doc);
    expect(rest).toEqual([]);
    expect(doc.slice(one!.from, one!.to)).toBe("![[paper.pdf#page=3&height=600]]");
    expect(one).toMatchObject({ page: 3, height: 600 });
  });

  it("not inside a list, a quote, code, or a longer paragraph", () => {
    expect(found("- ![[a.pdf]]")).toEqual([]);
    expect(found("> ![[a.pdf]]")).toEqual([]);
    expect(found("```\n![[a.pdf]]\n```")).toEqual([]);
    expect(found("![[a.pdf]]\nmore text")).toEqual([]);
    expect(found("see ![[a.pdf]]")).toEqual([]);
  });

  it("is one editor extension, ready for the feature's `editorExtensions` point", () => {
    expect(Array.isArray(pdfEmbedDecorations())).toBe(true);
  });
});

describe("the embed", () => {
  const proto = HTMLElement.prototype;
  let el: HTMLDivElement;
  let root: Root;
  let doc: FakeDoc;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const [name, value] of [
      ["clientWidth", 700],
      ["clientHeight", 480],
    ] as const)
      Object.defineProperty(proto, name, { configurable: true, get: () => value });
    host.resolved = "/v/Papers/paper.pdf";
    host.opened = [];
    host.calls = [];
    el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
    vi.useRealTimers();
    delete (proto as unknown as Record<string, unknown>).clientWidth;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
  });

  const flush = async (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const mount = async (page = 1, height = PDF_EMBED_DEFAULT_HEIGHT, pages = 10) => {
    doc = fakeDoc(pages);
    host.doc = doc;
    await act(async () =>
      root.render(
        createElement(PdfEmbed, {
          target: "paper.pdf",
          notePath: "/v/Notes/plan.md",
          page,
          height,
        }),
      ),
    );
    await flush(200);
  };
  const box = () => el.querySelector<HTMLElement>("[data-pdf-embed]")!;
  const scroller = () => el.querySelector<HTMLElement>("[data-testid=pdf-embed-scroller]")!;
  const label = () => el.querySelector("[data-testid=pdf-embed-page]")?.textContent;

  it("resolves the name through the index and reads the PDF by its path", async () => {
    await mount();
    expect(host.calls).toContainEqual([
      "resolve_wiki_link",
      { target: "paper.pdf", sourcePath: "/v/Notes/plan.md" },
    ]);
    expect(host.calls).toContainEqual(["read_document", { path: "/v/Papers/paper.pdf" }]);
  });

  it("is 480 px tall by default and as tall as #height= says", async () => {
    await mount();
    expect(box().style.height).toBe("480px");
    act(() => root.unmount());
    root = createRoot(el);
    await mount(1, 600);
    expect(box().style.height).toBe("600px");
  });

  it("has its own scroller, fits the width and shows page x / n", async () => {
    await mount();
    expect(scroller().className).toContain("overflow-auto");
    expect(scroller().hasAttribute("data-selectable")).toBe(true);
    const page = el.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
    expect(page.style.width).toBe(`${700 - 2 * FIT_MARGIN}px`);
    expect(label()).toBe("1 / 10");
    // an embed does not zoom: no zoom control, and Cmd+wheel is left to the page
    expect(el.querySelector("[data-testid=pdf-zoom-fit]")).toBeNull();
    const ev = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -20,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => void scroller().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
  });

  it("opens at the page of #page=N", async () => {
    await mount(3);
    const scale = (700 - 2 * FIT_MARGIN) / 600;
    const l = layoutPages(Array(10).fill({ width: 600, height: 800 }), scale);
    expect(scroller().scrollTop).toBeCloseTo(scrollTopOfPage(l, 3), 0);
    expect(label()).toBe("3 / 10");
  });

  it("draws only pages near its small viewport", async () => {
    await mount(1, 480, 200);
    expect(doc.drawn.every((d) => d.page <= 3)).toBe(true);
  });

  it("Open in tab is a link: click opens here at the page the embed is on, Cmd+click a new tab", async () => {
    await mount(3);
    const open = el.querySelector<HTMLElement>("[data-testid=pdf-embed-open]")!;
    expect(open.textContent).toBe("Open in tab");
    await act(async () => open.click());
    await flush(10);
    expect(host.opened).toEqual(["/v/Papers/paper.pdf"]);
    expect(takePendingAnchor("/v/Papers/paper.pdf")?.anchor).toBe("page=3");
    host.opened = [];
    await act(
      async () =>
        void open.dispatchEvent(
          new MouseEvent("click", {
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    await flush(10);
    expect(host.opened).toEqual([["/v/Papers/paper.pdf", "bg"]]);
    takePendingAnchor("/v/Papers/paper.pdf");
  });

  it("says so when the PDF is not in the vault", async () => {
    host.resolved = null;
    await mount();
    expect(box().textContent).toBe("PDF not found: paper.pdf");
    expect(host.calls.some(([c]) => c === "read_document")).toBe(false);
  });
});
