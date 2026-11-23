// @vitest-environment jsdom
// The window can be closed and moved from the crash screen: `AppRoot` mounts the controls and a drag
// strip outside the error boundary (and before the app resolves startup).
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
vi.mock("@/hooks/use-settings", () => ({ useBooleanSetting: () => false }));
vi.mock("@/hooks/editor-api", () => ({
  getActiveFilePath: () => null,
  closeActiveTab: () => {},
}));

import { AppRoot } from "@/components/app-root";

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error("boom");
}

describe("AppRoot", () => {
  it("keeps a working Close button and a drag strip on the error screen", async () => {
    await act(async () =>
      root.render(
        <AppRoot>
          <Boom />
        </AppRoot>,
      ),
    );
    expect(container.textContent).toContain("Something went wrong");
    expect(container.querySelector("[data-tauri-drag-region]")).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    );
    expect(tauri.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("shows the controls while the app below renders nothing (before startup resolves)", async () => {
    await act(async () => root.render(<AppRoot>{null}</AppRoot>));
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });
});
