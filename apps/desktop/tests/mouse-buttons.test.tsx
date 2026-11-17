// @vitest-environment jsdom
// Mouse side buttons (3 = back, 4 = forward) drive the editor's navigation history: natively on
// macOS (Tauri event from the NSEvent monitor) and as DOM events elsewhere. Stores, Tauri and the
// logger are faked; nothing here touches a real window.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, h: Handler) => {
    listeners.set(name, h);
    return unlisten;
  }),
}));
const logs: string[] = [];
vi.mock("@/lib/logger", () => ({
  logger: { log: (_l: string, _s: string, m: string) => logs.push(m) },
}));

const back = vi.fn(async () => {});
const forward = vi.fn(async () => {});
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: Object.assign(() => undefined, {
    getState: () => ({ navigateBack: back, navigateForward: forward }),
  }),
}));

import { listen } from "@tauri-apps/api/event";
import { useMouseNavigation, MOUSE_NAVIGATE_EVENT } from "../src/hooks/use-mouse-navigation";

function Harness() {
  useMouseNavigation();
  return null;
}

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  for (const m of [back, forward, unlisten, vi.mocked(listen)]) m.mockClear();
  listeners.clear();
  logs.length = 0;
});

const dom = (button: number, type = "mouseup") => {
  const e = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};
const native = (direction: string) =>
  act(() => listeners.get(MOUSE_NAVIGATE_EVENT)!({ payload: { direction } }));

describe("native side buttons", () => {
  it("registers one listener and removes it on unmount", async () => {
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listeners.has(MOUSE_NAVIGATE_EVENT)).toBe(true);
    act(() => root.unmount());
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
    root = createRoot(document.createElement("div"));
  });

  it("back and forward call the matching store action once", () => {
    native("back");
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    native("forward");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["mouse back (native)", "mouse forward (native)"]);
  });

  it("ignores an unknown direction", () => {
    native("sideways");
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("a DOM event right after a native one is the same press", () => {
    native("back");
    dom(3);
    expect(back).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    dom(3);
    expect(back).toHaveBeenCalledTimes(2);
  });
});

describe("DOM fallback", () => {
  it("button 3 goes back and button 4 goes forward on mouseup", () => {
    expect(dom(3).defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(dom(4).defaultPrevented).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("a mousedown or auxclick of a side button does not navigate", () => {
    dom(3, "mousedown");
    dom(3, "auxclick");
    expect(back).not.toHaveBeenCalled();
  });

  it("left, middle and right buttons do not navigate", () => {
    for (const b of [0, 1, 2]) expect(dom(b).defaultPrevented).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("logs the middle button once it reaches the page", () => {
    dom(1, "mousedown");
    expect(logs).toEqual(["mouse middle button reached the page (mousedown)"]);
  });

  it("stops listening after unmount", () => {
    act(() => root.unmount());
    dom(3);
    expect(back).not.toHaveBeenCalled();
    root = createRoot(document.createElement("div"));
  });
});
