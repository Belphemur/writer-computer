// The shared tooltip for ellipsed labels: delay, warm switching, every way it hides, and that it
// only shows for a truncated label. Widths are mocked (jsdom has no layout).
// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  TOOLTIP_DELAY_MS,
  TOOLTIP_WARM_MS,
  useHoverTooltip,
} from "../src/components/hover-tooltip";

let root: Root;
let host: HTMLElement;
let truncated = true;

function Tab({ id, always = false }: { id: string; always?: boolean }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const { triggerProps, tooltip } = useHoverTooltip({
    labelRef,
    content: { title: `Title ${id}`, detail: "Projects/2026" },
    always,
  });
  return createElement(
    "div",
    { "data-tab": id, tabIndex: 0, ...triggerProps },
    createElement("span", { ref: labelRef }, id),
    tooltip,
  );
}

const tab = (id: string) => host.querySelector<HTMLElement>(`[data-tab=${id}]`)!;
const tip = () => document.querySelector<HTMLElement>("[role=tooltip]");
const enter = (id: string) =>
  act(() => {
    tab(id).dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    tab(id).dispatchEvent(new MouseEvent("pointerenter"));
  });
const leave = (id: string) =>
  act(() => {
    tab(id).dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    tab(id).dispatchEvent(new MouseEvent("pointerleave"));
  });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  truncated = true;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => 200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() =>
    truncated ? 100 : 200,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement("div", null, createElement(Tab, { id: "a" }), createElement(Tab, { id: "b" })),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useHoverTooltip", () => {
  it("shows after the delay with the title and the muted line, linked by aria-describedby", () => {
    enter("a");
    wait(TOOLTIP_DELAY_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()?.textContent).toContain("Title a");
    expect(tip()?.textContent).toContain("Projects/2026");
    expect(tab("a").getAttribute("aria-describedby")).toBe(tip()!.id);
  });

  it("shows nothing for a label that is not truncated, unless asked to always show", () => {
    truncated = false;
    enter("a");
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
    act(() => root.render(createElement(Tab, { id: "a", always: true })));
    enter("a");
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).not.toBeNull();
  });

  it("opens at once on the next tab while warm, and waits the delay once the warm time passed", () => {
    enter("a");
    wait(TOOLTIP_DELAY_MS);
    leave("a");
    expect(tip()).toBeNull();
    enter("b");
    expect(tip()?.textContent).toContain("Title b");
    leave("b");
    wait(TOOLTIP_WARM_MS + 1);
    enter("a");
    expect(tip()).toBeNull();
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).not.toBeNull();
  });

  it("leaving before the delay cancels it", () => {
    enter("a");
    wait(200);
    leave("a");
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
  });

  const shown = () => {
    enter("a");
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).not.toBeNull();
  };

  it("hides on press (which also starts a drag)", () => {
    shown();
    act(() => void tab("a").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(tip()).toBeNull();
  });

  it("hides on Escape, scroll of any scroller and window blur", () => {
    shown();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(tip()).toBeNull();
    shown();
    act(() => void tab("a").dispatchEvent(new Event("scroll")));
    expect(tip()).toBeNull();
    shown();
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(tip()).toBeNull();
  });

  it("shows at once on keyboard focus and hides on blur", () => {
    vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(
      (sel: string) => sel === ":focus-visible",
    );
    act(() => tab("a").focus());
    expect(tip()).not.toBeNull();
    act(() => tab("a").blur());
    expect(tip()).toBeNull();
  });

  it("renders in the popup layer, outside the hovered element", () => {
    shown();
    expect(tab("a").contains(tip())).toBe(false);
    expect(tip()!.parentElement!.id).toBe("writer-popup-layer");
  });
});
