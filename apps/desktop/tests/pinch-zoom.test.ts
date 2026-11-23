// A pinch on WebKitGTK arrives as a Ctrl + wheel event (macOS WKWebView sends gesture events
// instead). The zoom gestures and the mermaid canvas must treat it as a zoom, on every OS.
// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { useZoomGestures, type ZoomGestureHandlers } from "../src/hooks/use-zoom-gestures";
import { canvasWheelFactor } from "../src/components/editor-area/mermaid-canvas";
import { wheelFactor } from "../src/lib/viewer-zoom";

describe("useZoomGestures", () => {
  it("zooms about the pointer on a ctrl+wheel pinch and keeps the webview from zooming", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const handlers: ZoomGestureHandlers = {
      zoomBy: vi.fn(),
      pinchStart: vi.fn(),
      pinchTo: vi.fn(),
    };
    let el: HTMLDivElement | null = null;
    function Harness() {
      const ref = useRef<HTMLDivElement>(null);
      useZoomGestures(ref, handlers);
      return createElement("div", {
        ref: (node: HTMLDivElement | null) => {
          ref.current = node;
          el = node;
        },
      });
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));

    // WebKitGTK's pinch: small pixel deltas, ctrlKey set, no real key held.
    const pinch = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -4,
      clientX: 10,
      clientY: 20,
      bubbles: true,
      cancelable: true,
    });
    act(() => void el!.dispatchEvent(pinch));
    expect(pinch.defaultPrevented).toBe(true);
    expect(handlers.zoomBy).toHaveBeenCalledTimes(1);
    const [factor] = vi.mocked(handlers.zoomBy).mock.calls[0]!;
    expect(factor).toBeCloseTo(wheelFactor(-4));
    expect(factor).toBeGreaterThan(1);

    // A plain wheel is not a zoom: it is left to scroll.
    const plain = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    act(() => void el!.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
    expect(handlers.zoomBy).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

describe("canvasWheelFactor (mermaid canvas)", () => {
  it("on Linux a pinch zooms in smoothly and a Ctrl+wheel notch is one gentle step", () => {
    const pinch = canvasWheelFactor({ deltaY: -3, ctrlKey: true, metaKey: false }, "linux");
    expect(pinch).toBeGreaterThan(1);
    expect(pinch).toBeLessThan(1.1);
    const notch = canvasWheelFactor({ deltaY: -100, ctrlKey: true, metaKey: false }, "linux");
    expect(notch).toBeLessThan(2); // not the macOS pinch curve, which would be e^1
    expect(canvasWheelFactor({ deltaY: 100, ctrlKey: true, metaKey: false }, "linux")).toBeLessThan(
      1,
    );
  });

  it("macOS keeps its curves: Ctrl (pinch) is steeper than Cmd (wheel)", () => {
    const pinch = canvasWheelFactor({ deltaY: -10, ctrlKey: true, metaKey: false }, "macos");
    const wheel = canvasWheelFactor({ deltaY: -10, ctrlKey: false, metaKey: true }, "macos");
    expect(pinch).toBeCloseTo(Math.exp(0.1));
    expect(wheel).toBeCloseTo(Math.exp(0.015));
  });
});
