// @vitest-environment jsdom
// The Linux menu button and the Alt key open the app menu through one IPC call; macOS has the
// native menu bar, so nothing renders and Alt does nothing.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openAppMenu = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/tauri", () => ({ openAppMenu }));

import { AppMenuButton } from "@/components/app-menu-button";
import { chromeInset, MENU_BUTTON } from "@/lib/platform";
import { beginKeyRecording } from "@/lib/keybindings/recording";

const UA = {
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
};

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(platform: keyof typeof UA) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA[platform]);
  await act(async () => root.render(<AppMenuButton />));
}
const key = (type: "keydown" | "keyup", k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, ...init }));
  });

describe("AppMenuButton", () => {
  it("opens the menu on click on Linux", async () => {
    await render("linux");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(openAppMenu).toHaveBeenCalledTimes(1);
  });

  it("takes exactly the width chromeInset reserves at the left", async () => {
    await render("linux");
    const b = container.querySelector<HTMLButtonElement>("button")!;
    expect(parseFloat(b.style.left) + parseFloat(b.style.width) + MENU_BUTTON.gap).toBe(
      chromeInset("linux").start,
    );
  });

  it("opens the menu when Alt is pressed and released alone", async () => {
    await render("linux");
    await key("keydown", "Alt");
    await key("keyup", "Alt");
    expect(openAppMenu).toHaveBeenCalledTimes(1);
  });

  it("does not open it when another key came between", async () => {
    await render("linux");
    await key("keydown", "Alt");
    await key("keydown", "Tab");
    await key("keyup", "Alt");
    expect(openAppMenu).not.toHaveBeenCalled();
  });

  it("does not open it when another handler stopped the key in between (Alt+ArrowLeft)", async () => {
    await render("linux");
    const stop = (e: Event) => e.stopPropagation();
    document.body.addEventListener("keydown", stop);
    try {
      await key("keydown", "Alt");
      await key("keydown", "ArrowLeft");
      await key("keyup", "Alt");
    } finally {
      document.body.removeEventListener("keydown", stop);
    }
    expect(openAppMenu).not.toHaveBeenCalled();
  });

  it("does not open it for Ctrl+Alt, Shift+Alt or while composing", async () => {
    await render("linux");
    await key("keydown", "Alt", { ctrlKey: true });
    await key("keyup", "Alt", { ctrlKey: true });
    await key("keydown", "Alt", { shiftKey: true });
    await key("keyup", "Alt", { shiftKey: true });
    // Ctrl pressed after Alt: released with Ctrl still held.
    await key("keydown", "Alt");
    await key("keyup", "Alt", { ctrlKey: true });
    await key("keydown", "Alt", { isComposing: true });
    await key("keyup", "Alt", { isComposing: true });
    expect(openAppMenu).not.toHaveBeenCalled();
  });

  it("does not open it while the Hotkeys page records a key, or after the wheel", async () => {
    await render("linux");
    const end = beginKeyRecording();
    await key("keydown", "Alt");
    await key("keyup", "Alt");
    end();
    await key("keydown", "Alt");
    await act(async () => {
      document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    await key("keyup", "Alt");
    expect(openAppMenu).not.toHaveBeenCalled();
  });

  it("registers no key listener on macOS", async () => {
    const add = vi.spyOn(window, "addEventListener");
    await render("macos");
    expect(add.mock.calls.filter(([type]) => type === "keydown" || type === "keyup")).toEqual([]);
  });

  it("renders nothing and ignores Alt on macOS", async () => {
    await render("macos");
    expect(container.querySelector("button")).toBeNull();
    await key("keydown", "Alt");
    await key("keyup", "Alt");
    expect(openAppMenu).not.toHaveBeenCalled();
  });
});
