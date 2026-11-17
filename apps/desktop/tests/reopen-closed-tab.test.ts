// Cmd+Shift+T: the editor store's reopen stack (closed tabs, newest last, capped) and the
// keyboard shortcut. Tauri is faked; files are synthetic.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { invoke } from "@tauri-apps/api/core";
import { MAX_CLOSED_TABS, useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";

const mockedInvoke = vi.mocked(invoke);
let missing = new Set<string>();

function fileTab(id: string, path: string) {
  return { id, location: { kind: "file" as const, path }, back: [], forward: [] };
}

function seed(paths: string[], active = 0) {
  const tabs = paths.map((p, i) => fileTab(`t${i}`, p));
  useEditorStore.setState({
    openFiles: new Map(),
    tabs,
    closedTabs: [],
    activeTabId: tabs[active]!.id,
    activeFilePath: paths[active]!,
  });
}

const state = () => useEditorStore.getState();
const paths = () =>
  state().tabs.map((t) => (t.location.kind === "file" ? t.location.path : t.location.kind));

beforeEach(() => {
  missing = new Set();
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_file") {
      const path = (args as { path: string }).path;
      if (missing.has(path)) throw new Error("gone");
      return { path, content: `# ${path}`, modified_at: 1 };
    }
    return undefined;
  });
  useWorkspaceStore.setState({ chromeMode: "workspace", root: "/ws" });
});

describe("reopenClosedTab", () => {
  it("puts a closed tab back at its index and activates it", async () => {
    seed(["/ws/a.md", "/ws/b.md", "/ws/c.md"], 1);
    state().closeTab("t1");
    expect(paths()).toEqual(["/ws/a.md", "/ws/c.md"]);
    expect(await state().reopenClosedTab()).toBe(true);
    expect(paths()).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    const active = state().tabs[1]!;
    expect(state().activeTabId).toBe(active.id);
    expect(state().activeFilePath).toBe("/ws/b.md");
    expect(state().closedTabs).toHaveLength(0);
  });

  it("keeps the tab's back and forward history", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    const history = {
      back: [{ kind: "file" as const, path: "/ws/x.md" }],
      forward: [{ kind: "file" as const, path: "/ws/y.md" }],
    };
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === "t0" ? { ...t, ...history } : t)),
    }));
    state().closeTab("t0");
    await state().reopenClosedTab();
    expect(state().tabs[0]!.back).toEqual(history.back);
    expect(state().tabs[0]!.forward).toEqual(history.forward);
  });

  it("walks back newest to oldest and then does nothing", async () => {
    seed(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    state().closeTab("t0");
    state().closeTab("t1");
    state().closeTab("t2");
    expect(paths()).toEqual(["launcher"]);
    await state().reopenClosedTab();
    expect(paths()).toEqual(["/ws/c.md"]);
    await state().reopenClosedTab();
    expect(paths()).toEqual(["/ws/b.md", "/ws/c.md"]);
    await state().reopenClosedTab();
    expect(paths()).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    expect(await state().reopenClosedTab()).toBe(false);
    expect(paths()).toHaveLength(3);
  });

  it("remembers only the last 25 closed tabs", async () => {
    const all = Array.from({ length: 30 }, (_, i) => `/ws/n${i}.md`);
    seed(all);
    for (let i = 0; i < 30; i++) state().closeTab(`t${i}`);
    expect(state().closedTabs).toHaveLength(MAX_CLOSED_TABS);
    let reopened = 0;
    while (await state().reopenClosedTab()) reopened++;
    expect(reopened).toBe(25);
    // The five oldest (n0..n4) are gone.
    expect(paths()).not.toContain("/ws/n4.md");
    expect(paths()).toContain("/ws/n5.md");
  });

  it("does not remember launcher tabs or tabs closed with remember: false", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().openNewTab();
    state().closeTab(state().activeTabId!);
    state().closeTab("t0", { remember: false });
    expect(state().closedTabs).toHaveLength(0);
    expect(await state().reopenClosedTab()).toBe(false);
  });

  it("does not remember plugin-view tabs", () => {
    seed(["/ws/a.md"]);
    useEditorStore.setState((s) => ({
      tabs: [
        ...s.tabs,
        {
          id: "p",
          location: { kind: "plugin-view", leafId: "l", title: "Chat" },
          back: [],
          forward: [],
        },
      ],
    }));
    state().closeTab("p");
    expect(state().closedTabs).toHaveLength(0);
  });

  it("remembers settings tabs", async () => {
    seed(["/ws/a.md"]);
    state().openOrFocus(
      (t) => t.location.kind === "settings",
      () => ({ id: "s", location: { kind: "settings" } as never, back: [], forward: [] }),
    );
    const id = state().activeTabId!;
    state().closeTab(id);
    await state().reopenClosedTab();
    expect(paths()).toEqual(["/ws/a.md", "settings"]);
  });

  it("skips entries whose file is gone and reopens the next older one", async () => {
    seed(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    state().closeTab("t0");
    state().closeTab("t1");
    missing.add("/ws/b.md");
    expect(await state().reopenClosedTab()).toBe(true);
    expect(paths()).toContain("/ws/a.md");
    expect(paths()).not.toContain("/ws/b.md");
    expect(state().closedTabs).toHaveLength(0);
  });

  it("returns false and drops everything when every closed file is gone", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    missing.add("/ws/a.md");
    expect(await state().reopenClosedTab()).toBe(false);
    expect(state().closedTabs).toHaveLength(0);
    expect(paths()).toEqual(["/ws/b.md"]);
  });

  it("treats each closure of the same file as its own entry", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    await state().reopenClosedTab();
    state().closeTab(state().tabs[0]!.id);
    await state().reopenClosedTab();
    state().closeTab(state().tabs[0]!.id);
    expect(state().closedTabs).toHaveLength(1);
    // Close the same file in two separate tabs: two entries, two reopens.
    await state().reopenClosedTab();
    await state().openFileInNewTab("/ws/a.md");
    state().closeTab(state().tabs[0]!.id);
    state().closeTab(state().tabs[state().tabs.length - 1]!.id);
    expect(state().closedTabs).toHaveLength(2);
    await state().reopenClosedTab();
    await state().reopenClosedTab();
    expect(paths().filter((p) => p === "/ws/a.md")).toHaveLength(2);
  });

  it("replaces a lone launcher tab", async () => {
    seed(["/ws/a.md"]);
    state().closeTab("t0");
    expect(paths()).toEqual(["launcher"]);
    await state().reopenClosedTab();
    expect(paths()).toEqual(["/ws/a.md"]);
  });

  it("gives the reopened tab a fresh id", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    await state().reopenClosedTab();
    expect(state().tabs.map((t) => t.id)).not.toContain("t0");
  });

  it("restores cursor and scroll the file had when it closed", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    useEditorStore.setState({
      openFiles: new Map([["/ws/a.md", { path: "/ws/a.md", cursorPos: 0, scrollPos: 0 } as never]]),
    });
    state().updateCursorPos("/ws/a.md", 7);
    state().updateScrollPos("/ws/a.md", 120);
    state().closeTab("t0");
    expect(state().openFiles.has("/ws/a.md")).toBe(false);
    await state().reopenClosedTab();
    expect(state().openFiles.get("/ws/a.md")).toMatchObject({ cursorPos: 7, scrollPos: 120 });
  });

  it("follows a renamed file and drops a deleted one", async () => {
    seed(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    state().closeTab("t0");
    state().closeTab("t1");
    state().renameOpenFile("/ws/a.md", "/ws/a2.md");
    state().removePathReferences("/ws/b.md");
    expect(state().closedTabs.map((e) => e.tab.location)).toEqual([
      { kind: "file", path: "/ws/a2.md" },
    ]);
    await state().reopenClosedTab();
    expect(paths()).toContain("/ws/a2.md");
  });

  it("follows a folder rename and drops entries under a deleted folder", () => {
    seed(["/ws/d/a.md", "/ws/e/b.md", "/ws/c.md"]);
    state().closeTab("t0");
    state().closeTab("t1");
    state().rewritePathPrefix("/ws/d", "/ws/d2");
    state().removePathsWithPrefix("/ws/e");
    expect(state().closedTabs.map((e) => e.tab.location)).toEqual([
      { kind: "file", path: "/ws/d2/a.md" },
    ]);
  });

  it("does not remember tabs removed because their file was deleted", () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().removePathReferences("/ws/a.md");
    expect(state().closedTabs).toHaveLength(0);
  });
});

describe("Cmd+Shift+T shortcut", () => {
  let root: Root;
  function Harness() {
    useKeyboardShortcuts();
    return null;
  }
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => void window.dispatchEvent(e));
    return e;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => act(() => root.unmount()));

  it("reopens once and does not open a new tab", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    const before = state().tabs.length;
    const e = press({ key: "T", metaKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(state().tabs).toHaveLength(before + 1));
    expect(paths()).toEqual(["/ws/a.md", "/ws/b.md"]);
  });

  it("also matches the physical T key on a non-Latin layout, not Cmd+T", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    press({ key: "Е", code: "KeyT", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(state().tabs).toHaveLength(2));
    const plain = press({ key: "t", metaKey: true });
    expect(plain.defaultPrevented).toBe(true);
    expect(paths()).toContain("launcher");
  });

  it("is ignored in compact-file mode", async () => {
    seed(["/ws/a.md", "/ws/b.md"]);
    state().closeTab("t0");
    useWorkspaceStore.setState({ chromeMode: "compact-file", root: null });
    press({ key: "T", metaKey: true, shiftKey: true });
    await Promise.resolve();
    expect(state().closedTabs).toHaveLength(1);
    expect(state().tabs).toHaveLength(1);
  });
});
