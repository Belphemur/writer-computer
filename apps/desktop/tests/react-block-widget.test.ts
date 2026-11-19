// @vitest-environment jsdom
// The shared React block widget: HeightMemory eviction, and the host lifecycle (React root kept
// across `updateDOM`, unmounted on a microtask in `destroy`, events left to the React tree).
import { createElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EditorView } from "@codemirror/view";
import { HeightMemory, ReactBlockWidget } from "@/lib/react-block-widget";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HeightMemory", () => {
  it("falls back, remembers, and evicts the least recently set", () => {
    const m = new HeightMemory(100, 2);
    expect(m.get("a")).toBe(100);
    m.remember("a", 10);
    m.remember("b", 20);
    m.remember("a", 11); // refreshes a
    m.remember("c", 30);
    expect([m.get("a"), m.get("b"), m.get("c")]).toEqual([11, 100, 30]);
    m.clear();
    expect(m.get("a")).toBe(100);
  });
});

const heights = new HeightMemory(50, 10);
class Probe extends ReactBlockWidget {
  protected readonly className = "probe";
  protected readonly heights = heights;
  constructor(readonly text: string) {
    super();
  }
  eq(o: Probe) {
    return o.text === this.text;
  }
  protected heightKey() {
    return this.text;
  }
  protected content(): ReactElement {
    return createElement("span", { "data-probe": "" }, this.text);
  }
}
const view = { requestMeasure: vi.fn() } as unknown as EditorView;

describe("ReactBlockWidget", () => {
  it("estimates from the remembered height", () => {
    expect(new Probe("x").estimatedHeight).toBe(50);
    heights.remember("x", 80);
    expect(new Probe("x").estimatedHeight).toBe(80);
  });

  it("renders, updates in place, and unmounts on a microtask", async () => {
    const w = new Probe("one");
    const dom = w.toDOM(view);
    expect(dom.className).toBe("probe");
    expect(dom.contentEditable).toBe("false");
    await vi.waitFor(() => expect(dom.textContent).toBe("one"));
    expect(new Probe("two").updateDOM(dom, view)).toBe(true);
    await vi.waitFor(() => expect(dom.textContent).toBe("two"));
    w.destroy(dom);
    await vi.waitFor(() => expect(dom.textContent).toBe(""));
    expect(new Probe("three").updateDOM(dom, view)).toBe(false); // destroyed: not its DOM any more
    expect(w.ignoreEvent()).toBe(true);
  });
});
