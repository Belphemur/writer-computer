// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { mountSettingTab } from "../web/components/mount-setting-tab";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import type { SettingTabLike } from "../web/host/api/core";
import {
  resolveSettingTarget,
  SETTING_OPEN_GRACE_MS,
  usePluginsStore,
  type PluginsDeps,
} from "../web/stores/plugins-store";
import { useEditorStore } from "../../../src/stores/editor-store";
import { useUIStore } from "../../../src/stores/ui-store";
import { pluginSectionId } from "../../../src/components/settings-panel/settings-sections";

const errorLog = () => ((window as any).__writerPluginErrors ?? []) as { phase: string }[];

describe("resolveSettingTarget", () => {
  const entry = (owner: string, id: string) => ({
    owner,
    tab: { id, name: id } as unknown as SettingTabLike,
  });
  const entries = [entry("a", "a"), entry("b", "general"), entry("b", "advanced")];

  it("resolves `<plugin>:<tab>`, a plugin id (first tab) and a bare tab id", () => {
    expect(resolveSettingTarget(entries, "b:advanced")).toBe(entries[2]);
    expect(resolveSettingTarget(entries, "b")).toBe(entries[1]);
    expect(resolveSettingTarget(entries, "advanced")).toBe(entries[2]);
    expect(resolveSettingTarget(entries, "nope")).toBeNull();
  });
});

describe("mountSettingTab", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    (window as any).__writerPluginErrors = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  function fakeTab(display: () => void) {
    const containerEl = document.createElement("div");
    const tab = {
      id: "t",
      name: "T",
      containerEl,
      connectedAtDisplay: null as boolean | null,
      display: vi.fn(() => {
        tab.connectedAtDisplay = containerEl.isConnected;
        display();
      }),
      hide: vi.fn(),
    };
    return tab;
  }

  it("attaches the container before display() and calls hide() on dispose", () => {
    const tab = fakeTab(() => {});
    const mounted = mountSettingTab(host, "p", tab);
    expect(tab.display).toHaveBeenCalledTimes(1);
    expect(tab.connectedAtDisplay).toBe(true);
    expect(mounted.error).toBeNull();
    expect(tab.hide).not.toHaveBeenCalled();
    mounted.dispose();
    expect(tab.hide).toHaveBeenCalledTimes(1);
    expect(tab.containerEl.isConnected).toBe(false);
  });

  it("reports a display() failure, records it, and still hides on dispose", () => {
    const tab = fakeTab(() => {
      throw new Error("boom");
    });
    const mounted = mountSettingTab(host, "p", tab);
    expect(mounted.error).toBe("boom");
    expect(errorLog().map((e) => e.phase)).toContain("settings-tab");
    mounted.dispose();
    expect(tab.hide).toHaveBeenCalledTimes(1);
  });

  it("a throwing hide() is recorded, not propagated, and the container is still detached", () => {
    const tab = fakeTab(() => {});
    tab.hide.mockImplementation(() => {
      throw new Error("nope");
    });
    const mounted = mountSettingTab(host, "p", tab);
    expect(() => mounted.dispose()).not.toThrow();
    expect(errorLog().map((e) => e.phase)).toContain("settings-tab-hide");
    expect(tab.containerEl.isConnected).toBe(false);
  });
});

describe("app.setting wiring", () => {
  const g = globalThis as unknown as {
    __writerPluginDefine: (id: string, factory: unknown) => void;
  };

  async function boot() {
    const ipc = new FakeHostIpc({
      trusted: true,
      enabled: ["p"],
      plugins: [{ id: "p", name: "Plug" }],
    });
    const loadScript: ScriptLoader = async (url) => {
      const id = decodeURIComponent(url.split("/")[3]);
      g.__writerPluginDefine(id, (module: any, _e: any, require: any) => {
        const { Plugin, PluginSettingTab } = require("obsidian");
        module.exports = class extends Plugin {
          async onload() {
            this.addSettingTab(new PluginSettingTab(this.app, this));
          }
        };
      });
    };
    let host!: PluginHost;
    const deps: PluginsDeps = {
      createHost: async (_r, _n, bridge) =>
        (host = new PluginHost({
          ipc,
          io: createMemoryVaultIo({}),
          bridge,
          loadScript,
          styles: { add: () => () => {} },
        })),
    };
    await usePluginsStore.getState().attach("/ws", deps);
    return host;
  }

  const kinds = () => useEditorStore.getState().tabs.map((t) => t.location);

  beforeEach(async () => {
    (window as any).__writerPluginErrors = [];
    await usePluginsStore.getState().detach();
    useEditorStore.setState({ tabs: [], activeTabId: null, activeFilePath: null });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await usePluginsStore.getState().detach();
  });

  it("openTabById opens (or focuses) the one Settings tab at the plugin's section", async () => {
    const host = await boot();
    host.app.setting.openTabById("p");
    host.app.setting.openTabById("p:p");
    expect(kinds()).toEqual([{ kind: "settings" }]);
    expect(useUIStore.getState().settingsSection).toBe(pluginSectionId("p", "p"));
  });

  it("open() falls back to Settings after a grace period; openTabById within it wins", async () => {
    vi.useFakeTimers();
    const host = await boot();
    host.app.setting.open();
    host.app.setting.openTabById("p");
    vi.advanceTimersByTime(SETTING_OPEN_GRACE_MS + 10);
    expect(kinds().map((l) => l.kind)).toEqual(["settings"]);
    expect(useUIStore.getState().settingsSection).toBe(pluginSectionId("p", "p"));
    host.app.setting.open();
    vi.advanceTimersByTime(SETTING_OPEN_GRACE_MS + 10);
    expect(kinds().map((l) => l.kind)).toEqual(["settings"]);
  });

  it("an unknown id records an error and opens Settings", async () => {
    const host = await boot();
    host.app.setting.openTabById("missing");
    expect(kinds().map((l) => l.kind)).toEqual(["settings"]);
    expect(errorLog().map((e) => e.phase)).toContain("setting.openTabById");
  });

  it("detach unhooks openRequested", async () => {
    const host = await boot();
    await usePluginsStore.getState().detach();
    expect(host.app.setting.openRequested).toBeNull();
  });
});
