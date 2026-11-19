// The note icon above a note's properties (the slot `editor-note-header`) and the Settings > Icons
// line: nothing and no reserved space without an icon, a click opens the picker for that note.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { clearFileIcons, setFileIcons } from "@/lib/file-icons";
import { useWorkspaceStore } from "@/stores/workspace-store";
import NoteIcon from "../web/note-icon";
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

describe("the note icon", () => {
  it("draws nothing, and reserves no space, for a note without an icon", async () => {
    await act(async () => root.render(<NoteIcon path="/vault/a.md" />));
    expect(host.innerHTML).toBe("");
  });

  it("shows the note's icon, and a click opens the picker for that note", async () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀", color: "#ff0000" }]);
    await act(async () => root.render(<NoteIcon path="/vault/a.md" />));
    const button = host.querySelector<HTMLButtonElement>("[data-note-icon]")!;
    expect(button.querySelector("[data-icon-glyph]")?.textContent).toBe("🚀");
    expect(button.getAttribute("aria-label")).toBe("Change icon");
    await act(async () => button.click());
    expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md"]);
  });

  it("follows another note's icon only", async () => {
    setFileIcons([{ path: "b.md", icon: "emoji:🚀" }]);
    await act(async () => root.render(<NoteIcon path="/vault/a.md" />));
    expect(host.innerHTML).toBe("");
  });
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
