// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useStickToBottom } from "@features/agent/web/components/use-stick-to-bottom";
import { liveHtml } from "@features/agent/web/components/assistant-text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no layout: each scroller gets a settable content height and a viewport, and
 *  `scrollTop` clamps like a browser's. */
class Geometry {
  content = 1000;
  viewport = 300;
  top = 0;
  get max() {
    return Math.max(0, this.content - this.viewport);
  }
  install(el: HTMLElement) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => this.content });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => this.viewport });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => Math.min(this.top, this.max),
      set: (v: number) => {
        this.top = Math.max(0, Math.min(v, this.max));
      },
    });
  }
}

let observers: Array<{ cb: () => void; targets: Element[] }> = [];
class FakeResizeObserver {
  entry: { cb: () => void; targets: Element[] };
  constructor(cb: () => void) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(t: Element) {
    this.entry.targets.push(t);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.entry);
  }
  unobserve() {}
}
const resize = () => act(() => observers.slice().forEach((o) => o.cb()));

const geo = { outer: new Geometry(), inner: new Geometry() };

function Harness({ nested = false }: { nested?: boolean }) {
  const outer = useStickToBottom();
  return (
    <div ref={outer.scrollRef} data-testid="outer">
      <div ref={outer.contentRef}>{nested && <Inner />}</div>
    </div>
  );
}
function Inner() {
  const inner = useStickToBottom();
  return (
    <div ref={inner.scrollRef} data-testid="inner">
      <div ref={inner.contentRef} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`)!;

async function mount(nested = false) {
  // install geometry before the effect measures: patch on first ref assignment via prototype hook
  const orig = HTMLDivElement.prototype.getAttribute;
  void orig;
  await act(async () => {
    root.render(<Harness nested={nested} />);
  });
  geo.outer.install(q("outer"));
  if (nested) geo.inner.install(q("inner"));
}

beforeEach(() => {
  observers = [];
  geo.outer = new Geometry();
  geo.inner = new Geometry();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const scrollEvent = (el: HTMLElement) => act(() => void el.dispatchEvent(new Event("scroll")));
const wheel = (el: HTMLElement, deltaY: number) =>
  act(() => void el.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true })));

describe("useStickToBottom", () => {
  it("follows content that grows after commit, with no version change", async () => {
    await mount();
    await resize();
    expect(geo.outer.top).toBe(700);
    geo.outer.content = 1400;
    await resize();
    expect(geo.outer.top).toBe(1100);
    // a shrink then a growth (a partial block re-laid out) ends at the bottom, not short of it
    geo.outer.content = 1300;
    await resize();
    geo.outer.content = 1500;
    await resize();
    expect(geo.outer.top).toBe(1200);
  });

  it("a programmatic scroll does not unstick", async () => {
    await mount();
    await resize();
    geo.outer.content = 1400;
    await resize();
    // our own scroll event arrives after more content already landed (not at the bottom now)
    geo.outer.content = 1500;
    await scrollEvent(q("outer"));
    await resize();
    expect(geo.outer.top).toBe(1200);
  });

  it("a user scroll up unsticks and returning to the bottom sticks again", async () => {
    await mount();
    await resize();
    geo.outer.top = 400;
    await wheel(q("outer"), -40);
    await scrollEvent(q("outer"));
    geo.outer.content = 1400;
    await resize();
    expect(geo.outer.top).toBe(400);
    expect(q("outer").style.overflowAnchor).toBe("");
    geo.outer.top = geo.outer.max;
    await scrollEvent(q("outer"));
    geo.outer.content = 1600;
    await resize();
    expect(geo.outer.top).toBe(1300);
    expect(q("outer").style.overflowAnchor).toBe("none");
  });

  it("a scrollbar drag away from the bottom unsticks", async () => {
    await mount();
    await resize();
    act(() => void q("outer").dispatchEvent(new Event("pointerdown", { bubbles: true })));
    geo.outer.top = 200;
    await scrollEvent(q("outer"));
    geo.outer.content = 1400;
    await resize();
    expect(geo.outer.top).toBe(200);
  });

  it("a nested scroller and the outer one do not fight", async () => {
    await mount(true);
    await resize();
    expect(geo.outer.top).toBe(700);
    expect(geo.inner.top).toBe(700);
    // the user scrolls the reasoning box up: the outer transcript keeps following
    geo.inner.top = 100;
    await wheel(q("inner"), -30);
    geo.outer.content = 1200;
    geo.inner.content = 1200;
    await resize();
    expect(geo.outer.top).toBe(900);
    expect(geo.inner.top).toBe(100);
  });
});

describe("the live tail stays inside the block it continues", () => {
  it("a paragraph's tail joins the paragraph, a new block's tail follows it", () => {
    const joined = liveHtml({ id: "t1", text: "Hello" }, 0);
    expect(joined).toBe(liveHtml({ id: "t1", text: "Hello" }, 1));
    const more = liveHtml({ id: "t1", text: "Hello wor" }, 2);
    expect(more).toMatch(/<p[^>]*>Hello<span[^>]*> wor<\/span><\/p>/);
    const block = liveHtml({ id: "t2", text: "A" }, 0);
    void block;
    const next = liveHtml({ id: "t2", text: "A\n\nB" }, 1);
    expect(next).toMatch(/<\/p>\s*<span[^>]*>\n\nB<\/span>$/);
  });

  it("a list item's tail joins the item", () => {
    liveHtml({ id: "t3", text: "- one" }, 0);
    const out = liveHtml({ id: "t3", text: "- one two" }, 1);
    expect(out).toMatch(/one<span[^>]*> two<\/span><\/li>/);
  });
});
