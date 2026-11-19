// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { revealPathInSidebar } from "../src/lib/reveal-in-sidebar";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const ROOT = "/synthetic-vault";
let scroller: HTMLElement;
let toggled: string[];

function mountRow(path: string, rowTop: number) {
  scroller = document.createElement("div");
  scroller.style.overflowY = "scroll";
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const row = document.createElement("div");
  row.setAttribute("data-tree-path", path);
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 20 }) as DOMRect;
  const tree = document.createElement("div");
  tree.setAttribute("data-vault-tree", "");
  tree.appendChild(row);
  scroller.appendChild(tree);
  document.body.appendChild(scroller);
  return row;
}

beforeEach(() => {
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
    expect(scroller.scrollTop).toBe(460); // row middle (510) to the scroller's middle (50)
  });

  it("does not scroll a row that is already visible", async () => {
    const path = `${ROOT}/open/note.md`;
    mountRow(path, 10);
    await revealPathInSidebar(path, { center: true });
    expect(toggled).toEqual([]);
    expect(scroller.scrollTop).toBe(0);
  });

  it("goes to the vault tree's row, never the same file's Recents row above it", async () => {
    const path = `${ROOT}/open/note.md`;
    mountRow(path, 500);
    const recents = document.createElement("div");
    recents.setAttribute("data-tree-path", path); // a Recents row: visible, but not in the vault tree
    recents.getBoundingClientRect = () => ({ top: 10, bottom: 30 }) as DOMRect;
    scroller.prepend(recents);
    await revealPathInSidebar(path, { center: true });
    expect(scroller.scrollTop).toBe(460);
  });
});
