// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/obsidian-host/seal/seal", () => ({
  hostInvoke: vi.fn(),
  sealTauri: vi.fn(),
}));

import { Facet } from "@codemirror/state";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";
import { getPluginEditorExtensions } from "../src/lib/obsidian-host/editor-bridge";
import { usePluginsStore, type PluginsDeps } from "../src/stores/plugins-store";

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

function setup(init: { trusted: boolean; seal?: () => void }) {
  const ipc = new FakeHostIpc({
    trusted: init.trusted,
    enabled: ["p"],
    plugins: [{ id: "p", name: "Plug" }],
  });
  const requested: string[] = [];
  const hosts: PluginHost[] = [];
  const seal = init.seal ?? vi.fn();
  const deps: PluginsDeps = {
    seal,
    createHost: async (_root, _name, bridge) => {
      const host = new PluginHost({
        ipc,
        io: createMemoryVaultIo({ "a.md": "# A" }),
        bridge,
        loadScript: loaderFor({ p: plugin }, requested),
        styles: { add: () => () => {} },
        seal: () => {},
      });
      hosts.push(host);
      return host;
    },
  };
  return { ipc, requested, hosts, deps, seal };
}

beforeEach(async () => {
  await usePluginsStore.getState().detach();
});
afterEach(async () => {
  await usePluginsStore.getState().detach();
});

describe("plugins store boot", () => {
  it("does not seal or load anything in a restricted vault, but lists installed plugins", async () => {
    const t = setup({ trusted: false });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const s = usePluginsStore.getState();
    expect(t.seal).not.toHaveBeenCalled();
    expect(t.requested).toEqual([]);
    expect(s.snapshot?.trusted).toBe(false);
    expect(s.snapshot?.booted).toBe(false);
    expect(s.snapshot?.installed.map((p: { id: string }) => p.id)).toEqual(["p"]);
    expect(s.bootError).toBeNull();
  });

  it("seals first, boots a trusted vault, mirrors registries and marks layout ready", async () => {
    const order: string[] = [];
    const t = setup({ trusted: true, seal: () => void order.push("seal") });
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
    expect(order).toEqual(["seal", "enabled"]);
    expect(s.snapshot?.status.p).toEqual({ state: "enabled" });
    expect(s.commands.map((c) => c.id)).toContain("p:hello");
    expect(s.ribbon).toHaveLength(1);
    expect(s.statusItems).toHaveLength(1);
    expect(t.hosts[0].app.workspace.layoutReady).toBe(true);
    expect(getPluginEditorExtensions()).toEqual([EXTENSION]);
  });

  it("fails closed when sealing throws: no plugin loads and the error is surfaced", async () => {
    const t = setup({
      trusted: true,
      seal: () => {
        throw new Error("no internals");
      },
    });
    await usePluginsStore.getState().attach("/ws", t.deps);
    const s = usePluginsStore.getState();
    expect(t.requested).toEqual([]);
    expect(s.bootError).toMatch(/could not seal the Tauri bridge \(no internals\)/);
    expect(s.snapshot?.booted).toBe(false);
    expect(s.commands).toEqual([]);
  });

  it("refuses to trust a vault when sealing fails, leaving it restricted", async () => {
    const seal = vi.fn(() => {
      throw new Error("boom");
    });
    const t = setup({ trusted: false, seal });
    await usePluginsStore.getState().attach("/ws", t.deps);
    await usePluginsStore.getState().setTrusted(true);
    expect(t.ipc.trusted).toBe(false);
    expect(t.requested).toEqual([]);
    expect(usePluginsStore.getState().bootError).toMatch(/boom/);
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
    expect(t.seal).toHaveBeenCalledTimes(1);
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
