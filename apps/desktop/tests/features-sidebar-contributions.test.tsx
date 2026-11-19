// @vitest-environment jsdom
// The sidebar and footer contribution points (SPECs/builtin-plugins-spec.md section 6.2):
// sidebarPanels, sidebarMenus (sidebar-file / -folder / -bulk), sidebarActions, statusItems. A
// test-only fixture feature contributes one of each; the host registers them only while the
// feature is on, removes them on disable, renders them inside the feature's error boundary and
// orders them.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), log: vi.fn() },
  describeError: (e: unknown) => ({ message: String(e) }),
}));
const showNativeContextMenu = vi.fn(async (_spec: unknown) => {});
vi.mock("../src/components/editor-area/editor-context-menu", () => ({
  showNativeContextMenu: (spec: unknown) => showNativeContextMenu(spec),
}));
vi.mock("../src/components/sidebar/file-browser", () => ({
  FileBrowser: () => <div data-testid="files-panel">files</div>,
}));
vi.mock("../src/hooks/use-tabs", () => ({
  useFileStats: () => ({ words: 1, characters: 1, paragraphs: 1 }),
}));

import { DocumentFooter } from "../src/components/editor-area/document-footer";
import { SidebarBody } from "../src/components/sidebar/sidebar-body";
import { buildSidebarPanels, resolveSidebarPanel } from "../src/components/sidebar/sidebar-panels";
import { showBulkContextMenu } from "../src/components/sidebar/bulk-context-menu";
import { showFileContextMenu } from "../src/components/sidebar/file-context-menu";
import { showFolderContextMenu } from "../src/components/sidebar/folder-context-menu";
import { syncBuiltinFeatures } from "../src/lib/features/builtin";
import {
  contributedMenuItems,
  menuContributions,
  withContributedItems,
} from "../src/lib/features/menus";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";
import { sidebarActionContributions, sidebarPanelContributions } from "../src/lib/features/sidebar";
import { statusItemContributions } from "../src/lib/features/status-items";
import { useFeatureHealth } from "../src/stores/feature-health-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { FILES_PANEL_ID, useUIStore } from "../src/stores/ui-store";
import type { DirEntry } from "../src/types/fs";
import { calls, fixtureSidebarFeature, manifest } from "./fixtures/features/fixture-sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
const entry = (name: string, is_dir = false) => ({ name, path: `/v/${name}`, is_dir }) as DirEntry;
// Only the fixture's entries: importing the loader also registers the shipped features.
const mine = (items: Array<{ owner: string }>) =>
  items.filter((c) => c.owner === "builtin:fixture-sidebar").length;
const counts = () => [
  mine(sidebarPanelContributions.list()),
  mine(sidebarActionContributions.list()),
  mine(statusItemContributions.list()),
  mine(menuContributions.list()),
];
const initialHealth = useFeatureHealth.getState();
const flush = () => act(async () => {});
const Body = () => (
  <SidebarBody
    renamingPath={null}
    onRenamingPathChange={() => {}}
    everythingCollapsed={false}
    onEverythingCollapsedChange={() => {}}
  />
);

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // Importing the loader registers the shipped features; the graph and tasks features contribute
  // a sidebar action of their own, which these fixture-only counts must not see.
  useSettingsStore.setState({
    settings: { "features.graph.enabled": false, "features.tasks.enabled": false },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useFeatureHealth.setState({ ...initialHealth, failures: {}, sessionOff: {}, safeMode: false });
  useUIStore.setState({ sidebarPanel: FILES_PANEL_ID });
  calls.activate = 0;
  calls.action.length = 0;
  showNativeContextMenu.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const id of host.list()) await host.unregister(id);
});

describe("registration and the kill switch", () => {
  it("registers every point only while the feature is on and removes them when it is turned off", async () => {
    const features = [
      {
        manifest: { id: manifest.id, enabledByDefault: true },
        definition: fixtureSidebarFeature(),
      },
    ];
    syncBuiltinFeatures(host, features, { "features.fixture-sidebar.enabled": false });
    expect(counts()).toEqual([0, 0, 0, 0]);

    syncBuiltinFeatures(host, features, { "features.fixture-sidebar.enabled": true });
    expect(counts()).toEqual([2, 1, 1, 3]);

    syncBuiltinFeatures(host, features, { "features.fixture-sidebar.enabled": false });
    await flush();
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it("is also removed when the feature is off for the session (failures, safe mode)", async () => {
    const features = [
      {
        manifest: { id: manifest.id, enabledByDefault: true },
        definition: fixtureSidebarFeature(),
      },
    ];
    syncBuiltinFeatures(host, features, {}, () => false);
    expect(sidebarPanelContributions.size).toBe(2);
    syncBuiltinFeatures(host, features, {}, () => true);
    await flush();
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it("rejects an id outside the feature's prefix at every new point", () => {
    const panel = { label: "x", icon: [] as never, order: 1, load: async () => () => null };
    const contributes = [
      { sidebarPanels: [{ id: "other.p", ...panel }] },
      {
        sidebarActions: [{ id: "other.a", label: "x", icon: [] as never, order: 1, run: () => {} }],
      },
      { statusItems: [{ id: "other.s", order: 1, load: async () => () => null }] },
      { menus: { "sidebar-file": [{ id: "other.m", items: () => [] }] } },
      { menus: { "sidebar-folder": [{ id: "other.m", items: () => [] }] } },
      { menus: { "sidebar-bulk": [{ id: "other.m", items: () => [] }] } },
    ];
    for (const c of contributes) {
      expect(() => defineFeature({ id: "demo", contributes: c })).toThrow(
        /must start with "demo\."/,
      );
    }
  });
});

describe("sidebar panels", () => {
  it("lists Files first, then the contributed panels by order", () => {
    host.register(fixtureSidebarFeature());
    const tabs = buildSidebarPanels(sidebarPanelContributions.list());
    expect(tabs.map((t) => t.id)).toEqual([
      FILES_PANEL_ID,
      "fixture-sidebar.panel-early",
      "fixture-sidebar.panel-late",
    ]);
    expect(resolveSidebarPanel(tabs, "fixture-sidebar.panel-late").id).toBe(
      "fixture-sidebar.panel-late",
    );
    expect(resolveSidebarPanel(tabs, "gone").id).toBe(FILES_PANEL_ID);
  });

  it("puts a divider between Files and the feature panels, and none without a feature panel", async () => {
    await act(async () => root.render(<Body />));
    expect(container.querySelector("[data-feature-divider]")).toBeNull();

    await act(async () => host.register(fixtureSidebarFeature()));
    const row = container.querySelector("[role=tablist]")!;
    expect([...row.children].map((c) => c.getAttribute("data-sidebar-panel-tab") ?? "|")).toEqual([
      FILES_PANEL_ID,
      "|",
      "fixture-sidebar.panel-early",
      "fixture-sidebar.panel-late",
    ]);
  });

  it("shows no switcher without a feature panel, then switches to the feature's panel", async () => {
    await act(async () => root.render(<Body />));
    expect(container.querySelector("[data-sidebar-header]")).toBeNull();
    expect(container.querySelector("[data-testid=files-panel]")).not.toBeNull();

    await act(async () => host.register(fixtureSidebarFeature()));
    expect(container.querySelectorAll("[data-sidebar-panel-tab]")).toHaveLength(3);

    await act(async () =>
      (
        container.querySelector(
          "[data-sidebar-panel-tab='fixture-sidebar.panel-early']",
        ) as HTMLElement
      ).click(),
    );
    await flush();
    expect(container.querySelector("[data-testid=early-panel]")).not.toBeNull();
    // Files stays mounted, hidden, so the tree keeps its state.
    expect(
      (container.querySelector("[data-testid=files-panel]")!.parentElement as HTMLElement).hidden,
    ).toBe(true);
  });

  it("falls back to Files when the selected panel's feature is turned off", async () => {
    host.register(fixtureSidebarFeature());
    useUIStore.setState({ sidebarPanel: "fixture-sidebar.panel-early" });
    await act(async () => root.render(<Body />));
    await flush();
    expect(container.querySelector("[data-testid=early-panel]")).not.toBeNull();

    await act(async () => host.unregister(manifest.id));
    expect(container.querySelector("[data-testid=early-panel]")).toBeNull();
    expect(container.querySelector("[data-sidebar-header]")).toBeNull();
    expect(
      (container.querySelector("[data-testid=files-panel]")!.parentElement as HTMLElement).hidden,
    ).toBe(false);
  });

  it("contains a throwing panel in the feature's boundary and counts the failure", async () => {
    host.register(fixtureSidebarFeature());
    useUIStore.setState({ sidebarPanel: "fixture-sidebar.panel-late" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<Body />));
    await flush();
    quiet.mockRestore();

    expect(container.querySelector("[data-feature-failed='fixture-sidebar']")).not.toBeNull();
    expect(container.querySelector("[data-sidebar-header]")).not.toBeNull(); // the sidebar survives
    expect(useFeatureHealth.getState().failures["fixture-sidebar"]?.boundary).toBe("render");
  });
});

describe("sidebar menus", () => {
  beforeEach(() => {
    // The shipped agent and excalidraw features also offer a folder item; these tests are about the fixture's.
    menuContributions.removeOwner("builtin:agent");
    menuContributions.removeOwner("builtin:excalidraw");
    menuContributions.removeOwner("builtin:icons");
    host.register(fixtureSidebarFeature());
  });

  it("hands each surface its own target and keeps surfaces apart", async () => {
    expect(await contributedMenuItems("sidebar-file", entry("a.md"))).toMatchObject([
      { text: "File a.md" },
    ]);
    expect(await contributedMenuItems("sidebar-folder", entry("docs", true))).toMatchObject([
      { text: "Folder docs" },
    ]);
    expect(await contributedMenuItems("sidebar-bulk", ["/v/a", "/v/b"])).toMatchObject([
      { text: "Bulk 2" },
    ]);
  });

  it("appends the contributed items after the core items on the file, folder and bulk menus", async () => {
    const handlers = new Proxy({}, { get: () => () => {} }) as never;
    await showFileContextMenu(handlers, entry("a.md"));
    await showFolderContextMenu(handlers, entry("docs", true));
    await showBulkContextMenu(handlers, ["/v/a", "/v/b"]);
    const tails = showNativeContextMenu.mock.calls.map(([spec]) =>
      (spec as Array<{ kind: string; text?: string }>).slice(-2),
    );
    expect(tails).toEqual([
      [{ kind: "separator" }, expect.objectContaining({ text: "File a.md" })],
      [{ kind: "separator" }, expect.objectContaining({ text: "Folder docs" })],
      [{ kind: "separator" }, expect.objectContaining({ text: "Bulk 2" })],
    ]);
  });

  it("never doubles the separator when the core menu already ends with one", () => {
    const item = (id: string) => ({ kind: "item", id, text: id, action: () => {} }) as const;
    const sep = { kind: "separator" } as const;
    expect(withContributedItems([item("a"), sep], [item("x")]).map((i) => i.kind)).toEqual([
      "item",
      "separator",
      "item",
    ]);
    expect(withContributedItems([item("a"), sep], []).map((i) => i.kind)).toEqual(["item"]);
  });

  it("leaves the core menu untouched when no feature contributes", async () => {
    await host.unregister(manifest.id);
    const handlers = new Proxy({}, { get: () => () => {} }) as never;
    await showBulkContextMenu(handlers, ["/v/a"]);
    const spec = showNativeContextMenu.mock.calls[0]![0] as Array<{ text?: string }>;
    expect(spec.map((s) => s.text)).toEqual([
      "Copy 1 relative paths",
      "Copy 1 absolute paths",
      undefined,
      "Delete 1 items",
    ]);
  });

  it("skips a throwing item, counts it, and the other contributions still show", async () => {
    host.register(
      defineFeature({
        id: "bad-menu",
        contributes: {
          menus: {
            "sidebar-file": [
              {
                id: "bad-menu.x",
                items: () => {
                  throw new Error("boom");
                },
              },
            ],
          },
        },
      }),
    );
    const items = await contributedMenuItems("sidebar-file", entry("a.md"));
    expect(items).toHaveLength(1);
    expect(useFeatureHealth.getState().failures["bad-menu"]?.boundary).toBe("menu");
    expect(useFeatureHealth.getState().failures["fixture-sidebar"]).toBeUndefined();
  });
});

describe("sidebar actions", () => {
  it("renders the toolbar button, activates the feature on click and passes its context", async () => {
    host.register(fixtureSidebarFeature());
    await act(async () => root.render(<Body />));
    const button = container.querySelector(
      "[data-sidebar-action='fixture-sidebar.action']",
    ) as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("Fixture action");
    await act(async () => button.click());
    await flush();
    expect(calls.activate).toBe(1);
    expect(calls.action.map((c) => c.id)).toEqual(["fixture-sidebar"]);
  });

  it("contains a throwing action and counts it", async () => {
    host.register(
      fixtureSidebarFeature({
        action: () => {
          throw new Error("boom");
        },
      }),
    );
    await act(async () => root.render(<Body />));
    await act(async () =>
      (container.querySelector("[data-sidebar-action]") as HTMLElement).click(),
    );
    await flush();
    expect(useFeatureHealth.getState().failures["fixture-sidebar"]?.boundary).toBe("command");
  });

  it("orders the buttons by order, then id", async () => {
    const act1 = { label: "x", icon: [] as never, run: () => {} };
    host.register(
      defineFeature({
        id: "ord",
        contributes: {
          sidebarActions: [
            { id: "ord.b", order: 5, ...act1 },
            { id: "ord.a", order: 5, ...act1 },
            { id: "ord.z", order: 1, ...act1 },
          ],
        },
      }),
    );
    host.register(fixtureSidebarFeature());
    await act(async () => root.render(<Body />));
    const ids = [...container.querySelectorAll("[data-sidebar-action]")].map((b) =>
      b.getAttribute("data-sidebar-action"),
    );
    expect(ids).toEqual(["ord.z", "fixture-sidebar.action", "ord.a", "ord.b"]);
  });
});

describe("status items", () => {
  it("renders in the document footer with the note's path, and is removed with the feature", async () => {
    host.register(fixtureSidebarFeature());
    await act(async () => root.render(<DocumentFooter filePath="/v/n.md" />));
    await flush();
    expect(container.querySelector("[data-testid=status-item]")?.textContent).toBe("/v/n.md");

    await act(async () => host.unregister(manifest.id));
    expect(container.querySelector("[data-testid=status-item]")).toBeNull();
  });

  it("separates the feature items from the core counts with a divider, only when both exist", async () => {
    await act(async () => root.render(<DocumentFooter filePath="/v/n.md" />));
    expect(container.querySelector("[data-feature-divider]")).toBeNull();

    await act(async () => host.register(fixtureSidebarFeature()));
    await flush();
    const SEL = "[data-testid=status-item]";
    const footer = container.querySelector("[data-document-footer]")!;
    const kids = [...footer.children];
    const at = kids.findIndex((k) => k.hasAttribute("data-feature-divider"));
    expect(at).toBeGreaterThan(0);
    expect(footer.querySelectorAll("[data-feature-divider]")).toHaveLength(1);
    const isItem = (k: Element) => k.matches(SEL) || k.querySelector(SEL) !== null;
    expect(kids.slice(at + 1).some(isItem)).toBe(true);
    expect(kids.slice(0, at).some(isItem)).toBe(false);
  });
});
