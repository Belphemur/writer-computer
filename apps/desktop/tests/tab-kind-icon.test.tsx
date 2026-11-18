// A page kind declares its tab icon once (`PageKindInput.icon`); the tab strip draws it for any
// kind, without naming one. Tauri is faked; synthetic data.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { pageKind } from "../src/components/editor-area/page-kinds";
import { EditorTabs } from "../src/components/editor-area/editor-tabs";
import { useEditorStore, type Tab } from "../src/stores/editor-store";

let root: Root;
let host: HTMLElement;

const tab = (id: string, location: Tab["location"]): Tab => ({
  id,
  location,
  back: [],
  forward: [],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [tab("g", { kind: "graph" }), tab("f", { kind: "file", path: "/ws/alpha.md" })],
    closedTabs: [],
    activeTabId: "f",
    activeFilePath: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("tab icon from the page kind", () => {
  it("the graph kind declares an icon and file-like kinds declare none", () => {
    expect(pageKind({ kind: "graph" }).icon).toBeDefined();
    expect(pageKind({ kind: "file", path: "/ws/a.md" }).icon).toBeUndefined();
  });

  it("draws the icon of the kind on its tab and none on a note tab", () => {
    act(() => root.render(createElement(EditorTabs)));
    const graphTab = host.querySelector('[data-tab-id="g"]')!;
    const noteTab = host.querySelector('[data-tab-id="f"]')!;
    expect(graphTab.querySelector('[data-tab-icon="graph"]')).not.toBeNull();
    expect(noteTab.querySelector("[data-tab-icon]")).toBeNull();
  });
});
