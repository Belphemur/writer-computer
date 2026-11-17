// @vitest-environment jsdom
// Mouse side buttons (3 = back, 4 = forward) drive the editor's navigation history, and a middle
// click on a tab closes it. Stores and Tauri are faked; nothing here touches a real window.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@/lib/tauri", () => ({ closeWindow: vi.fn() }));

const back = vi.fn(async () => {});
const forward = vi.fn(async () => {});
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: Object.assign(() => undefined, {
    subscribe: () => () => {},
    setState: () => {},
    getState: () => ({
      tabs: [],
      activeTabId: null,
      setActiveTab: vi.fn(),
      openNewTab: vi.fn(),
      closeActiveTab: vi.fn(),
      navigateBack: back,
      navigateForward: forward,
    }),
  }),
}));

import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";

function Harness() {
  useKeyboardShortcuts();
  return null;
}

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  back.mockClear();
  forward.mockClear();
});

const press = (button: number) => {
  const e = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("mouse side buttons", () => {
  it("button 3 goes back and button 4 goes forward", () => {
    expect(press(3).defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(press(4).defaultPrevented).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("left, middle and right buttons do not navigate", () => {
    for (const b of [0, 1, 2]) expect(press(b).defaultPrevented).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    act(() => root.unmount());
    press(3);
    expect(back).not.toHaveBeenCalled();
    root = createRoot(document.createElement("div"));
  });
});
