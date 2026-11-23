// @vitest-environment jsdom
// The mouse side buttons run the registry's `history-back` / `history-forward` commands
// (SPECs/linux-support-spec.md "Default hotkeys per OS"), context and recording guard included.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

const os = vi.hoisted(() => ({ platform: "linux" as "macos" | "linux" }));
vi.mock("../src/lib/platform", () => ({ detectPlatform: () => os.platform }));

import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";
import { beginKeyRecording } from "../src/lib/keybindings/recording";
import { useEditorStore } from "../src/stores/editor-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useKeyboardShortcuts();
  return null;
}

let root: Root;
let host: HTMLElement;
const navigateBack = vi.fn(async () => {});
const navigateForward = vi.fn(async () => {});

beforeEach(async () => {
  os.platform = "linux";
  navigateBack.mockClear();
  navigateForward.mockClear();
  useEditorStore.setState({ navigateBack, navigateForward } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll("[data-agent-pane]").forEach((n) => n.remove());
});

const release = (target: EventTarget, button: number) => {
  const e = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe("mouse side buttons", () => {
  it("button 3 outside the agent pane goes back once, button 4 forward", () => {
    const e = release(document.body, 3);
    expect(navigateBack).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    release(document.body, 4);
    expect(navigateForward).toHaveBeenCalledTimes(1);
    expect(navigateBack).toHaveBeenCalledTimes(1);
  });

  it("does nothing inside the agent pane", () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-agent-pane", "");
    document.body.append(pane);
    const e = release(pane, 3);
    expect(navigateBack).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("does nothing on macOS, where the mouse driver sends Cmd+[", () => {
    os.platform = "macos";
    release(document.body, 3);
    expect(navigateBack).not.toHaveBeenCalled();
  });

  it("does nothing while a shortcut is being recorded", () => {
    const end = beginKeyRecording();
    release(document.body, 3);
    end();
    expect(navigateBack).not.toHaveBeenCalled();
  });
});
