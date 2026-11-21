// `openLocationTab`: the one way a keyed page kind (the git History tab, an agent chat's Session
// changes) is opened, foreground or background (middle click, Cmd+click). A new kind declares its
// `tabKey` in the page-kind registry and needs nothing here.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { invoke } from "@tauri-apps/api/core";
import { openFileInNewTab, openGitHistoryTab, openLocationTab } from "../src/hooks/editor-api";
import { useEditorStore } from "../src/stores/editor-store";

const state = () => useEditorStore.getState();
const locations = () => state().tabs.map((t) => t.location);

function seed(active = 0) {
  const tabs = ["/v/a.md", "/v/b.md"].map((path, i) => ({
    id: `t${i}`,
    location: { kind: "file" as const, path },
    back: [],
    forward: [],
  }));
  useEditorStore.setState({
    openFiles: new Map(),
    tabs,
    closedTabs: [],
    activeTabId: tabs[active]!.id,
    activeFilePath: tabs[active]!.location.path,
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_file") {
      const path = (args as { path: string }).path;
      return { path, content: `# ${path}`, modified_at: 1 };
    }
    return undefined;
  });
});

describe("openLocationTab", () => {
  it("opens a new tab behind the active one and keeps the active tab", () => {
    seed();
    openGitHistoryTab({ path: "/v/a.md" }, { activate: false });
    expect(locations().at(-1)).toEqual({ kind: "git-history", path: "/v/a.md" });
    expect(state().activeTabId).toBe("t0");
    expect(state().activeFilePath).toBe("/v/a.md");
  });

  it("a background open does not replace a launcher tab", () => {
    useEditorStore.setState({
      tabs: [{ id: "l", location: { kind: "launcher" }, back: [], forward: [] }],
      activeTabId: "l",
      activeFilePath: null,
    });
    openGitHistoryTab({ path: "/v/a.md" }, { activate: false });
    expect(locations().map((l) => l.kind)).toEqual(["launcher", "git-history"]);
    expect(state().activeTabId).toBe("l");
  });

  it("a foreground open adds and activates it, and replaces a launcher tab", () => {
    useEditorStore.setState({
      tabs: [{ id: "l", location: { kind: "launcher" }, back: [], forward: [] }],
      activeTabId: "l",
      activeFilePath: null,
    });
    openGitHistoryTab({ path: "/v/a.md" });
    expect(locations()).toEqual([{ kind: "git-history", path: "/v/a.md" }]);
    expect(state().activeTabId).toBe("l");
  });

  it("one tab per file and per version: a second open re-targets, and only a foreground open focuses", () => {
    seed();
    openGitHistoryTab({ path: "/v/a.md", rev: "r1" }, { activate: false });
    const historyId = state().tabs.at(-1)!.id;
    openGitHistoryTab({ path: "/v/a.md", rev: "r2" }, { activate: false });
    expect(state().tabs).toHaveLength(3);
    expect(locations().at(-1)).toEqual({ kind: "git-history", path: "/v/a.md", rev: "r2" });
    expect(state().activeTabId).toBe("t0");
    openGitHistoryTab({ path: "/v/a.md", rev: "r3" });
    expect(state().activeTabId).toBe(historyId);
    // a version view of the same file is another tab, one per version
    openGitHistoryTab({ path: "/v/a.md", rev: "r3", version: true }, { activate: false });
    openGitHistoryTab({ path: "/v/a.md", rev: "r4", version: true }, { activate: false });
    expect(state().tabs).toHaveLength(5);
    openGitHistoryTab({ path: "/v/a.md", rev: "r3", version: true }, { activate: false });
    expect(state().tabs).toHaveLength(5);
  });

  it("a kind without a tab key opens a new tab each time", () => {
    seed();
    openLocationTab({ kind: "file", path: "/v/c.md" }, { activate: false });
    openLocationTab({ kind: "file", path: "/v/c.md" }, { activate: false });
    expect(state().tabs).toHaveLength(4);
  });

  it("a note still opens in the background through the same store", async () => {
    seed();
    await openFileInNewTab("/v/c.md", { activate: false });
    expect(locations().at(-1)).toEqual({ kind: "file", path: "/v/c.md" });
    expect(state().activeTabId).toBe("t0");
  });
});
