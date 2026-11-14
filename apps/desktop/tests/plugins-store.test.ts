// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../src/hooks/workspace-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hooks/workspace-api")>()),
  getWorkspaceRoot: () => "/ws",
}));

import { Facet } from "@codemirror/state";
import { useEditorStore } from "../src/stores/editor-store";
import { MarkdownView } from "../src/lib/obsidian-host/api/views";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";
import { getPluginEditorExtensions } from "../src/lib/obsidian-host/editor-bridge";
import { planReconcile, usePluginsStore, type PluginsDeps } from "../src/stores/plugins-store";

type Factory = (module: { exports: any }, exports: any, require: (n: string) => any) => void;
const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

const marker = Facet.define<number>();
const EXTENSION = marker.of(1);

const plugin: Factory = (module, _e, require) => {
  const { Plugin, ItemView } = require("obsidian");
  module.exports = class extends Plugin {
    async onload() {
      this.addCommand({ id: "hello", name: "Hello", callback: () => {} });
      this.addCommand({ id: "never", name: "Never", checkCallback: () => false });
      this.addRibbonIcon("star", "Star", () => {});
      this.addStatusBarItem().setText?.("status");
      this.registerEditorExtension(EXTENSION);
      this.registerView("test-view", (leaf: any) => {
        class TestView extends ItemView {
          constructor(l: any) {
            super(l);
          }
          getViewType() {
            return "test-view";
          }
          getDisplayText() {
            return "Test";
          }
        }
        return new TestView(leaf);
      });
    }
  };
};

function loaderFor(scripts: Record<string, Factory>, requested: string[]): ScriptLoader {
  return async (url) => {
    const id = decodeURIComponent(url.split("/")[3]);
    requested.push(id);
    const s = scripts[id];
    if (!s) throw new Error("main.js refused or missing");
    g.__writerPluginDefine(id, (module: any, exports: any, require: any) =>
      s(module, exports, require),
    );
  };
}

function setup(init: { trusted: boolean }) {
  const ipc = new FakeHostIpc({
    trusted: init.trusted,
    enabled: ["p"],
    plugins: [{ id: "p", name: "Plug" }],
  });
  const requested: string[] = [];
  const hosts: PluginHost[] = [];
  const deps: PluginsDeps = {
    createHost: async (_root, _name, bridge) => {
      const host = new PluginHost({
        ipc,
        io: createMemoryVaultIo({ "a.md": "# A" }),
        bridge,
        loadScript: loaderFor({ p: plugin }, requested),
        styles: { add: () => () => {} },
      });
      hosts.push(host);
      return host;
    },
  };
  return { ipc, requested, hosts, deps };
}

beforeEach(async () => {
  await usePluginsStore.getState().detach();
});
afterEach(async () => {
  await usePluginsStore.getState().detach();
});

describe("plugins store boot", () => {
  it("does not load anything in a restricted vault, but lists installed plugins", async () => {
    const t = setup({ trusted: false });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const s = usePluginsStore.getState();
    expect(t.requested).toEqual([]);
    expect(s.snapshot?.trusted).toBe(false);
    expect(s.snapshot?.booted).toBe(false);
    expect(s.snapshot?.installed.map((p: { id: string }) => p.id)).toEqual(["p"]);
    expect(s.bootError).toBeNull();
  });

  it("boots a trusted vault without any seal step, mirrors registries and marks layout ready", async () => {
    const order: string[] = [];
    const t = setup({ trusted: true });
    const origLoad = t.deps.createHost!;
    t.deps.createHost = async (...a) => {
      const host = await origLoad(...a);
      host.subscribe(() => {
        if (host.getStatus("p").state === "enabled" && !order.includes("enabled"))
          order.push("enabled");
      });
      return host;
    };
    await usePluginsStore.getState().attach("/ws", t.deps);
    const s = usePluginsStore.getState();
    expect(order).toEqual(["enabled"]);
    expect(s.snapshot?.status.p).toEqual({ state: "enabled" });
    expect(s.commands.map((c) => c.id)).toContain("p:hello");
    expect(s.ribbon).toHaveLength(1);
    expect(s.statusItems).toHaveLength(1);
    expect(t.hosts[0].app.workspace.layoutReady).toBe(true);
    expect(getPluginEditorExtensions()).toEqual([EXTENSION]);
  });

  it("returns to a fully idle state on detach", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    await usePluginsStore.getState().detach();
    const s = usePluginsStore.getState();
    expect(s.snapshot).toBeNull();
    expect(s.root).toBeNull();
    expect(s.commands).toEqual([]);
    expect(getPluginEditorExtensions()).toEqual([]);
  });

  it("a superseded attach never leaves two live hosts", async () => {
    const a = setup({ trusted: true });
    const b = setup({ trusted: true });
    const first = usePluginsStore.getState().attach("/a", a.deps);
    const second = usePluginsStore.getState().attach("/b", b.deps);
    await Promise.all([first, second]);
    expect(usePluginsStore.getState().root).toBe("/b");
    expect(b.hosts).toHaveLength(1);
    expect(a.hosts.length === 0 || a.requested.length === 0).toBe(true);
    expect(usePluginsStore.getState().commands.map((c) => c.id)).toContain("p:hello");
  });
});

describe("plugins store actions", () => {
  it("setTrusted loads enabled plugins and revoking unloads them", async () => {
    const t = setup({ trusted: false });
    await usePluginsStore.getState().attach("/ws", t.deps);
    await usePluginsStore.getState().setTrusted(true);
    expect(usePluginsStore.getState().snapshot?.status.p.state).toBe("enabled");
    await usePluginsStore.getState().setTrusted(false);
    const s = usePluginsStore.getState();
    expect(s.snapshot?.status.p.state).toBe("disabled");
    expect(s.commands).toEqual([]);
    expect(getPluginEditorExtensions()).toEqual([]);
  });

  it("setEnabled toggles one plugin and persists through the backend", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    await usePluginsStore.getState().setEnabled("p", false);
    expect(t.ipc.enabled.has("p")).toBe(false);
    expect(usePluginsStore.getState().commands).toEqual([]);
    await usePluginsStore.getState().setEnabled("p", true);
    expect(t.ipc.enabled.has("p")).toBe(true);
    expect(usePluginsStore.getState().commands.length).toBeGreaterThan(0);
  });

  it("reports an action error instead of throwing when enabling in restricted mode", async () => {
    const t = setup({ trusted: false });
    await usePluginsStore.getState().attach("/ws", t.deps);
    await usePluginsStore.getState().setEnabled("p", true);
    expect(usePluginsStore.getState().actionError).toMatch(/restricted mode/);
  });

  it("reports an error when there is no workspace", async () => {
    await usePluginsStore.getState().setEnabled("p", true);
    expect(usePluginsStore.getState().actionError).toMatch(/no workspace is open/);
  });

  it("shows a revealed leaf in the pane and closes it when the leaf is detached", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const { workspace } = t.hosts[0].app;
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: "test-view" });
    expect(usePluginsStore.getState().leaves).toEqual([leaf]);
    expect(usePluginsStore.getState().isPaneOpen).toBe(false);
    await workspace.revealLeaf(leaf);
    expect(usePluginsStore.getState().isPaneOpen).toBe(true);
    expect(usePluginsStore.getState().activeLeaf).toBe(leaf);
    leaf.detach();
    expect(usePluginsStore.getState().leaves).toEqual([]);
    expect(usePluginsStore.getState().isPaneOpen).toBe(false);
  });

  it("shows a main-area leaf as a real editor tab, not in the side pane", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const { workspace } = t.hosts[0].app;
    const leaf = workspace.getLeaf(true);
    expect(useEditorStore.getState().tabs.some((x) => x.location.kind === "plugin-view")).toBe(
      false,
    );
    await leaf.setViewState({ type: "test-view", active: true });
    const s = usePluginsStore.getState();
    expect(s.leaves).toEqual([]);
    expect(s.isPaneOpen).toBe(false);
    expect(s.mainLeaves).toEqual([leaf]);
    const editor = useEditorStore.getState();
    const tab = editor.tabs.find((x) => x.location.kind === "plugin-view");
    expect(tab?.location).toEqual({ kind: "plugin-view", leafId: leaf.id, title: "Test" });
    expect(editor.activeTabId).toBe(tab?.id);
    expect(workspace.activeLeaf).toBe(leaf);

    // Closing the tab detaches the leaf (the view's onClose runs).
    const onClose = vi.spyOn(leaf.view, "onClose");
    editor.closeTab(tab!.id);
    await leaf.settled();
    expect(leaf.detached).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(usePluginsStore.getState().mainLeaves).toEqual([]);
  });

  it("detaching a main-area leaf closes its tab", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const leaf = t.hosts[0].app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "test-view" });
    expect(useEditorStore.getState().tabs.some((x) => x.location.kind === "plugin-view")).toBe(
      true,
    );
    leaf.detach();
    expect(useEditorStore.getState().tabs.some((x) => x.location.kind === "plugin-view")).toBe(
      false,
    );
  });

  it("emits active-note events from Writer's own navigation (single subscription)", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const { workspace } = t.hosts[0].app;
    const seen: string[] = [];
    workspace.on("file-open", (f) => seen.push(`open:${f?.path ?? null}`));
    workspace.on("active-leaf-change", (l) =>
      seen.push(
        l?.view instanceof MarkdownView
          ? `leaf:${l.view.file?.path}`
          : `leaf:${l ? "other" : "null"}`,
      ),
    );
    useEditorStore.setState({
      tabs: [{ id: "t1", location: { kind: "file", path: "/ws/a.md" }, back: [], forward: [] }],
      activeTabId: "t1",
      activeFilePath: "/ws/a.md",
    });
    await vi.waitFor(() => expect(workspace.getActiveFile()?.path).toBe("a.md"));
    await vi.waitFor(() => expect(seen).toContain("leaf:a.md"));
    expect(seen.filter((x) => x === "open:a.md")).toHaveLength(1);
    useEditorStore.setState({ tabs: [], activeTabId: null, activeFilePath: null });
    await vi.waitFor(() => expect(seen).toContain("open:null"));
    expect(workspace.getActiveFile()).toBeNull();
    expect(seen.at(-1)).toBe("leaf:null");
  });

  it("clamps the pane width", () => {
    usePluginsStore.getState().setPaneWidth(10);
    expect(usePluginsStore.getState().paneWidth).toBe(280);
    usePluginsStore.getState().setPaneWidth(9999);
    expect(usePluginsStore.getState().paneWidth).toBe(640);
  });

  it("forwards watcher events as vault-relative paths, only once booted", async () => {
    const t = setup({ trusted: true });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const { vault } = t.hosts[0].app;
    const spy = vi.spyOn(vault, "notifyExternal").mockResolvedValue();
    await usePluginsStore.getState().notifyExternal("modify", "/ws/notes/a.md");
    await usePluginsStore.getState().notifyExternal("modify", "/elsewhere/a.md");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("modify", "notes/a.md");
  });
});

describe("planReconcile", () => {
  const inst = (id: string, version = "1.0.0") => ({ id, manifest: { version } });
  const loaded = (...e: [string, string][]) => new Map(e);

  it("loads newly enabled installed plugins and unloads disabled or uninstalled ones", () => {
    expect(
      planReconcile(loaded(["a", "1.0.0"], ["b", "1.0.0"], ["c", "1.0.0"]), {
        trusted: true,
        enabled: ["a", "c", "d"],
        installed: [inst("a"), inst("b"), inst("d")],
      }),
    ).toEqual({ unload: ["b", "c"], load: ["d"] });
  });

  it("reloads an updated plugin", () => {
    expect(
      planReconcile(loaded(["a", "1.0.0"]), {
        trusted: true,
        enabled: ["a"],
        installed: [inst("a", "1.1.0")],
      }),
    ).toEqual({ unload: ["a"], load: ["a"] });
  });

  it("does nothing in restricted mode or when already in sync", () => {
    expect(
      planReconcile(loaded(["a", "1.0.0"]), { trusted: false, enabled: [], installed: [] }),
    ).toEqual({ unload: [], load: [] });
    expect(
      planReconcile(loaded(["a", "1.0.0"]), {
        trusted: true,
        enabled: ["a"],
        installed: [inst("a")],
      }),
    ).toEqual({ unload: [], load: [] });
  });
});

describe("plugins store reconcile", () => {
  it("tears down a plugin disabled behind the host's back and reloads it when re-enabled", async () => {
    const t = setup({ trusted: true });
    const deps = { ...t.deps, readState: () => t.ipc.state() };
    await usePluginsStore.getState().attach("/ws", deps);
    expect(usePluginsStore.getState().commands.map((c) => c.id)).toContain("p:hello");

    t.ipc.enabled.delete("p"); // what the marketplace's disable does
    await usePluginsStore.getState().reconcile();
    expect(usePluginsStore.getState().snapshot?.status.p).toEqual({ state: "disabled" });
    expect(usePluginsStore.getState().commands).toEqual([]);

    t.ipc.enabled.add("p");
    await usePluginsStore.getState().reconcile();
    expect(usePluginsStore.getState().snapshot?.status.p).toEqual({ state: "enabled" });
    expect(usePluginsStore.getState().commands.map((c) => c.id)).toContain("p:hello");
    expect(usePluginsStore.getState().actionError).toBeNull();
  });

  it("unloads an uninstalled plugin and reloads an updated one", async () => {
    const t = setup({ trusted: true });
    const deps = { ...t.deps, readState: () => t.ipc.state() };
    await usePluginsStore.getState().attach("/ws", deps);
    expect(t.requested).toEqual(["p"]);

    t.ipc.installed = t.ipc.installed.map((i) => ({
      ...i,
      manifest: { ...i.manifest, version: "2.0.0" },
    }));
    await usePluginsStore.getState().reconcile();
    expect(t.requested).toEqual(["p", "p"]);
    expect(usePluginsStore.getState().snapshot?.status.p).toEqual({ state: "enabled" });

    t.ipc.installed = [];
    t.ipc.enabled.delete("p");
    await usePluginsStore.getState().reconcile();
    expect(usePluginsStore.getState().commands).toEqual([]);
    expect(usePluginsStore.getState().snapshot?.installed).toEqual([]);
  });
});
