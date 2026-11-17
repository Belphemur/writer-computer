// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { revealPathInSidebar } from "../src/lib/reveal-in-sidebar";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const ROOT = "/synthetic-vault";
let scrollIntoView: ReturnType<typeof vi.fn>;
let toggled: string[];

function mountRow(path: string, rowTop: number) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "scroll";
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const row = document.createElement("div");
  row.setAttribute("data-tree-path", path);
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 20 }) as DOMRect;
  row.scrollIntoView = scrollIntoView as unknown as typeof row.scrollIntoView;
  scroller.appendChild(row);
  document.body.appendChild(scroller);
}

beforeEach(() => {
  scrollIntoView = vi.fn();
  toggled = [];
  document.body.innerHTML = "";
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  useWorkspaceStore.setState({
    root: ROOT,
    expandedDirs: new Set([`${ROOT}/open`]),
    toggleDirectory: async (p: string) => void toggled.push(p),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("revealPathInSidebar center mode", () => {
  it("expands only collapsed ancestors (manual expansions kept) and scrolls an off-screen row centered", async () => {
    const path = `${ROOT}/open/deep/note.md`;
    mountRow(path, 500);
    await revealPathInSidebar(path, { center: true });
    expect(toggled).toEqual([`${ROOT}/open/deep`]);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
  });

  it("does not scroll a row that is already visible", async () => {
    const path = `${ROOT}/open/note.md`;
    mountRow(path, 10);
    await revealPathInSidebar(path, { center: true });
    expect(toggled).toEqual([]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
