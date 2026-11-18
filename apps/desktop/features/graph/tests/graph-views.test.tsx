// The surfaces with the canvas mocked (jsdom has no WebGL): the list fallback opens notes from the
// keyboard and with every gesture, the truncated banner names the 10,000 cap, the local panel
// follows the active note and the config store saves through one debounced write.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
const nav = vi.hoisted(() => ({
  navigateToFile: vi.fn(),
  openFileInNewTab: vi.fn(),
  setGraphTabState: vi.fn(),
  openGraphTab: vi.fn(),
}));
vi.mock("@/hooks/editor-api", () => ({
  ...nav,
  getActiveFilePath: () => null,
}));
vi.mock("@/hooks/workspace-api", () => ({
  getWorkspaceRoot: () => "/vault",
  getWorkspaceEventIdentity: () => ({ root: "/vault", epoch: 1 }),
}));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => "macos" }));
const ipc = vi.hoisted(() => ({
  graphSlice: vi.fn(),
  graphStats: vi.fn(),
  graphConfigRead: vi.fn(async () => null),
  graphConfigWrite: vi.fn(async () => {}),
  noteFrontmatter: vi.fn(async () => ({})),
  vaultPropertyNames: vi.fn(async () => ["status"]),
  onIndexChanged: vi.fn(),
}));
vi.mock("../web/ipc", () => ipc);
vi.mock("../web/graph-canvas", () => ({
  GraphCanvas: (p: { spec: { nodes: unknown[] } }) => (
    <div data-testid="canvas" data-nodes={p.spec.nodes.length} />
  ),
  webglAvailable: () => true,
}));

vi.mock("../web/layout-worker-client", () => ({
  detectInWorker: (order: number) => ({
    result: Promise.resolve(new Int32Array(order)),
    cancel: () => {},
  }),
}));

import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { DEFAULT_CONFIG } from "../web/config";
import { openGlobalGraph } from "../web/actions";
import { NodeCard } from "../web/node-card";
import { LocalGraphPanel } from "../web/local-panel";
import { GraphView } from "../web/graph-view";
import { NodeList } from "../web/node-list";
import { applySpec, buildSpec, createModel } from "../web/model";
import { REFETCH_DEBOUNCE_MS, batchAffects } from "../web/use-graph-data";
import { SAVE_DEBOUNCE_MS, setConfigPort, useGraphConfig } from "../web/store";
import { smallSlice, WITH_PROPERTIES } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLElement;
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ipc.graphSlice.mockResolvedValue(smallSlice());
  ipc.graphStats.mockResolvedValue({ notes: 25000, edges: 1, unresolved: 0, components: 1 });
  ipc.onIndexChanged.mockResolvedValue(() => {});
  useGraphConfig.getState().reset();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
  setConfigPort(null);
});

describe("node list fallback", () => {
  const spec = () => {
    const model = createModel();
    const s = buildSpec(smallSlice(), WITH_PROPERTIES);
    applySpec(model, s);
    return s;
  };

  it("lists the visible slice by degree and opens a note on Enter or click", async () => {
    const onOpen = vi.fn();
    act(() => root.render(<NodeList nodes={spec().nodes} onOpen={onOpen} />));
    const rows = [...el.querySelectorAll("li button")];
    expect(rows.map((r) => r.querySelector("span")?.textContent)[0]).toBe("Ana");
    expect(rows).toHaveLength(4);
    act(() => rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: "People/Ana.md" }),
      "current",
    );
    act(() =>
      rows[0]!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, metaKey: true, shiftKey: true }),
      ),
    );
    expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), "new-tab-active");
    act(() => rows[1]!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), "new-tab-background");
  });
});

describe("global graph tab", () => {
  const location = { kind: "graph" as const };
  const render = () =>
    act(() => root.render(<GraphView location={location} isActive tabId="t1" />));

  it("names the cap the backend applied when the slice is truncated, and sends none", async () => {
    ipc.graphSlice.mockResolvedValue({ ...smallSlice(), truncated: true, limit: 10_000 });
    render();
    await flush();
    await flush();
    expect(ipc.graphSlice.mock.calls[0]![0]).not.toHaveProperty("limit");
    expect(el.textContent).toContain("Showing 10,000 of 25,000 notes, refine with filters");
    expect(el.querySelector("[data-testid=canvas]")?.getAttribute("data-nodes")).toBe("4");
  });

  it("toggles the Nodes list for screen readers", async () => {
    render();
    await flush();
    await flush();
    const button = [...el.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Node list",
    )!;
    act(() => button.click());
    expect(el.querySelector("[data-testid=graph-node-list]")).not.toBeNull();
  });

  it("shows a filters panel whose changes save once, debounced, to the vault file", async () => {
    render();
    await flush();
    await flush();
    const tags = [...el.querySelectorAll("label")]
      .find((l) => l.textContent === "Tags")!
      .querySelector("input")!;
    act(() => tags.click());
    act(() =>
      [...el.querySelectorAll("label")]
        .find((l) => l.textContent === "Bases")!
        .querySelector("input")!
        .click(),
    );
    expect(ipc.graphConfigWrite).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    });
    expect(ipc.graphConfigWrite).toHaveBeenCalledTimes(1);
    const saved = JSON.parse((ipc.graphConfigWrite.mock.calls as unknown as [string][])[0]![0]);
    expect(saved.global.filters).toMatchObject({ tags: true, bases: true });
    expect(saved.local).toEqual(DEFAULT_CONFIG.local);
  });
});

const byLabel = (label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label)!;

describe("global graph tab chrome", () => {
  const render = (location: object = { kind: "graph" }) =>
    act(() => root.render(<GraphView location={location as never} isActive tabId="t1" />));

  it("has one toolbar and one side panel, and no floating legend", async () => {
    render();
    await flush();
    await flush();
    expect(el.querySelector("[data-testid=graph-legend]")).toBeNull();
    expect(el.querySelectorAll("[data-testid=graph-side-panel]")).toHaveLength(1);
    const sections = [...el.querySelectorAll("[data-section]")].map((d) =>
      d.getAttribute("data-section"),
    );
    expect(sections).toEqual(["Display", "Clusters", "Filters"]);
  });

  it("lists the clusters with their size in the panel", async () => {
    render();
    await flush();
    await flush();
    const rows = [...el.querySelectorAll("[data-testid=graph-clusters] li")];
    expect(rows.map((r) => r.textContent)).toEqual(["Ana4"]);
  });

  it("saves the label mode and cluster by in the config, once, debounced", async () => {
    render();
    await flush();
    await flush();
    const selects = [
      ...el.querySelectorAll<HTMLSelectElement>("[data-testid=graph-display] select"),
    ];
    const set = (select: HTMLSelectElement, value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        setter.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    set(selects[0]!, "zoom");
    set(selects[1]!, "folder");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    });
    expect(ipc.graphConfigWrite).toHaveBeenCalledTimes(1);
    const saved = JSON.parse((ipc.graphConfigWrite.mock.calls as unknown as [string][])[0]![0]);
    expect(saved.global.display).toMatchObject({ labels: "zoom", clusterBy: "folder", depth: 2 });
  });

  it("property edges are not fetched until enabled", async () => {
    render();
    await flush();
    await flush();
    expect(ipc.graphSlice.mock.calls[0]![0].kinds).toEqual(["link", "embed"]);
    const check = [...el.querySelectorAll("label")]
      .find((l) => l.textContent === "Properties")!
      .querySelector("input")!;
    act(() => check.click());
    await flush();
    await flush();
    expect(ipc.graphSlice.mock.calls.at(-1)![0].kinds).toEqual(["link", "embed", "property"]);
  });

  it("a local tab shows the depth slider (1 to 5) and Whole vault drops the depth", async () => {
    render({ kind: "graph", center: "People/Ana.md", depth: 3 });
    await flush();
    await flush();
    const slider = el.querySelector<HTMLInputElement>("input[type=range]")!;
    expect([slider.min, slider.max, slider.value]).toEqual(["1", "5", "3"]);
    expect(ipc.graphSlice.mock.calls[0]![0]).toMatchObject({ center: "People/Ana.md", depth: 3 });
    act(() => byLabel("Whole vault").click());
    expect(nav.setGraphTabState).toHaveBeenLastCalledWith("t1", { depth: undefined });
  });

  it("the whole vault has no slider; the toggle returns to the remembered depth", async () => {
    render({ kind: "graph", center: "People/Ana.md" });
    await flush();
    await flush();
    expect(el.querySelector("input[type=range]")).toBeNull();
    act(() => byLabel("Whole vault").click());
    expect(nav.setGraphTabState).toHaveBeenLastCalledWith("t1", { depth: 2 });
  });
});

describe("opening the graph", () => {
  it("opens on the current note's local graph at depth 2, or the remembered depth", async () => {
    await openGlobalGraph("People/Ana.md");
    expect(nav.openGraphTab).toHaveBeenLastCalledWith({ center: "People/Ana.md", depth: 2 });
    useGraphConfig
      .getState()
      .update("global", (s) => ({ ...s, display: { ...s.display, depth: 4 } }));
    await openGlobalGraph("People/Ana.md");
    expect(nav.openGraphTab).toHaveBeenLastCalledWith({ center: "People/Ana.md", depth: 4 });
    await openGlobalGraph();
    expect(nav.openGraphTab).toHaveBeenLastCalledWith({});
  });
});

describe("node info card", () => {
  const ana = () => buildSpec(smallSlice(), WITH_PROPERTIES).nodes.find((n) => n.label === "Ana")!;
  const render = (pinned = true) => {
    const onUnpin = vi.fn();
    const onFocus = vi.fn();
    act(() =>
      root.render(<NodeCard node={ana()} pinned={pinned} onFocus={onFocus} onUnpin={onUnpin} />),
    );
    return { onUnpin, onFocus };
  };
  const button = (text: string) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;

  it("shows the title and folder", () => {
    render();
    expect(el.textContent).toContain("Ana");
    expect(el.textContent).toContain("People");
  });

  it("Open follows the link gestures: click, Cmd+click and middle click", () => {
    render();
    act(() => button("Open").dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(nav.navigateToFile).toHaveBeenCalledWith("/vault/People/Ana.md");
    act(() =>
      button("Open").dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0, metaKey: true }),
      ),
    );
    expect(nav.openFileInNewTab).toHaveBeenLastCalledWith("/vault/People/Ana.md", {
      activate: false,
    });
    act(() =>
      button("Open").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })),
    );
    expect(nav.openFileInNewTab).toHaveBeenCalledTimes(2);
  });

  it("New tab, Focus and Unpin do what they say; Unpin only while pinned", () => {
    const { onFocus, onUnpin } = render();
    act(() => button("New tab").click());
    expect(nav.openFileInNewTab).toHaveBeenLastCalledWith("/vault/People/Ana.md", {
      activate: true,
    });
    act(() => button("Focus").click());
    expect(onFocus).toHaveBeenCalled();
    act(() => button("Unpin").click());
    expect(onUnpin).toHaveBeenCalled();
    render(false);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Unpin")).toBe(false);
  });
});

describe("local graph panel", () => {
  it("shows an empty state without an active note and follows the active note at the remembered depth, 2 by default", async () => {
    useWorkspaceStore.setState({ root: "/vault" });
    useEditorStore.setState({ activeFilePath: null });
    act(() => root.render(<LocalGraphPanel />));
    expect(el.textContent).toContain("Open a note to see its links");

    act(() => useEditorStore.setState({ activeFilePath: "/vault/People/Ana.md" }));
    await flush();
    await flush();
    expect(ipc.graphSlice).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: "People/Ana.md", depth: 2 }),
    );
    act(() =>
      [...el.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Panel")!
        .click(),
    );
    const slider = el.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(slider.value).toBe("2");
    expect(slider.max).toBe("5");
    expect(el.querySelector("[aria-label='Open in graph tab']")).not.toBeNull();
  });
});

describe("live updates", () => {
  it("refetches only for batches that concern the slice", () => {
    expect(batchAffects({ full: true, paths: [] }, new Set(), true)).toBe(true);
    expect(batchAffects({ full: false, paths: ["x.png"] }, new Set(["a.md"]), true)).toBe(false);
    expect(batchAffects({ full: false, paths: ["a.md"] }, new Set(["a.md"]), true)).toBe(true);
    expect(batchAffects({ full: false, paths: ["new.md"] }, new Set(), false)).toBe(true);
  });

  it("an index change refetches once after the debounce", async () => {
    let fire: (b: { full: boolean; paths: string[] }) => void = () => {};
    ipc.onIndexChanged.mockImplementation(async (h) => {
      fire = h;
      return () => {};
    });
    act(() => root.render(<GraphView location={{ kind: "graph" }} isActive tabId="t1" />));
    await flush();
    await flush();
    const before = ipc.graphSlice.mock.calls.length;
    fire({ full: false, paths: ["People/Ana.md"] });
    fire({ full: false, paths: ["People/Ben.md"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS + 10);
    });
    expect(ipc.graphSlice.mock.calls.length).toBe(before + 1);
  });
});
