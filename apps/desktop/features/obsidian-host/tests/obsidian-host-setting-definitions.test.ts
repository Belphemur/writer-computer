// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
// Real plugins call `app.metadataTypeManager.setType`, which records in the backend.
vi.mock("@/lib/property-types-ipc", () => ({
  propertyTypes: vi.fn(async () => []),
  propertyTypeSet: vi.fn(async () => {}),
}));
import { mountSettingTab } from "../web/components/mount-setting-tab";
import { createApp, type App } from "../web/host/api/app";
import { createHostServices, Plugin } from "../web/host/api/core";
import { installDomHelpers } from "../web/host/api/dom";
import type { SettingDefinitionItem } from "../web/host/api/setting-definitions";
import { PluginSettingTab, Setting, SettingPage } from "../web/host/api/ui";
import { detachedBridge } from "../web/host/api/views";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";
import { flushPromises } from "@tests/helpers/events";

beforeAll(() => installDomHelpers(window));
afterEach(() => document.body.replaceChildren());

function makeApp(): App {
  return createApp({
    io: createMemoryVaultIo({ "n.md": "x", "dir/m.md": "y" }),
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge: { ...detachedBridge },
  });
}

interface FxSettings {
  on: boolean;
  name: string;
  mode: string;
  n: number;
  level: number;
}

class DefTab extends PluginSettingTab {
  saved: FxSettings[] = [];
  constructor(app: App, plugin: Plugin) {
    super(app, plugin);
    (plugin as unknown as { settings: FxSettings }).settings = {
      on: false,
      name: "hello",
      mode: "b",
      n: 3,
      level: 2,
    };
  }
  get s(): FxSettings {
    return (this.plugin as unknown as { settings: FxSettings }).settings;
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const frag = createFragment();
    frag.append("See ", frag.createEl("a", { href: "https://x.test", text: "docs" }));
    return [
      { name: "Loose row", desc: "no control" },
      {
        type: "group",
        heading: "Main",
        items: [
          { name: "Enable", desc: frag, control: { type: "toggle", key: "on" } },
          { name: "Name", control: { type: "text", key: "name", placeholder: "p" } },
          {
            name: "Mode",
            control: { type: "dropdown", key: "mode", options: { a: "A", b: "B" } },
            visible: () => this.s.on,
          },
          {
            name: "Count",
            control: {
              type: "number",
              key: "n",
              validate: (v) => (v < 1 ? "Must be positive" : undefined),
            },
          },
          {
            name: "Level",
            control: { type: "slider", key: "level", min: 0, max: 5, step: 1 },
          },
        ],
      },
    ];
  }
}

function setup(Tab: new (a: App, p: Plugin) => PluginSettingTab = DefTab) {
  const app = makeApp();
  const plugin = new Plugin(app, { id: "fx", name: "Fixture", version: "1.0.0" });
  const tab = new Tab(app, plugin);
  plugin.addSettingTab(tab);
  const host = document.createElement("div");
  document.body.append(host);
  const mounted = mountSettingTab(host, "fx", tab);
  return { app, plugin, tab, host, mounted };
}

describe("declarative settings tab", () => {
  it("renders groups, controls and fragment descriptions as .setting-item DOM", () => {
    const { host, mounted } = setup();
    expect(mounted.error).toBeNull();
    const q = (s: string) => host.querySelectorAll(s).length;
    expect(q(".setting-item")).toBe(6);
    expect(q(".setting-group")).toBe(2);
    expect(host.querySelector(".setting-group-heading")?.textContent).toBe("Main");
    expect(host.querySelector(".setting-item-description a")?.getAttribute("href")).toBe(
      "https://x.test",
    );
    expect(q(".checkbox-container")).toBe(1);
    expect(q("input[type=range]")).toBe(1);
    expect((host.querySelector("input[type=number]") as HTMLInputElement).value).toBe("3");
    expect((host.querySelector("input[type=text]") as HTMLInputElement).placeholder).toBe("p");
  });

  it("persists changes through setControlValue to plugin.settings and data.json", async () => {
    const { host, plugin, tab } = setup();
    const saves: unknown[] = [];
    plugin.saveData = async (d: unknown) => void saves.push(structuredClone(d));
    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    input.value = "world";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    expect((tab as DefTab).s.name).toBe("world");
    expect(saves.at(-1)).toMatchObject({ name: "world" });
    (host.querySelector(".checkbox-container") as HTMLElement).click();
    await flushPromises();
    expect((tab as DefTab).s.on).toBe(true);
  });

  it("applies `visible` predicates after a change and on update()", async () => {
    const { host, tab } = setup();
    const mode = () => host.querySelector<HTMLElement>('[data-setting-key="mode"]')!;
    expect(mode().style.display).toBe("none");
    (host.querySelector(".checkbox-container") as HTMLElement).click();
    await flushPromises();
    expect(mode().style.display).toBe("");
    (tab as DefTab).s.on = false;
    tab.update();
    expect(mode().style.display).toBe("none");
  });

  it("rejects invalid values with an inline error and does not persist them", async () => {
    const { host, tab } = setup();
    const n = host.querySelector("input[type=number]") as HTMLInputElement;
    n.value = "0";
    n.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(host.querySelector(".setting-item-error")?.textContent).toBe("Must be positive");
    expect((tab as DefTab).s.n).toBe(3);
    n.value = "7";
    n.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(host.querySelector(".setting-item-error")).toBeNull();
    expect((tab as DefTab).s.n).toBe(7);
  });

  it("update() re-renders structural changes and keeps focus", async () => {
    class DynTab extends DefTab {
      extra = false;
      getSettingDefinitions(): SettingDefinitionItem[] {
        const base = super.getSettingDefinitions();
        return this.extra ? [...base, { name: "Extra", desc: "added" }] : base;
      }
    }
    const { host, tab } = setup(DynTab);
    const t = tab as DynTab;
    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 4);
    t.extra = true;
    t.update();
    expect(host.querySelectorAll(".setting-item")).toHaveLength(7);
    const again = host.querySelector("input[type=text]") as HTMLInputElement;
    expect(again).not.toBe(input);
    expect(document.activeElement).toBe(again);
    expect(again.selectionStart).toBe(2);
  });

  it("renders pages with a back button, lists with add/delete, and run-time hide() cleans up", () => {
    const deleted: number[] = [];
    const added = vi.fn();
    const cleanup = vi.fn();
    class PageTab extends PluginSettingTab {
      getSettingDefinitions(): SettingDefinitionItem[] {
        return [
          {
            type: "page",
            name: "Sub",
            displayValue: "2 items",
            items: [
              {
                type: "list",
                heading: "Things",
                emptyState: "nothing",
                addItem: { name: "Add", action: added },
                onDelete: (i) => deleted.push(i),
                items: [{ name: "one", searchable: false }, { name: "two" }],
              },
              { name: "Custom", render: (s) => (s.setDesc("rendered"), cleanup) },
            ],
          },
          {
            type: "page",
            name: "Imperative",
            page: () =>
              new (class extends SettingPage {
                display() {
                  this.title = "Imp";
                  new Setting(this.containerEl).setName("inside");
                }
              })(),
          },
        ];
      }
    }
    const { host, tab } = setup(PageTab);
    expect(host.querySelector(".setting-page-value")?.textContent).toBe("2 items");
    (host.querySelector(".setting-item.mod-page") as HTMLElement).click();
    expect(host.querySelector(".setting-page-title")?.textContent).toBe("Sub");
    expect(host.querySelectorAll(".setting-list .setting-item")).toHaveLength(2);
    (host.querySelector(".setting-list-add") as HTMLElement).click();
    expect(added).toHaveBeenCalledTimes(1);
    (host.querySelectorAll(".setting-list-delete")[1] as HTMLElement).click();
    expect(deleted).toEqual([1]);
    tab.hide();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".setting-item")).toBeNull();
    // imperative page
    const m = setup(PageTab);
    (m.host.querySelectorAll(".setting-item.mod-page")[1] as HTMLElement).click();
    expect(m.host.querySelector(".setting-page-title")?.textContent).toBe("Imp");
    expect(m.host.textContent).toContain("inside");
    (m.host.querySelector(".setting-page-back") as HTMLElement).click();
    expect(m.host.querySelectorAll(".setting-item.mod-page")).toHaveLength(2);
  });

  it("group search filters children and survives re-render", () => {
    class SearchTab extends PluginSettingTab {
      getSettingDefinitions(): SettingDefinitionItem[] {
        return [
          {
            type: "group",
            search: { match: (d, q) => d.name.includes(q) },
            items: [{ name: "alpha" }, { name: "beta" }],
          },
        ];
      }
    }
    const { host, tab } = setup(SearchTab);
    const search = host.querySelector("input[type=search]") as HTMLInputElement;
    search.value = "be";
    search.dispatchEvent(new Event("input"));
    const rows = () =>
      [...host.querySelectorAll<HTMLElement>(".setting-item[data-setting-name]")].map(
        (r) => r.style.display,
      );
    expect(rows()).toEqual(["none", ""]);
    tab.update();
    expect(rows()).toEqual(["none", ""]);
  });

  it("precedence: definitions win over display(); classic display() plugins are untouched", () => {
    const classicDisplay = vi.fn();
    class Both extends DefTab {
      display(): void {
        classicDisplay();
      }
    }
    const a = setup(Both);
    expect(classicDisplay).not.toHaveBeenCalled();
    expect(a.host.querySelectorAll(".setting-item")).toHaveLength(6);

    class Classic extends PluginSettingTab {
      calls = 0;
      display(): void {
        this.calls++;
        new Setting(this.containerEl).setName("Classic").addToggle((t) => t.setValue(true));
      }
    }
    const b = setup(Classic);
    expect((b.tab as Classic).calls).toBe(1);
    expect(b.host.querySelectorAll(".setting-item")).toHaveLength(1);
    b.tab.update(); // must not re-render a classic tab (no double render)
    expect((b.tab as Classic).calls).toBe(1);
  });
});

// ------------------------------------------------------------ real bundles (read-only)

const PLUGINS = join(homedir(), "Documents/Vault/PersonalVault/.obsidian/plugins");

async function realTab(id: string, data: Record<string, unknown>) {
  const dir = join(PLUGINS, id);
  const source = readFileSync(join(dir, "main.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const g = globalThis as unknown as { __writerPluginDefine: (id: string, f: unknown) => void };
  const loadScript: ScriptLoader = async (url) => {
    const pid = decodeURIComponent(url.split("/")[3]);
    const script = `__writerPluginDefine(${JSON.stringify(pid)}, function (module, exports, require, process, global, Buffer) {\n${source}\n});`;
    // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper like a script tag
    new Function(script)();
    void g;
  };
  const ipc = new FakeHostIpc({
    enabled: [id],
    plugins: [{ ...manifest, id }],
    data: { [id]: JSON.stringify(data) },
  });
  const host = new PluginHost({
    ipc,
    io: createMemoryVaultIo({ "a.md": "# A", "Templates/t.md": "t" }),
    loadScript,
    styles: { add: () => () => {} },
  });
  await host.boot();
  return { host, tabs: host.services.settingTabs.list().filter((t) => t.owner === id) };
}

describe.skipIf(!existsSync(PLUGINS))("real plugin bundles render their settings", () => {
  const cases: [string, number][] = [
    ["templater-obsidian", 15],
    ["obsidian-linter", 15],
    ["obsidian-tasks-plugin", 15],
    ["obsidian-meta-bind-plugin", 8],
    ["obsidian-languagetool-plugin", 15],
  ];
  for (const [id, min] of cases) {
    it(`${id} renders at least ${min} rows`, async () => {
      const { host, tabs } = await realTab(id, {});
      try {
        expect(tabs.length).toBeGreaterThan(0);
        const el = document.createElement("div");
        document.body.append(el);
        const mounted = mountSettingTab(el, id, tabs[0].tab);
        expect(mounted.error).toBeNull();
        expect(el.querySelectorAll(".setting-item").length).toBeGreaterThanOrEqual(min);
        mounted.dispose();
      } finally {
        await host.shutdown();
      }
    }, 30_000);
  }
});
