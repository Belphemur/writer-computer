// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { scrollIntoScroller, scrollParent } from "@/lib/scroll-into";

const rect = (top: number, height: number) =>
  ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;

function box(overflowY: string, top: number, height: number, parent: HTMLElement = document.body) {
  const el = document.createElement("div");
  el.style.overflowY = overflowY;
  el.getBoundingClientRect = () => rect(top, height);
  parent.appendChild(el);
  return el;
}

function item(parent: HTMLElement, top: number, height: number) {
  return box("visible", top, height, parent);
}

describe("scrollIntoScroller", () => {
  it("finds the nearest scrolling ancestor and skips hidden and clip frames", () => {
    const frame = box("clip", 0, 500);
    const hidden = box("hidden", 0, 500, frame);
    const list = box("auto", 0, 100, hidden);
    const row = item(list, 0, 10);
    expect(scrollParent(row)).toBe(list);
    expect(scrollParent(list)).toBeNull();
  });

  it("start aligns the target to the scroller's top", () => {
    const list = box("auto", 100, 200);
    list.scrollTop = 50;
    expect(scrollIntoScroller(item(list, 400, 20), { block: "start" })).toBe(true);
    expect(list.scrollTop).toBe(350);
  });

  it("center puts the target's middle at the scroller's middle", () => {
    const list = box("auto", 0, 100);
    scrollIntoScroller(item(list, 300, 20), { block: "center" });
    expect(list.scrollTop).toBe(260);
  });

  it("nearest moves only as far as needed, and not at all when visible", () => {
    const list = box("auto", 0, 100);
    list.scrollTop = 10;
    scrollIntoScroller(item(list, 30, 20), { block: "nearest" });
    expect(list.scrollTop).toBe(10);
    scrollIntoScroller(item(list, 110, 20), { block: "nearest" });
    expect(list.scrollTop).toBe(40);
    scrollIntoScroller(item(list, -20, 20), { block: "nearest" });
    expect(list.scrollTop).toBe(20);
  });

  it("does nothing without a scroller, and never touches a frame above the scroller", () => {
    const frame = box("clip", 0, 500);
    const row = item(frame, 900, 20);
    expect(scrollIntoScroller(row, { block: "start" })).toBe(false);
    expect(frame.scrollTop).toBe(0);

    const list = box("auto", 0, 100, frame);
    scrollIntoScroller(item(list, 900, 20), { block: "start" });
    expect(frame.scrollTop).toBe(0);
    expect(list.scrollTop).toBe(900);
  });

  it("an explicit scroller wins, even when jsdom cannot see its overflow", () => {
    const list = document.createElement("div");
    list.getBoundingClientRect = () => rect(0, 100);
    scrollIntoScroller(item(list, 70, 10), { block: "start", scroller: list });
    expect(list.scrollTop).toBe(70);
  });
});
