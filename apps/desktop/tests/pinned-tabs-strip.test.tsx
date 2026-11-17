// The tab strip with pinned tabs: pinned rendering (no close button, tooltip, glyph), middle click,
// the right-click menu for every tab kind and its disabled states. Tauri is faked; synthetic data.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const shown = vi.hoisted(() => ({ spec: [] as unknown[] }));
vi.mock("../src/components/editor-area/editor-context-menu", async (importActual) => ({
  ...(await importActual<typeof import("../src/components/editor-area/editor-context-menu")>()),
  showNativeContextMenu: vi.fn(async (spec: unknown[]) => {
    shown.spec = spec;
  }),
}));

import { EditorTabs } from "../src/components/editor-area/editor-tabs";
import { useEditorStore, type Tab } from "../src/stores/editor-store";

let root: Root;
let host: HTMLElement;

const fileTab = (id: string, path: string, pinned = false): Tab => ({
  id,
  location: { kind: "file", path },
  back: [],
  forward: [],
  ...(pinned ? { pinned: true } : {}),
});

function seed(tabs: Tab[], activeTabId = tabs[0]!.id) {
  useEditorStore.setState({
    openFiles: new Map(),
    tabs,
    closedTabs: [],
    activeTabId,
    activeFilePath: null,
  });
}

const state = () => useEditorStore.getState();
const tabEl = (id: string) => host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
const buttonOf = (id: string) => tabEl(id).querySelector<HTMLElement>("[role=button]")!;
const ids = (spec: unknown[]) =>
  (spec as Array<{ kind: string; id?: string }>).flatMap((e) => (e.kind === "item" ? [e.id] : []));
const entry = (id: string) =>
  (shown.spec as Array<{ id?: string; enabled?: boolean; action: () => void }>).find(
    (e) => e.id === id,
  )!;

async function rightClick(id: string) {
  await act(async () => {
    buttonOf(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  shown.spec = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("pinned rendering", () => {
  beforeEach(() => {
    seed([
      fileTab("a", "/ws/alpha.md", true),
      fileTab("b", "/ws/beta.md"),
      fileTab("c", "/ws/c.md"),
    ]);
    act(() => root.render(createElement(EditorTabs)));
  });

  it("shows a pin glyph and the full title as tooltip, and no close button, on a pinned tab", () => {
    expect(tabEl("a").dataset.tabPinned).toBe("true");
    expect(tabEl("a").querySelector("[data-pin-glyph]")).not.toBeNull();
    expect(buttonOf("a").getAttribute("title")).toBe("alpha (pinned)");
    expect(tabEl("a").querySelector("button")).toBeNull();
    expect(tabEl("b").querySelector("button[aria-label^='Close']")).not.toBeNull();
    expect(tabEl("b").querySelector("[data-pin-glyph]")).toBeNull();
  });

  it("draws one divider after the pinned group only", () => {
    expect(host.querySelectorAll("[data-pinned-divider]")).toHaveLength(1);
    expect(tabEl("a").querySelector("[data-pinned-divider]")).not.toBeNull();
    act(() => state().unpinTab("a"));
    expect(host.querySelectorAll("[data-pinned-divider]")).toHaveLength(0);
  });

  it("middle click on a pinned tab unpins it and does not close it", () => {
    act(() => {
      buttonOf("a").dispatchEvent(
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
    });
    expect(
      state()
        .tabs.map((t) => t.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(state().tabs.find((t) => t.id === "a")!.pinned).toBe(false);
    expect(tabEl("a").querySelector("button")).not.toBeNull();
  });

  it("middle click on an unpinned tab closes it", () => {
    act(() => {
      buttonOf("b").dispatchEvent(
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
    });
    expect(state().tabs.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("clicking a pinned tab selects it", () => {
    act(() => buttonOf("a").click());
    expect(state().activeTabId).toBe("a");
  });
});

describe("tab context menu", () => {
  it("offers Pin tab first, on a note, and pinning moves it into the pinned group", async () => {
    seed([fileTab("a", "/ws/a.md"), fileTab("b", "/ws/b.md"), fileTab("c", "/ws/c.md")]);
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("c");
    expect(ids(shown.spec)[0]).toBe("pin");
    expect(ids(shown.spec)).toContain("copy-path");
    act(() => entry("pin").action());
    expect(state().tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(state().tabs[0]!.pinned).toBe(true);
  });

  it("offers Unpin tab on a pinned tab, with Close disabled", async () => {
    seed([fileTab("a", "/ws/a.md", true), fileTab("b", "/ws/b.md")]);
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("a");
    expect(ids(shown.spec)[0]).toBe("unpin");
    expect(entry("close").enabled).toBe(false);
    act(() => entry("unpin").action());
    expect(state().tabs.find((t) => t.id === "a")!.pinned).toBe(false);
  });

  it("opens on Settings and plugin view tabs too, without file-only items", async () => {
    seed([
      { id: "s", location: { kind: "settings" }, back: [], forward: [] },
      {
        id: "v",
        location: { kind: "plugin-view", leafId: "leaf-1", title: "Chat" },
        back: [],
        forward: [],
      },
      {
        id: "p",
        location: { kind: "plugin-file", path: "/ws/d.excalidraw", viewType: "excalidraw" },
        back: [],
        forward: [],
      },
    ]);
    act(() => root.render(createElement(EditorTabs)));
    for (const id of ["s", "v"]) {
      shown.spec = [];
      await rightClick(id);
      expect(ids(shown.spec)).toEqual(["pin", "close", "close-others", "close-all"]);
    }
    shown.spec = [];
    await rightClick("p");
    expect(ids(shown.spec)).toEqual([
      "pin",
      "close",
      "close-others",
      "close-all",
      "reveal-in-sidebar",
      "copy-path",
    ]);
  });

  it("the new-tab page has a menu without a pin item", async () => {
    seed([{ id: "l", location: { kind: "launcher" }, back: [], forward: [] }]);
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("l");
    expect(ids(shown.spec)).toEqual(["close", "close-others", "close-all"]);
  });

  it("disables Close others when only pinned tabs remain besides the target", async () => {
    seed([
      fileTab("a", "/ws/a.md", true),
      fileTab("b", "/ws/b.md", true),
      fileTab("c", "/ws/c.md"),
    ]);
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("c");
    expect(entry("close-others").enabled).toBe(false);
    expect(entry("close-all").enabled).toBe(true);
    await rightClick("a");
    expect(entry("close-others").enabled).toBe(true);
  });

  it("disables Close all when every tab is pinned", async () => {
    seed([fileTab("a", "/ws/a.md", true), fileTab("b", "/ws/b.md", true)]);
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("a");
    expect(entry("close-all").enabled).toBe(false);
    expect(entry("close-others").enabled).toBe(false);
  });

  it("Close others and Close all leave the pinned tabs", async () => {
    seed(
      [
        fileTab("a", "/ws/a.md", true),
        fileTab("b", "/ws/b.md"),
        fileTab("c", "/ws/c.md"),
        fileTab("d", "/ws/d.md"),
      ],
      "d",
    );
    act(() => root.render(createElement(EditorTabs)));
    await rightClick("c");
    act(() => entry("close-others").action());
    expect(state().tabs.map((t) => t.id)).toEqual(["a", "c"]);
    await rightClick("c");
    act(() => entry("close-all").action());
    expect(state().tabs.map((t) => t.id)).toEqual(["a"]);
  });
});
