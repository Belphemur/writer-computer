// Pinned tabs: the editor store's pin/unpin/move/close rules, the Cmd+W rule, reopen, session
// persistence and opening a file that a pinned tab already shows. Tauri is faked; files are
// synthetic. Spec: SPECs/pinned-tabs-spec.md.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { invoke } from "@tauri-apps/api/core";
import {
  createLauncherTab,
  getEditorSessionSnapshot,
  useEditorStore,
  type Tab,
} from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";
import { dropIndexAmong } from "../src/components/editor-area/use-tab-drag";
import * as editorApi from "../src/hooks/editor-api";

const mockedInvoke = vi.mocked(invoke);

function fileTab(id: string, path: string, pinned = false): Tab {
  return {
    id,
    location: { kind: "file", path },
    back: [],
    forward: [],
    ...(pinned ? { pinned: true } : {}),
  };
}

/** Tabs `a`..: ids are the letters, paths `/ws/<id>.md`; `pins` lists the pinned ids in order. */
function seed(ids: string, active = 0) {
  const tabs = [...ids].map((id) => fileTab(id, `/ws/${id}.md`));
  useEditorStore.setState({
    openFiles: new Map(),
    tabs,
    closedTabs: [],
    activeTabId: tabs[active]!.id,
    activeFilePath: `/ws/${tabs[active]!.id}.md`,
  });
}

const state = () => useEditorStore.getState();
const order = () =>
  state()
    .tabs.map((t) => t.id)
    .join("");
const pinnedIds = () =>
  state()
    .tabs.filter((t) => t.pinned)
    .map((t) => t.id)
    .join("");

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_file") {
      const path = (args as { path: string }).path;
      return { path, content: `# ${path}`, modified_at: 1 };
    }
    return undefined;
  });
  useWorkspaceStore.setState({ chromeMode: "workspace", root: "/ws" });
});

describe("pin and unpin", () => {
  it("pinning moves the tab to the end of the pinned group", () => {
    seed("abcde");
    state().pinTab("d");
    expect(order()).toBe("dabce");
    state().pinTab("b");
    expect(order()).toBe("dbace");
    expect(pinnedIds()).toBe("db");
  });

  it("unpinning moves the tab to the start of the unpinned group", () => {
    seed("abcde");
    state().pinTab("a");
    state().pinTab("b");
    state().pinTab("c");
    expect(order()).toBe("abcde");
    state().unpinTab("a");
    expect(order()).toBe("bcade");
    expect(pinnedIds()).toBe("bc");
    expect(state().tabs.find((t) => t.id === "a")!.pinned).toBeFalsy();
  });

  it("keeps the active tab and its file", () => {
    seed("abc", 2);
    state().pinTab("c");
    expect(state().activeTabId).toBe("c");
    expect(state().activeFilePath).toBe("/ws/c.md");
  });

  it("is a no-op (same state reference) when nothing changes", () => {
    seed("ab");
    const before = state().tabs;
    state().unpinTab("a");
    expect(state().tabs).toBe(before);
    state().pinTab("a");
    const pinned = state().tabs;
    state().pinTab("a");
    expect(state().tabs).toBe(pinned);
    state().pinTab("missing");
    expect(state().tabs).toBe(pinned);
  });

  it("pins every kind except the new-tab page", () => {
    const launcher = createLauncherTab("l");
    const settings: Tab = { id: "s", location: { kind: "settings" }, back: [], forward: [] };
    const base = fileTab("b", "/ws/tasks.base");
    base.location = { kind: "base", path: "/ws/tasks.base" } as Tab["location"];
    const view: Tab = {
      id: "v",
      location: { kind: "plugin-view", leafId: "leaf-1", title: "Chat" },
      back: [],
      forward: [],
    };
    const pluginFile: Tab = {
      id: "p",
      location: { kind: "plugin-file", path: "/ws/d.excalidraw", viewType: "excalidraw" },
      back: [],
      forward: [],
    };
    useEditorStore.setState({
      tabs: [launcher, settings, base, view, pluginFile, fileTab("n", "/ws/n.md")],
      activeTabId: "n",
    });
    for (const id of ["l", "s", "b", "v", "p", "n"]) state().pinTab(id);
    expect(pinnedIds()).toBe("sbvpn");
    expect(order()).toBe("sbvpnl");
  });
});

describe("moveTab keeps the groups apart", () => {
  it("reorders inside the unpinned group and clamps at the pinned boundary", () => {
    seed("abcde");
    state().pinTab("a");
    state().pinTab("b");
    state().moveTab("e", 3);
    expect(order()).toBe("abced");
    state().moveTab("e", 0);
    expect(order()).toBe("abecd");
    state().moveTab("c", 99);
    expect(order()).toBe("abedc");
  });

  it("reorders inside the pinned group and clamps at its end", () => {
    seed("abcde");
    state().pinTab("a");
    state().pinTab("b");
    state().pinTab("c");
    state().moveTab("a", 2);
    expect(order()).toBe("bcade");
    state().moveTab("a", 4);
    expect(order()).toBe("bcade");
    state().moveTab("c", 0);
    expect(order()).toBe("cbade");
  });

  it("is a no-op for the same slot", () => {
    seed("abc");
    const before = state().tabs;
    state().moveTab("b", 1);
    expect(state().tabs).toBe(before);
  });

  it("the drop index counts the group's other tabs left of the pointer", () => {
    expect(dropIndexAmong([10, 50, 90], 0)).toBe(0);
    expect(dropIndexAmong([10, 50, 90], 60)).toBe(2);
    expect(dropIndexAmong([10, 50, 90], 500)).toBe(3);
    expect(dropIndexAmong([], 5)).toBe(0);
  });
});

describe("closing", () => {
  it("Close others never closes pinned tabs and lands on the kept tab", () => {
    seed("abcde", 4);
    state().pinTab("a");
    state().pinTab("b");
    state().closeOtherTabs("c");
    expect(order()).toBe("abc");
    expect(state().activeTabId).toBe("c");
  });

  it("Close others on a pinned tab closes the unpinned ones only", () => {
    seed("abcd", 3);
    state().pinTab("a");
    state().pinTab("b");
    state().closeOtherTabs("a");
    expect(order()).toBe("ab");
    expect(state().activeTabId).toBe("a");
  });

  it("Close others keeps the active tab when it is pinned", () => {
    seed("abc", 0);
    state().pinTab("a");
    state().closeOtherTabs("c");
    expect(order()).toBe("ac");
    expect(state().activeTabId).toBe("a");
  });

  it("Close all leaves exactly the pinned tabs, and no launcher is added", () => {
    seed("abcd", 3);
    state().pinTab("c");
    state().closeAllTabs();
    expect(order()).toBe("c");
    expect(state().tabs.every((t) => t.location.kind !== "launcher")).toBe(true);
    expect(state().activeTabId).toBe("c");
  });

  it("Close all with no pins leaves the usual blank tab", () => {
    seed("ab");
    state().closeAllTabs();
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]!.location.kind).toBe("launcher");
  });

  it("middle click (closeTabByUser) unpins a pinned tab and closes an unpinned one", () => {
    seed("abc");
    state().pinTab("b");
    state().closeTabByUser("b");
    expect(order()).toBe("bac");
    expect(pinnedIds()).toBe("");
    state().closeTabByUser("b");
    expect(order()).toBe("ac");
  });

  it("Cmd+W on a pinned active tab unpins it first, then closes it", () => {
    seed("abc", 1);
    state().pinTab("b");
    state().closeActiveTab();
    expect(order()).toBe("bac");
    expect(pinnedIds()).toBe("");
    expect(state().activeTabId).toBe("b");
    state().closeActiveTab();
    expect(order()).toBe("ac");
  });

  it("programmatic closes still close pinned tabs", () => {
    seed("abcd", 0);
    state().pinTab("a");
    state().pinTab("b");
    state().closeTab("a", { remember: false });
    expect(order()).toBe("bcd");
    state().closeFile("/ws/b.md");
    expect(order()).toBe("cd");
    state().pinTab("c");
    state().removePathReferences("/ws/c.md");
    expect(order()).toBe("d");
    seed("ab");
    state().pinTab("b");
    editorApi.closeTab("b");
    expect(order()).toBe("a");
    seed("ab", 1);
    state().pinTab("b");
    editorApi.closeActiveTab();
    expect(order()).toBe("a");
  });
});

describe("reopening a pinned tab", () => {
  it("comes back pinned, at the end of the pinned group at most", async () => {
    seed("abcd", 0);
    state().pinTab("a");
    state().pinTab("b");
    state().closeTab("a");
    expect(state().closedTabs.at(-1)!.tab.pinned).toBe(true);
    state().unpinTab("b");
    expect(await state().reopenClosedTab()).toBe(true);
    const reopened = state().tabs.find(
      (t) => t.location.kind === "file" && t.location.path === "/ws/a.md",
    )!;
    expect(reopened.pinned).toBe(true);
    expect(state().tabs[0]).toBe(reopened);
    expect(state().tabs.filter((t) => t.pinned)).toHaveLength(1);
  });

  it("an unpinned tab is never reopened inside the pinned group", async () => {
    seed("abc", 2);
    state().closeTab("c");
    state().pinTab("a");
    state().pinTab("b");
    await state().reopenClosedTab();
    expect(state().tabs.map((t) => !!t.pinned)).toEqual([true, true, false]);
  });
});

describe("session persistence", () => {
  it("round trips the pinned flag and order, omitting it for unpinned tabs", async () => {
    seed("abcd", 2);
    state().pinTab("c");
    state().pinTab("a");
    const snapshot = getEditorSessionSnapshot(state());
    expect(snapshot.tabs.map((t) => t.pinned)).toEqual([true, true, undefined, undefined]);
    expect(snapshot.activeIndex).toBe(0);
    expect(JSON.stringify(snapshot.tabs[2])).not.toContain("pinned");

    useEditorStore.setState({ tabs: [], openFiles: new Map(), activeTabId: null });
    await state().restoreSession(snapshot.tabs, snapshot.activeIndex);
    expect(state().tabs.map((t) => (t.location.kind === "file" ? t.location.path : "?"))).toEqual([
      "/ws/c.md",
      "/ws/a.md",
      "/ws/b.md",
      "/ws/d.md",
    ]);
    expect(state().tabs.map((t) => !!t.pinned)).toEqual([true, true, false, false]);
    expect(state().activeFilePath).toBe("/ws/c.md");
  });

  it("loads a legacy session without the field as all unpinned", async () => {
    await state().restoreSession(
      [
        { location: { kind: "file", path: "/ws/a.md" }, back: [], forward: [] },
        { location: { kind: "file", path: "/ws/b.md" }, back: [], forward: [] },
      ],
      1,
    );
    expect(state().tabs.map((t) => !!t.pinned)).toEqual([false, false]);
    expect(state().activeFilePath).toBe("/ws/b.md");
  });

  it("moves pinned tabs to the front and keeps the saved active tab", async () => {
    await state().restoreSession(
      [
        { location: { kind: "file", path: "/ws/a.md" }, back: [], forward: [] },
        { location: { kind: "file", path: "/ws/b.md" }, back: [], forward: [], pinned: true },
        { location: { kind: "file", path: "/ws/c.md" }, back: [], forward: [] },
      ],
      2,
    );
    expect(state().tabs.map((t) => t.id).length).toBe(3);
    expect(state().tabs.map((t) => !!t.pinned)).toEqual([true, false, false]);
    expect(state().activeFilePath).toBe("/ws/c.md");
  });

  it("never restores a pinned new-tab page", async () => {
    await state().restoreSession(
      [{ location: { kind: "settings" }, back: [], forward: [], pinned: true }],
      0,
    );
    expect(state().tabs[0]!.pinned).toBe(true);
    await state().restoreSession(
      [{ location: { kind: "launcher" }, back: [], forward: [], pinned: true }],
      0,
    );
    expect(state().tabs[0]!.pinned).toBeFalsy();
  });
});

describe("opening a file a pinned tab shows", () => {
  it("openFile focuses the pinned tab instead of duplicating or navigating", async () => {
    seed("abc", 2);
    state().pinTab("a");
    await state().openFile("/ws/a.md");
    expect(state().activeTabId).toBe("a");
    expect(order()).toBe("abc");
    expect(state().tabs.find((t) => t.id === "c")!.back).toEqual([]);
  });

  it("navigateToFile (a link click) focuses it too", async () => {
    seed("abc", 2);
    state().pinTab("b");
    await state().navigateToFile("/ws/b.md");
    expect(state().activeTabId).toBe("b");
    expect(order()).toBe("bac");
  });

  it("a launcher tab is left alone and the pinned tab is focused", async () => {
    seed("ab", 0);
    state().pinTab("a");
    state().openNewTab();
    const launcherId = state().activeTabId!;
    await state().openFile("/ws/a.md");
    expect(state().activeTabId).toBe("a");
    expect(state().tabs.some((t) => t.id === launcherId)).toBe(true);
  });

  it("opening another file from a pinned tab goes to a new tab after the strip", async () => {
    seed("ab", 0);
    state().pinTab("a");
    await state().navigateToFile("/ws/z.md");
    expect(state().tabs).toHaveLength(3);
    expect(state().tabs[0]!.location).toEqual({ kind: "file", path: "/ws/a.md" });
    expect(state().tabs[0]!.back).toEqual([]);
    expect(state().tabs[2]!.location).toEqual({ kind: "file", path: "/ws/z.md" });
    expect(state().activeFilePath).toBe("/ws/z.md");
  });

  it("a new tab opens after the pinned group", () => {
    seed("abc", 2);
    state().pinTab("c");
    state().openNewTab();
    expect(state().tabs.map((t) => !!t.pinned)).toEqual([true, false, false, false]);
    expect(state().tabs.at(-1)!.location.kind).toBe("launcher");
  });
});

describe("Cmd+1..9 and next/previous tab walk the whole ordered list", () => {
  let root: Root;
  function Harness() {
    useKeyboardShortcuts();
    return null;
  }
  const press = (init: KeyboardEventInit) =>
    act(
      () =>
        void window.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        ),
    );

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => act(() => root.unmount()));

  it("Cmd+N jumps by strip position, pinned first", () => {
    seed("abcd", 3);
    state().pinTab("c");
    press({ key: "1", metaKey: true });
    expect(state().activeTabId).toBe("c");
    press({ key: "4", metaKey: true });
    expect(state().activeTabId).toBe("d");
  });

  it("Ctrl+Tab cycles through pinned and unpinned tabs", () => {
    seed("abc", 2);
    state().pinTab("c");
    press({ key: "Tab", ctrlKey: true });
    expect(state().activeTabId).toBe("a");
    press({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(state().activeTabId).toBe("c");
  });

  it("Cmd+W on a pinned tab unpins it and does not close it", () => {
    seed("ab", 0);
    state().pinTab("a");
    const e = new KeyboardEvent("keydown", {
      key: "w",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(order()).toBe("ab");
    expect(pinnedIds()).toBe("");
    press({ key: "w", metaKey: true });
    expect(order()).toBe("b");
  });
});

describe("back and forward in a pinned tab", () => {
  it("keep working and keep the tab pinned", async () => {
    const pinned: Tab = {
      ...fileTab("a", "/ws/a.md", true),
      back: [{ kind: "file", path: "/ws/old.md" }],
    };
    useEditorStore.setState({
      tabs: [pinned, fileTab("b", "/ws/b.md")],
      activeTabId: "a",
      activeFilePath: "/ws/a.md",
      openFiles: new Map(),
    });
    await state().navigateBack();
    expect(state().tabs[0]!.pinned).toBe(true);
    expect(state().tabs[0]!.location).toEqual({ kind: "file", path: "/ws/old.md" });
    expect(state().tabs[0]!.forward).toHaveLength(1);
  });
});
