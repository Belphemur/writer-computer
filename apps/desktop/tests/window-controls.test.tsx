// @vitest-environment jsdom
// Writer's own minimize, maximize and close (Linux, ADR 2026-11-20): shown on Linux only, hidden
// when the desktop's frame is on, each button calls its window API.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tauri = vi.hoisted(() => ({
  closeWindow: vi.fn(() => Promise.resolve()),
  minimizeWindow: vi.fn(() => Promise.resolve()),
  toggleMaximizeWindow: vi.fn(() => Promise.resolve()),
  isWindowMaximized: vi.fn(() => Promise.resolve(false)),
  onWindowResized: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/lib/tauri", () => tauri);

const settings = vi.hoisted(() => ({ native: false }));
vi.mock("@/hooks/use-settings", () => ({ useBooleanSetting: () => settings.native }));

import { WindowControls } from "@/components/window-controls";

const UA = {
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
};

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  settings.native = false;
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
  await act(async () => root.render(<WindowControls />));
}
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("WindowControls", () => {
  it("renders minimize, maximize and close on Linux", async () => {
    await render("linux");
    expect(button("Minimize")).not.toBeNull();
    expect(button("Maximize")).not.toBeNull();
    expect(button("Close")).not.toBeNull();
  });

  it("renders nothing on macOS", async () => {
    await render("macos");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing on Linux when the native frame is on", async () => {
    settings.native = true;
    await render("linux");
    expect(container.querySelector("button")).toBeNull();
  });

  it("each button calls its window API", async () => {
    await render("linux");
    await act(async () => button("Minimize")!.click());
    await act(async () => button("Maximize")!.click());
    await act(async () => button("Close")!.click());
    expect(tauri.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(tauri.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(tauri.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("offers Restore while the window is maximized", async () => {
    tauri.isWindowMaximized.mockResolvedValue(true);
    await render("linux");
    expect(button("Restore")).not.toBeNull();
    expect(button("Maximize")).toBeNull();
  });
});
