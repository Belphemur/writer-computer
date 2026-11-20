// Editor tabs: the hover tooltip shows the full title and the vault folder when the label is
// truncated (or the tab is pinned), and the native `title` is gone so two never show.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { EditorTabs } from "../src/components/editor-area/editor-tabs";
import { TOOLTIP_DELAY_MS } from "../src/components/hover-tooltip";
import { useEditorStore, type Tab } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

let root: Root;
let host: HTMLElement;
let truncated = true;

const fileTab = (id: string, path: string, pinned = false): Tab => ({
  id,
  location: { kind: "file", path },
  back: [],
  forward: [],
  ...(pinned ? { pinned: true } : {}),
});
const buttonOf = (id: string) =>
  host.querySelector<HTMLElement>(`[data-tab-id="${id}"] [role=button]`)!;
const tip = () => document.querySelector<HTMLElement>("[role=tooltip]");
const hover = (id: string) => {
  act(() => void buttonOf(id).dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
  truncated = true;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => 200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() =>
    truncated ? 100 : 200,
  );
  useWorkspaceStore.setState({ root: "/ws" });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [
      fileTab("a", "/ws/Projects/2026/Quarterly planning.md"),
      fileTab("b", "/ws/Root note.md"),
      fileTab("p", "/ws/p.md", true),
    ],
    closedTabs: [],
    activeTabId: "a",
    activeFilePath: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(EditorTabs)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("editor tab tooltip", () => {
  it("a truncated note tab shows its title and vault folder", () => {
    hover("a");
    expect(tip()?.textContent).toContain("Quarterly planning");
    expect(tip()?.textContent).toContain("Projects/2026");
    expect(buttonOf("a").getAttribute("aria-describedby")).toBe(tip()!.id);
  });

  it("a note at the vault root has no folder line", () => {
    hover("b");
    expect(tip()?.textContent).toBe("Root note");
  });

  it("a tab that is not truncated shows none", () => {
    truncated = false;
    hover("a");
    expect(tip()).toBeNull();
  });

  it("a pinned tab shows it even when not truncated", () => {
    truncated = false;
    hover("p");
    expect(tip()?.textContent).toContain("p");
  });

  it("no tab carries a native title", () => {
    for (const id of ["a", "b", "p"]) expect(buttonOf(id).hasAttribute("title")).toBe(false);
  });
});
