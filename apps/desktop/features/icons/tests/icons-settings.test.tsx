// The Settings > Icons line (how many Iconize icons use packs Writer does not show).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { clearFileIcons } from "@/lib/file-icons";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useIconPickerStore } from "../web/picker-store";
import { IconsSection } from "../web/settings-page";
import { useIconizeStatus } from "../web/sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useWorkspaceStore.setState({ root: "/vault" });
  clearFileIcons();
  useIconPickerStore.getState().close();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Settings > Icons", () => {
  it("says how many Iconize icons use packs Writer does not show, and nothing alarming otherwise", async () => {
    await act(async () => root.render(<IconsSection />));
    expect(host.textContent).toBe("Iconize icons show as they are.");
    await act(async () => useIconizeStatus.setState({ unsupported: 1 }));
    expect(host.textContent).toBe("1 Iconize icon uses a pack Writer does not show.");
    await act(async () => useIconizeStatus.setState({ unsupported: 4 }));
    expect(host.textContent).toBe("4 Iconize icons use packs Writer does not show.");
    useIconizeStatus.setState({ unsupported: 0 });
  });
});
