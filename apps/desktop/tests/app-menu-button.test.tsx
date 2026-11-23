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
const key = (type: "keydown" | "keyup", k: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
  });

describe("AppMenuButton", () => {
  it("opens the menu on click on Linux", async () => {
    await render("linux");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(openAppMenu).toHaveBeenCalledTimes(1);
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

  it("renders nothing and ignores Alt on macOS", async () => {
    await render("macos");
    expect(container.querySelector("button")).toBeNull();
    await key("keydown", "Alt");
    await key("keyup", "Alt");
    expect(openAppMenu).not.toHaveBeenCalled();
  });
});
