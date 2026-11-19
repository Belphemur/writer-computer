// The PDF tab: only pages near the viewport draw, the width fits by default, zoom (buttons, keys,
// pinch and Cmd+wheel) keeps the page under the pointer, the footer's page box goes to a page,
// `#page=N` from a link scrolls (mounted, active, or activated later), find counts, steps and
// marks, links inside the PDF jump or open, the failure states, and the keep-alive contract.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeDoc, type FakeDoc, type FakeOptions } from "./helpers/fake-doc";

const host = vi.hoisted(() => ({
  doc: null as unknown,
  failOpen: null as Error | null,
  gate: null as Promise<void> | null,
  calls: [] as [string, unknown][],
  openedUrls: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    host.calls.push([cmd, args]);
    if (cmd === "read_document") {
      await host.gate;
      return new ArrayBuffer(8);
    }
    return undefined;
  }),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async (u: string) => void host.openedUrls.push(u)),
  openPath: vi.fn(),
}));
vi.mock("../web/lib/pdf-lib", () => ({
  openDocument: vi.fn(async () => {
    if (host.failOpen) throw host.failOpen;
    return host.doc;
  }),
}));

import { PdfViewer } from "../web/components/pdf-viewer";
import { FIND_DEBOUNCE_MS } from "../web/components/find-bar";
import { FIT_MARGIN, layoutPages, scrollTopOfPage } from "../web/lib/page-layout";
import { activeViewer } from "../web/lib/viewer-controller";
import { setPendingAnchor, revealAnchorInPlace } from "@/lib/pending-anchor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = { width: 800, height: 600 };
const proto = HTMLElement.prototype;
const saved = {
  w: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
};
const FIT = (VIEW.width - 2 * FIT_MARGIN) / 600; // letter-ish pages, 600 wide

let el: HTMLDivElement;
let root: Root;
let doc: FakeDoc;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => VIEW.width });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => VIEW.height });
  host.failOpen = null;
  host.gate = null;
  host.calls = [];
  host.openedUrls = [];
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
  for (const [key, d] of [
    ["clientWidth", saved.w],
    ["clientHeight", saved.h],
  ] as const) {
    if (d) Object.defineProperty(proto, key, d);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const loc = (path = "/v/paper.pdf") => ({ kind: "pdf" as const, path });
const render = (isActive = true, path = "/v/paper.pdf") =>
  root.render(createElement(PdfViewer, { location: loc(path), isActive, tabId: "t" }));
const mount = async (pages = 100, options: FakeOptions = {}, isActive = true) => {
  doc = fakeDoc(pages, options);
  host.doc = doc;
  await act(async () => render(isActive));
  await flush(200); // pdf.js "opens", sizes arrive, the redraw delay passes
};
const scroller = () => el.querySelector<HTMLElement>("[data-testid=pdf-viewer-scroller]")!;
const pageEl = (n: number) => el.querySelector<HTMLElement>(`[data-pdf-page="${n}"]`)!;
const drawnPages = () =>
  [...el.querySelectorAll<HTMLElement>("[data-pdf-page]")]
    .filter((p) => p.querySelector("[data-pdf-canvas]"))
    .map((p) => Number(p.dataset.pdfPage));
const zoomText = () => el.querySelector("[data-testid=pdf-zoom-fit]")?.textContent;
const pageText = () => el.querySelector("[data-testid=pdf-page-box]")?.textContent;
const click = (id: string) =>
  act(() => (el.querySelector(`[data-testid=${id}]`) as HTMLElement).click());
const scrollTo = async (top: number) => {
  scroller().scrollTop = top;
  await act(async () => {
    scroller().dispatchEvent(new Event("scroll"));
  });
  await flush(200);
};
const layoutAt = (scale: number, pages = 100) =>
  layoutPages(Array(pages).fill({ width: 600, height: 800 }), scale);

describe("opening", () => {
  it("reads the bytes through the Rust command and shows the first page of a hundred", async () => {
    await mount();
    expect(host.calls).toContainEqual(["read_document", { path: "/v/paper.pdf" }]);
    expect(pageText()).toBe("1 / 100");
    expect(el.querySelectorAll("[data-pdf-page]")).toHaveLength(100);
  });

  it("draws only the pages near the viewport; the others are sized placeholders", async () => {
    await mount();
    const drawn = drawnPages();
    expect(drawn[0]).toBe(1);
    expect(drawn.length).toBeLessThan(5);
    expect(drawn.length).toBeGreaterThan(0);
    // far pages keep their size and hold nothing
    expect(pageEl(60).children).toHaveLength(0);
    expect(pageEl(60).style.height).toBe(`${800 * FIT}px`);
    expect(doc.drawn.every((d) => d.page <= 4)).toBe(true);
    expect(doc.texted.every((d) => d.page <= 4)).toBe(true);
  });

  it("scrolling draws the pages that come near and lets go of the ones that left", async () => {
    await mount();
    const l = layoutAt(FIT);
    await scrollTo(l.tops[49]!);
    const drawn = drawnPages();
    expect(drawn).toContain(50);
    expect(drawn).not.toContain(1);
    expect(drawn.length).toBeLessThan(6);
    expect(pageText()).toBe("50 / 100");
    expect(pageEl(1).children).toHaveLength(0);
  });

  it("fits the width by default: the footer says Fit and the pages are as wide as the viewer less its margins", async () => {
    await mount();
    expect(zoomText()).toBe("Fit");
    expect(pageEl(1).style.width).toBe(`${600 * FIT}px`);
    expect(doc.lastScale(1)).toBeCloseTo(FIT, 6);
  });

  it("uses each page's own size once it is read", async () => {
    await mount(3, {
      sizes: [
        { width: 600, height: 800 },
        { width: 1200, height: 400 },
        { width: 600, height: 800 },
      ],
    });
    // the widest page (1200) now fits the width
    const fit = (VIEW.width - 2 * FIT_MARGIN) / 1200;
    expect(pageEl(2).style.width).toBe(`${1200 * fit}px`);
    expect(pageEl(1).style.width).toBe(`${600 * fit}px`);
  });

  it("shows the opening state, then the footer", async () => {
    doc = fakeDoc(2);
    host.doc = doc;
    let open!: () => void;
    host.gate = new Promise<void>((r) => (open = r));
    await act(async () => render());
    expect(el.querySelector("[data-testid=pdf-viewer-loading]")?.textContent).toContain(
      "paper.pdf",
    );
    expect(el.querySelector("[data-testid=pdf-viewer-footer]")).toBeNull();
    open();
    await flush(200);
    expect(el.querySelector("[data-testid=pdf-viewer-footer]")).not.toBeNull();
  });

  it("destroys the document when the tab closes", async () => {
    await mount(3);
    await act(async () => root.render(null));
    expect(doc.destroyed).toBe(true);
    root = createRoot(el);
  });

  it("the text layer's root is selectable", async () => {
    await mount(3);
    expect(scroller().hasAttribute("data-selectable")).toBe(true);
    expect(el.querySelector("[data-pdf-text]")).not.toBeNull();
  });
});

describe("failures", () => {
  it("an unreadable PDF says so and offers Open in default app", async () => {
    host.failOpen = Object.assign(new Error("bad"), { name: "InvalidPDFException" });
    await act(async () => render());
    await flush(50);
    const box = el.querySelector("[data-testid=pdf-viewer-error]")!;
    expect(box.textContent).toContain("Can't display this PDF here");
    await act(async () => (box.querySelector("button") as HTMLElement).click());
    expect(host.calls).toContainEqual(["open_attachment_in_default_app", { path: "/v/paper.pdf" }]);
  });

  it("a password-protected PDF says it needs one", async () => {
    host.failOpen = Object.assign(new Error("pw"), { name: "PasswordException" });
    await act(async () => render());
    await flush(50);
    expect(el.querySelector("[data-testid=pdf-viewer-error]")?.textContent).toContain(
      "needs a password",
    );
  });
});

describe("zoom", () => {
  it("the footer buttons step the zoom, the percent returns to Fit", async () => {
    await mount();
    click("pdf-zoom-in");
    await flush(200);
    expect(zoomText()).toBe(`${Math.round(FIT * 1.25 * 100)}%`);
    click("pdf-zoom-in");
    expect(zoomText()).toBe(`${Math.round(FIT * 1.25 * 1.25 * 100)}%`);
    click("pdf-zoom-out");
    click("pdf-zoom-out");
    click("pdf-zoom-out");
    expect(zoomText()).toBe(`${Math.round((FIT / 1.25) * 100)}%`);
    click("pdf-zoom-fit");
    expect(zoomText()).toBe("Fit");
  });

  it("the page boxes follow the zoom and the canvases are drawn again at the new scale", async () => {
    await mount();
    const before = doc.drawn.length;
    click("pdf-zoom-in");
    expect(pageEl(1).style.width).toBe(`${600 * FIT * 1.25}px`);
    await flush(200);
    expect(doc.drawn.length).toBeGreaterThan(before);
    expect(doc.lastScale(1)).toBeCloseTo(FIT * 1.25, 6);
  });

  it("stays inside 25% to 500%", async () => {
    await mount();
    for (let i = 0; i < 30; i++) click("pdf-zoom-in");
    expect(zoomText()).toBe("500%");
    for (let i = 0; i < 40; i++) click("pdf-zoom-out");
    expect(zoomText()).toBe("25%");
  });

  it("the commands reach the viewer of the active tab", async () => {
    await mount();
    expect(activeViewer()).not.toBeNull();
    act(() => activeViewer()!.zoomIn());
    expect(zoomText()).toBe(`${Math.round(FIT * 1.25 * 100)}%`);
    act(() => activeViewer()!.zoomOut());
    expect(zoomText()).toBe("Fit"); // back within the snap distance of Fit
    act(() => activeViewer()!.zoomIn());
    act(() => activeViewer()!.fit());
    expect(zoomText()).toBe("Fit");
  });

  it("an inactive tab is not the target of the commands", async () => {
    await mount(10, {}, false);
    expect(activeViewer()).toBeNull();
  });

  it("Cmd/Ctrl + wheel zooms toward the pointer and does not scroll the page", async () => {
    await mount();
    const l = layoutAt(FIT);
    await scrollTo(l.tops[9]! - 40); // page 10 near the top
    const topBefore = scroller().scrollTop;
    // the pointer is 100px below the viewer's top, over page 10
    scroller().getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const ev = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -20,
      clientX: 400,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => void scroller().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    const zoomed = Number.parseFloat(pageEl(10).style.width) / 600; // unrounded
    expect(zoomed).toBeGreaterThan(FIT);
    // the point of page 10 under the pointer stayed under it
    const k = zoomed / FIT;
    const l2 = layoutAt(zoomed);
    const under = topBefore + 100 - l.tops[9]!;
    expect(scroller().scrollTop).toBeCloseTo(l2.tops[9]! + under * k - 100, 0);
  });

  it("a plain wheel is left to the browser's own scrolling", async () => {
    await mount();
    const ev = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    await act(async () => void scroller().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
    expect(zoomText()).toBe("Fit");
  });

  it("a trackpad pinch (WebKit gesture events) zooms about the pointer", async () => {
    await mount();
    scroller().getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const gesture = (type: string, scale: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { scale, clientX: 400, clientY: 300 });
      return e;
    };
    await act(async () => void scroller().dispatchEvent(gesture("gesturestart", 1)));
    await act(async () => void scroller().dispatchEvent(gesture("gesturechange", 1.5)));
    expect(Number.parseFloat(zoomText()!)).toBeCloseTo(FIT * 150, 0);
  });

  it("keeps the reading position when the zoom changes", async () => {
    await mount();
    const l = layoutAt(FIT);
    await scrollTo(l.tops[19]!);
    expect(pageText()).toBe("20 / 100");
    click("pdf-zoom-in");
    await flush(200);
    expect(pageText()).toBe("20 / 100");
  });
});

describe("go to page", () => {
  const box = () => el.querySelector("[data-testid=pdf-page-box]") as HTMLElement;
  const input = () => el.querySelector("[data-testid=pdf-page-input]") as HTMLInputElement;
  const type = async (value: string, key: string) => {
    await act(async () => {
      input().value = value;
      input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  };

  it("a click turns the page into an input; Enter goes there", async () => {
    await mount();
    act(() => box().click());
    expect(input().value).toBe("1");
    await type("7", "Enter");
    expect(el.querySelector("[data-testid=pdf-page-input]")).toBeNull();
    expect(scroller().scrollTop).toBeCloseTo(scrollTopOfPage(layoutAt(FIT), 7), 0);
    await flush(200);
    expect(pageText()).toBe("7 / 100");
    expect(drawnPages()).toContain(7);
  });

  it("Escape cancels", async () => {
    await mount();
    act(() => box().click());
    await type("9", "Escape");
    expect(el.querySelector("[data-testid=pdf-page-input]")).toBeNull();
    expect(scroller().scrollTop).toBe(0);
    expect(pageText()).toBe("1 / 100");
  });

  it("a page past the end goes to the last page, a non-number does nothing", async () => {
    await mount();
    act(() => box().click());
    await type("5000", "Enter");
    expect(scroller().scrollTop).toBeCloseTo(scrollTopOfPage(layoutAt(FIT), 100), 0);
    act(() => box().click());
    const before = scroller().scrollTop;
    await type("abc", "Enter");
    expect(scroller().scrollTop).toBe(before);
  });
});

describe("#page=N", () => {
  it("opens at the page a link parked for this path", async () => {
    setPendingAnchor("/v/paper.pdf", "page=12");
    await mount();
    expect(scroller().scrollTop).toBeCloseTo(scrollTopOfPage(layoutAt(FIT), 12), 0);
    expect(pageText()).toBe("12 / 100");
    expect(drawnPages()).toContain(12);
  });

  it("keeps the page when the other pages' sizes arrive", async () => {
    setPendingAnchor("/v/paper.pdf", "page=10");
    const tall = { width: 600, height: 1600 };
    await mount(20, { sizes: [{ width: 600, height: 800 }, ...Array(19).fill(tall)] });
    await flush(200);
    expect(pageText()).toBe("10 / 20");
  });

  it("an open, active tab scrolls at once when the same path is revealed", async () => {
    await mount();
    expect(revealAnchorInPlace("/v/paper.pdf", "page=30", { quiet: true })).toBe(true);
    await flush(200);
    expect(pageText()).toBe("30 / 100");
  });

  it("does not take a reveal for another path, an inactive tab, or an anchor without a page", async () => {
    await mount();
    expect(revealAnchorInPlace("/v/other.pdf", "page=3")).toBe(false);
    expect(revealAnchorInPlace("/v/paper.pdf", "heading")).toBe(false);
    await act(async () => render(false));
    expect(revealAnchorInPlace("/v/paper.pdf", "page=3")).toBe(false);
  });

  it("a background tab takes its parked anchor when it is activated", async () => {
    await mount(100, {}, false);
    setPendingAnchor("/v/paper.pdf", "page=40");
    expect(pageText()).toBe("1 / 100");
    await act(async () => render(true));
    await flush(200);
    expect(pageText()).toBe("40 / 100");
  });

  it("an anchor that is not a page leaves the PDF at its top", async () => {
    setPendingAnchor("/v/paper.pdf", "intro");
    await mount();
    expect(pageText()).toBe("1 / 100");
  });
});

describe("find", () => {
  const text = (n: number) =>
    Array.from({ length: n }, (_, p) => [
      `Page ${p + 1} says hello`,
      p % 2 === 0 ? "and hello again" : "nothing here",
    ]);
  const bar = () => el.querySelector("[data-testid=pdf-find-bar]");
  const input = () => el.querySelector<HTMLInputElement>("[data-testid=pdf-find-input]")!;
  const count = () => el.querySelector("[data-testid=pdf-find-count]")?.textContent;
  const search = async (q: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input(), q);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush(FIND_DEBOUNCE_MS + 50);
  };
  const key = async (k: string, shiftKey = false) =>
    act(
      async () =>
        void input().dispatchEvent(
          new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }),
        ),
    );

  it("Cmd/Ctrl+F opens the bar, focused; Escape closes it", async () => {
    await mount(6, { text: text(6) });
    expect(bar()).toBeNull();
    act(() => activeViewer()!.find());
    expect(bar()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    await key("Escape");
    expect(bar()).toBeNull();
  });

  it("counts matches across pages as 1 / 7 and steps with Enter and Shift+Enter", async () => {
    await mount(6, { text: text(6) });
    act(() => activeViewer()!.find());
    await search("hello");
    // 6 pages x 1 + 3 pages x 1 ("and hello again" on pages 1, 3, 5)
    expect(count()).toBe("1 / 9");
    await key("Enter");
    expect(count()).toBe("2 / 9");
    await key("Enter", true);
    await key("Enter", true);
    expect(count()).toBe("9 / 9"); // wraps back from the first to the last
    await key("Enter");
    expect(count()).toBe("1 / 9");
  });

  it("is case-blind and says when nothing matches", async () => {
    await mount(6, { text: text(6) });
    act(() => activeViewer()!.find());
    await search("HELLO");
    expect(count()).toBe("1 / 9");
    await search("zebra");
    expect(count()).toBe("No results");
    await search("");
    expect(count()).toBe("");
  });

  it("marks the matches in the text layer and flags the current one", async () => {
    await mount(6, { text: text(6) });
    act(() => activeViewer()!.find());
    await search("hello");
    const marks = scroller().querySelectorAll("mark.pdf-hit");
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(scroller().querySelectorAll("mark[data-current]")).toHaveLength(1);
    expect([...marks].every((m) => m.textContent?.toLowerCase() === "hello")).toBe(true);
    await key("Enter");
    expect(
      scroller().querySelector("mark[data-current]")!.closest("[data-pdf-page]"),
    ).not.toBeNull();
  });

  it("brings a match on a page far away into view", async () => {
    const t = Array.from({ length: 100 }, (_, p) => [p === 79 ? "the needle" : "hay"]);
    await mount(100, { text: t });
    act(() => activeViewer()!.find());
    await search("needle");
    await flush(300);
    expect(count()).toBe("1 / 1");
    expect(drawnPages()).toContain(80);
    expect(pageText()).toBe("80 / 100");
    expect(scroller().querySelector("mark[data-current]")?.textContent).toBe("needle");
  });

  it("closing clears the marks", async () => {
    await mount(6, { text: text(6) });
    act(() => activeViewer()!.find());
    await search("hello");
    await key("Escape");
    expect(scroller().querySelector("mark")).toBeNull();
  });

  it("a second Cmd+F selects the query again", async () => {
    await mount(6, { text: text(6) });
    act(() => activeViewer()!.find());
    await search("hello");
    input().blur();
    act(() => activeViewer()!.find());
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("hello");
  });
});

describe("links inside the PDF", () => {
  const links = {
    1: [
      { x: 10, y: 10, width: 100, height: 20, page: 5 },
      { x: 10, y: 60, width: 100, height: 20, url: "https://example.com/a" },
    ],
  };

  it("an internal link jumps to its page", async () => {
    await mount(10, { links });
    const internal = el.querySelector<HTMLElement>("[data-pdf-link=internal]")!;
    expect(internal.title).toBe("Page 5");
    await act(async () => internal.click());
    await flush(200);
    expect(pageText()).toBe("5 / 10");
  });

  it("an external link is a browser link: a click opens the URL, a middle click too", async () => {
    await mount(10, { links });
    const external = el.querySelector<HTMLElement>("[data-pdf-link=external]")!;
    await act(async () => external.click());
    expect(host.openedUrls).toEqual(["https://example.com/a"]);
    await act(
      async () =>
        void external.dispatchEvent(
          new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
        ),
    );
    expect(host.openedUrls).toEqual(["https://example.com/a", "https://example.com/a"]);
  });
});

describe("keep-alive", () => {
  it("an inactive tab hides itself, absolutely placed, and keeps its zoom", async () => {
    await mount(10);
    const root_ = () => el.querySelector<HTMLElement>("[data-testid=pdf-viewer]")!;
    expect(root_().className).toContain("relative");
    expect(root_().className).not.toContain("invisible");
    click("pdf-zoom-in");
    await act(async () => render(false));
    expect(root_().className).toContain("absolute inset-0 invisible pointer-events-none");
    await act(async () => render(true));
    expect(root_().className).not.toContain("invisible");
    expect(zoomText()).toBe(`${Math.round(FIT * 1.25 * 100)}%`);
  });
});
