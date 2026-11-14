// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  deserializeLocation,
  pageKind,
  serializeLocation,
} from "../src/components/editor-area/page-kinds";
import { mountSettingTab } from "../src/components/plugins/mount-setting-tab";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";
import type { SettingTabLike } from "../src/lib/obsidian-host/api/core";
import {
  resolveSettingTarget,
  SETTING_OPEN_GRACE_MS,
  usePluginsStore,
  type PluginsDeps,
} from "../src/stores/plugins-store";
import { useEditorStore } from "../src/stores/editor-store";

const errorLog = () => ((window as any).__writerPluginErrors ?? []) as { phase: string }[];

describe("plugin-settings page kind", () => {
  const location = {
    kind: "plugin-settings" as const,
    pluginId: "copilot",
    pluginName: "Copilot",
    tabId: "copilot",
  };

  it("titles the tab after the plugin and carries no file paths", () => {
    const k = pageKind(location);
    expect(k.title(location)).toBe("Copilot options");
    expect(k.paths(location)).toEqual([]);
    expect(k.primaryPath(location)).toBeNull();
    expect(k.title({ ...location, pluginName: "" })).toBe("copilot options");
  });

  it("round-trips through the session payload and rejects a payload without a plugin id", () => {
    const data = serializeLocation(location);
    expect(data).toEqual(location);
    expect(deserializeLocation(data)).toEqual(location);
    expect(deserializeLocation({ kind: "plugin-settings" })).toBeNull();
    expect(deserializeLocation({ kind: "plugin-settings", pluginId: "x" })).toEqual({
      kind: "plugin-settings",
      pluginId: "x",
      pluginName: "x",
    });
  });
});

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

  it("openTabById opens (or focuses) one options tab for a plugin id or `<plugin>:<tab>` id", async () => {
    const host = await boot();
    host.app.setting.openTabById("p");
    host.app.setting.openTabById("p:p");
    expect(kinds()).toEqual([
      { kind: "plugin-settings", pluginId: "p", pluginName: "Plug", tabId: "p" },
    ]);
  });

  it("open() falls back to Settings after a grace period; openTabById within it wins", async () => {
    vi.useFakeTimers();
    const host = await boot();
    host.app.setting.open();
    host.app.setting.openTabById("p");
    vi.advanceTimersByTime(SETTING_OPEN_GRACE_MS + 10);
    expect(kinds().map((l) => l.kind)).toEqual(["plugin-settings"]);
    host.app.setting.open();
    vi.advanceTimersByTime(SETTING_OPEN_GRACE_MS + 10);
    expect(kinds().map((l) => l.kind)).toEqual(["plugin-settings", "settings"]);
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
