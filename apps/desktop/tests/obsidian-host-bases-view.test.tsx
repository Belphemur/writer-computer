// @vitest-environment jsdom
// `Plugin.registerBasesView`: registration into the shared registry, the BasesView lifecycle
// (coalesced `onDataUpdated`, fresh data each time, destroy), option controls persisting into the
// view YAML, formula evaluation, error display, and teardown when the plugin is disabled.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("../src/lib/bases/ipc", () => ({
  baseList: vi.fn(),
  baseRead: vi.fn(),
  baseQuery: vi.fn(),
  baseQueryText: vi.fn(),
  noteProperties: vi.fn(),
  notePropertySet: vi.fn(),
  notePropertyRemove: vi.fn(),
  onIndexChanged: vi.fn(),
  baseEval: vi.fn(),
  indexProperties: vi.fn(),
  baseWriteText: vi.fn(),
  baseFunctions: vi.fn(),
}));

import { BaseView } from "../src/components/base-view";
import * as ipc from "../src/lib/bases/ipc";
import { resetFunctionRegistry } from "../src/lib/bases/function-registry";
import { FUNCTIONS } from "./helpers/bases-functions";
import { getBaseView, type BaseViewProps } from "../src/lib/bases/view-registry";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import {
  BASE_PATH,
  baseDocument,
  baseView,
  groupedResult,
  taskResult,
} from "./helpers/bases-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Req = (name: string) => any;
type Factory = (module: { exports: any }, exports: any, require: Req) => void;
const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

/** What the fake plugin's view saw, in call order. */
interface Probe {
  instances: any[];
  updates: { data: any; formula: unknown; option: unknown }[];
  unloaded: number;
  registered: boolean[];
  extra: Record<string, unknown>;
}
let probe: Probe;

/** A plugin that registers one Bases view, written the way the public guide shows. */
const fakePlugin: Factory = (module, _e, require) => {
  const { Plugin, BasesView } = require("obsidian");
  class FakeView extends BasesView {
    type = "fake";
    constructor(
      controller: unknown,
      public el: HTMLElement,
    ) {
      super(controller);
      probe.instances.push(this);
      this.el.append(Object.assign(document.createElement("div"), { className: "fake-root" }));
    }
    onDataUpdated() {
      probe.updates.push({
        data: this.data,
        formula: this.config.getEvaluatedFormula(this, "calc"),
        option: this.config.get("note"),
      });
      this.el.querySelector(".fake-root")!.textContent = `rows:${this.data.data.length}`;
    }
    onunload() {
      probe.unloaded++;
    }
  }
  module.exports = class extends Plugin {
    async onload() {
      const registration = {
        name: "Fake view",
        icon: "star",
        factory: (controller: unknown, el: HTMLElement) => new FakeView(controller, el),
        options: () => [
          { type: "text", key: "note", displayName: "Note", default: "hi" },
          { type: "formula", key: "calc", displayName: "Calculation" },
          { type: "property", key: "pick", displayName: "Picked property" },
          {
            type: "group",
            displayName: "Style",
            items: [
              {
                type: "dropdown",
                key: "mode",
                displayName: "Mode",
                options: { a: "A", b: "B" },
                default: "a",
              },
              { type: "toggle", key: "flag", displayName: "Flag" },
              { type: "slider", key: "n", displayName: "N", min: 1, max: 9, step: 1, default: 3 },
              { type: "multitext", key: "tags", displayName: "Tags" },
            ],
          },
        ],
      };
      probe.registered.push(this.registerBasesView("fake", registration));
      probe.registered.push(this.registerBasesView("fake", registration)); // already taken
      probe.registered.push(this.registerBasesView("table", registration)); // built-in
    }
  };
};

function pluginUrlId(url: string): string {
  return decodeURIComponent(url.split("/")[3]!);
}

function setup(script: Factory = fakePlugin) {
  const ipcFake = new FakeHostIpc({
    trusted: true,
    enabled: ["bp"],
    plugins: [{ id: "bp", name: "Bases plugin" }],
  });
  const loader: ScriptLoader = async (url) => {
    const id = pluginUrlId(url);
    g.__writerPluginDefine(id, (module: any, exports: any, require: Req) =>
      script(module, exports, require),
    );
  };
  const host = new PluginHost({
    ipc: ipcFake,
    io: createMemoryVaultIo({ "Tasks/alpha.md": "# A" }),
    loadScript: loader,
    styles: { add: () => () => {} },
  });
  return host;
}

const m = {
  baseRead: vi.mocked(ipc.baseRead),
  baseQuery: vi.mocked(ipc.baseQuery),
  baseQueryText: vi.mocked(ipc.baseQueryText),
  baseWriteText: vi.mocked(ipc.baseWriteText),
  baseEval: vi.mocked(ipc.baseEval),
  indexProperties: vi.mocked(ipc.indexProperties),
  onIndexChanged: vi.mocked(ipc.onIndexChanged),
};

const frame = () => new Promise<void>((r) => setTimeout(r, 40));

function propsFor(overrides: Partial<BaseViewProps> = {}): BaseViewProps {
  const result = taskResult({ view: { name: "Fake", type: "fake", index: 0 } });
  return {
    path: BASE_PATH,
    result,
    shown: 3,
    view: baseView({
      type: "fake",
      name: "Fake",
      order: ["file.name", "status", "due"],
      extra: { note: "x" },
    }),
    viewIndex: 0,
    document: baseDocument({ views: [baseView({ type: "fake", name: "Fake" })] }),
    label: "tasks",
    actions: { openFile: vi.fn(), openLink: vi.fn() },
    config: { cycleSort: vi.fn(), setColumnWidth: vi.fn(), setOption: vi.fn() },
    ...overrides,
  };
}

let host: PluginHost;

beforeEach(async () => {
  vi.clearAllMocks();
  resetFunctionRegistry();
  vi.mocked(ipc.baseFunctions).mockResolvedValue(FUNCTIONS);
  vi.spyOn(console, "error").mockImplementation(() => {});
  probe = { instances: [], updates: [], unloaded: 0, registered: [], extra: {} };
  host = setup();
  await host.boot();
});

afterEach(async () => {
  await host.disable("bp");
});

describe("registerBasesView", () => {
  it("registers into the shared registry and reports false for taken ids", () => {
    expect(probe.registered).toEqual([true, false, false]);
    const entry = getBaseView("fake")!;
    expect(entry.owner).toBe("bp");
    expect(entry.name).toBe("Fake view");
    expect(entry.icon).toBe("star");
    expect(entry.mount).toBeTypeOf("function");
    expect(getBaseView("table")!.owner).toBe("core");
  });

  it("rejects malformed registrations with a TypeError", async () => {
    const app = (host as any).app;
    expect(() => app.registerBasesView("bp", "", {})).toThrow(/non-empty/);
    expect(() => app.registerBasesView("bp", "x", { name: "X" })).toThrow(/name and a factory/);
    expect(() => app.registerBasesView("bp", "x", null)).toThrow(TypeError);
  });

  it("turns option descriptors into the host's ViewOption shape, including groups", () => {
    const options = getBaseView("fake")!.options!(baseView({ type: "fake" }));
    expect(options.map((o) => o.type)).toEqual(["text", "formula", "property", "group"]);
    const group = options[3]! as { items: { type: string; key: string }[] };
    expect(group.items.map((i) => `${i.type}:${i.key}`)).toEqual([
      "dropdown:mode",
      "toggle:flag",
      "slider:n",
      "multitext:tags",
    ]);
  });

  it("reports a bad options() through the error log and shows no options", async () => {
    const bad: Factory = (module, _e, require) => {
      const { Plugin } = require("obsidian");
      module.exports = class extends Plugin {
        async onload() {
          this.registerBasesView("bad-options", {
            name: "Bad",
            factory: () => ({}),
            options: () => [{ type: "text", key: "type", displayName: "Reserved" }],
          });
        }
      };
    };
    const h = setup(bad);
    await h.boot();
    expect(getBaseView("bad-options")!.options!(undefined)).toEqual([]);
    expect(window.__writerPluginErrors?.some((e) => e.phase === "bases-view:options")).toBe(true);
    await h.disable("bp");
  });
});

describe("view lifecycle", () => {
  it("creates the BasesView from the factory and coalesces updates per frame", async () => {
    const container = document.createElement("div");
    const mounted = getBaseView("fake")!.mount!(container, propsFor());
    expect(probe.instances).toHaveLength(1);
    expect(probe.instances[0].el).toBe(container);
    expect(probe.updates).toHaveLength(0); // nothing synchronously
    mounted.update(propsFor());
    mounted.update(propsFor());
    await frame();
    expect(probe.updates).toHaveLength(1);
    expect(container.querySelector(".fake-root")!.textContent).toBe("rows:3");
    mounted.update(propsFor());
    await frame();
    expect(probe.updates).toHaveLength(2);
    // A fresh result every time: nothing is reused.
    expect(probe.updates[1]!.data).not.toBe(probe.updates[0]!.data);
    expect(probe.updates[1]!.data.data[0]).not.toBe(probe.updates[0]!.data.data[0]);
    mounted.destroy();
  });

  it("gives entries with files and Value objects in the public shapes", async () => {
    const container = document.createElement("div");
    const mounted = getBaseView("fake")!.mount!(container, propsFor());
    await frame();
    const { data } = probe.updates[0]!;
    expect(data.data.map((e: any) => e.file.path)).toEqual([
      "Tasks/alpha.md",
      "Tasks/beta.md",
      "Tasks/gamma.md",
    ]);
    expect(data.data[0].file.basename).toBe("alpha");
    const status = data.data[0].getValue("note.status");
    expect(status.constructor.name).toBe("StringValue");
    expect(status.value).toBe("open");
    expect(status.toString()).toBe("open");
    expect(data.data[0].getValue("file.name").toString()).toBe("alpha");
    expect(data.data[0].getValue("note.nothing")).toBeNull();
    expect(data.data[2].getValue("note.status").isTruthy()).toBe(false); // null value
    const done = data.data[1].getValue("note.done");
    expect(done.value).toBe(true);
    const tags = data.data[0].getValue("note.tags");
    expect(tags.length()).toBe(2);
    expect(tags.get(1).toString()).toBe("y");
    const age = data.data[0].getValue("formula.age");
    expect(age.value).toBe(3);
    expect(data.data[2].getValue("formula.age").constructor.name).toBe("ErrorValue");
    const due = data.data[0].getValue("note.due");
    expect(due.constructor.name).toBe("DateValue");
    expect(due.time).toBe(false);
    expect(due.date.getFullYear()).toBe(2024);
    expect(data.properties).toEqual(["file.name", "note.status", "note.done"]);
    expect(data.groupedData).toHaveLength(1);
    expect(data.groupedData[0].hasKey()).toBe(false);
    expect(data.groupedData[0].entries).toHaveLength(3);
    mounted.destroy();
  });

  it("grouped data carries the group key as a Value", async () => {
    const container = document.createElement("div");
    const mounted = getBaseView("fake")!.mount!(
      container,
      propsFor({ result: { ...groupedResult(), view: { name: "Fake", type: "fake", index: 0 } } }),
    );
    await frame();
    const groups = probe.updates[0]!.data.groupedData;
    expect(groups.map((gr: any) => [gr.key.toString(), gr.entries.length, gr.hasKey()])).toEqual([
      ["open", 2, true],
      ["done", 1, true],
    ]);
    const data = probe.updates[0]!.data;
    expect(data.getSummaryValue(null, groups[0].entries, "file.name", "Count").toString()).toBe(
      "2",
    );
    expect(
      data.getSummaryValue(null, groups[0].entries, "note.status", "Sum").constructor.name,
    ).toBe("ErrorValue");
    mounted.destroy();
  });

  it("destroy unloads the view, empties the container and stops updates", async () => {
    const container = document.createElement("div");
    const mounted = getBaseView("fake")!.mount!(container, propsFor());
    await frame();
    mounted.update(propsFor());
    mounted.destroy();
    expect(probe.unloaded).toBe(1);
    expect(container.childNodes).toHaveLength(0);
    await frame();
    expect(probe.updates).toHaveLength(1);
  });

  it("shows a factory failure and an onDataUpdated failure in the container", async () => {
    const container = document.createElement("div");
    const entry = getBaseView("fake")!;
    // A factory that throws: replace via a second plugin.
    const boom: Factory = (module, _e, require) => {
      const { Plugin } = require("obsidian");
      module.exports = class extends Plugin {
        async onload() {
          this.registerBasesView("boom", {
            name: "Boom",
            factory: () => {
              throw new Error("no good");
            },
          });
          this.registerBasesView("boom2", {
            name: "Boom 2",
            factory: (c: unknown) => {
              const { BasesView } = require("obsidian");
              return new (class extends BasesView {
                type = "boom2";
                constructor(ctrl: unknown) {
                  super(ctrl);
                }
                onDataUpdated() {
                  throw new Error("update failed");
                }
              })(c);
            },
          });
        }
      };
    };
    const h = setup(boom);
    await h.boot();
    getBaseView("boom")!.mount!(container, propsFor());
    expect(container.querySelector("[data-base-plugin-error]")!.textContent).toContain("no good");
    const c2 = document.createElement("div");
    const mounted = getBaseView("boom2")!.mount!(c2, propsFor());
    await frame();
    expect(c2.querySelector("[data-base-plugin-error]")!.textContent).toContain("update failed");
    mounted.destroy();
    expect(window.__writerPluginErrors!.map((e) => e.phase)).toEqual(
      expect.arrayContaining(["bases-view:factory", "bases-view:onDataUpdated"]),
    );
    await h.disable("bp");
    expect(entry).toBeDefined();
  });
});

describe("config and options", () => {
  it("reads options and the view's settings, writes through the view config", async () => {
    const setOption = vi.fn();
    const props = propsFor({
      config: { cycleSort: vi.fn(), setColumnWidth: vi.fn(), setOption },
      view: baseView({
        type: "fake",
        name: "Fake",
        order: ["file.name", "note.status"],
        sort: [{ property: "due", direction: "DESC" }],
        extra: { note: "hello", pick: "status" },
      }),
    });
    const mounted = getBaseView("fake")!.mount!(document.createElement("div"), props);
    await frame();
    const config = probe.instances[0].config;
    expect(probe.updates[0]!.option).toBe("hello");
    expect(config.name).toBe("Fake");
    expect(config.getAsPropertyId("pick")).toBe("note.status");
    expect(config.getAsPropertyId("nothing")).toBeNull();
    expect(config.getOrder()).toEqual(["file.name", "note.status"]);
    expect(config.getSort()).toEqual([{ property: "note.due", direction: "DESC" }]);
    expect(config.getDisplayName("note.status")).toBe("Status");
    expect(config.get("limit")).toBeNull(); // typed key from the view model
    config.set("note", "changed");
    expect(setOption).toHaveBeenCalledWith("note", "changed");
    config.set("note", null);
    expect(setOption).toHaveBeenLastCalledWith("note", undefined);
    expect(() => config.set("type", "x")).toThrow(/belongs to Writer/);
    expect(() => config.set("sort", [])).toThrow(/belongs to Writer/);
    mounted.destroy();
  });

  it("evaluates formula options with this = the base file before onDataUpdated", async () => {
    m.baseEval.mockResolvedValue({ type: "number", value: 3, display: "3" });
    const props = propsFor({
      view: baseView({ type: "fake", name: "Fake", extra: { calc: "1 + 2" } }),
      document: baseDocument({ formulas: { age: "2 * 3" } }),
    });
    const mounted = getBaseView("fake")!.mount!(document.createElement("div"), props);
    await frame();
    expect(m.baseEval).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: "1 + 2",
        thisPath: BASE_PATH,
        text: 'formulas:\n  "age": "2 * 3"\n',
      }),
    );
    const formula = probe.updates[0]!.formula as { value: number };
    expect(formula.value).toBe(3);
    mounted.destroy();
  });

  it("an unset formula is null, a failing one an ErrorValue, an undeclared key an ErrorValue", async () => {
    const mounted = getBaseView("fake")!.mount!(document.createElement("div"), propsFor());
    await frame();
    expect((probe.updates[0]!.formula as object).constructor.name).toBe("NullValue");
    mounted.update(
      propsFor({ view: baseView({ type: "fake", name: "Fake", extra: { calc: "nope(" } }) }),
    );
    m.baseEval.mockRejectedValue(new Error("syntax error"));
    await frame();
    const failing = probe.updates.at(-1)!.formula as { message: string };
    expect(failing.message).toBe("syntax error");
    const config = probe.instances[0].config;
    expect(config.getEvaluatedFormula(null, "undeclared").message).toContain(
      "not a formula option",
    );
    mounted.destroy();
  });
});

describe("inside a base tab", () => {
  let root: Root;
  let el: HTMLDivElement;
  let text: string;

  beforeEach(() => {
    for (const [name, value] of [
      ["clientHeight", 400],
      ["clientWidth", 900],
    ] as const)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    text = "views:\n  - type: fake\n    name: Fake\n    note: stored\n";
    const doc = baseDocument({
      views: [baseView({ type: "fake", name: "Fake", extra: { note: "stored" } })],
    });
    m.baseRead.mockImplementation(async () => ({ text, document: doc, error: null }));
    m.baseQuery.mockImplementation(async () =>
      taskResult({ view: { name: "Fake", type: "fake", index: 0 }, availableViews: ["Fake"] }),
    );
    m.baseQueryText.mockImplementation(async () =>
      taskResult({ view: { name: "Fake", type: "fake", index: 0 }, availableViews: ["Fake"] }),
    );
    m.baseWriteText.mockImplementation(async (_p, content) => {
      text = content;
    });
    m.indexProperties.mockResolvedValue([{ key: "status", count: 1, types: {} }]);
    m.onIndexChanged.mockResolvedValue(() => {});
    useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [{ id: "tab-1", location: { kind: "base", path: BASE_PATH }, back: [], forward: [] }],
      activeTabId: "tab-1",
    });
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    el.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(<BaseView location={{ kind: "base", path: BASE_PATH }} isActive tabId="tab-1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
  }

  it("renders the plugin view, persists option values under their key, and swaps to the placeholder on disable", async () => {
    await mount();
    expect(el.querySelector('[data-base-plugin-view="fake"]')).not.toBeNull();
    expect(el.querySelector(".fake-root")!.textContent).toBe("rows:3");
    expect(probe.updates.at(-1)!.option).toBe("stored");

    // The settings popover lists the plugin's options; a text option commits on blur.
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-toolbar-menu="Settings"] button')!.click();
    });
    const rows = [...el.querySelectorAll("[data-view-option]")].map((r) =>
      r.getAttribute("data-view-option"),
    );
    expect(rows).toEqual(["note", "calc", "pick", "mode", "flag", "n", "tags"]);
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Note"]')!;
    expect(input.value).toBe("stored");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "fresh",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(m.baseWriteText.mock.calls.at(-1)![1]).toBe(
      "views:\n  - type: fake\n    name: Fake\n    note: fresh\n",
    );
    // A dropdown in a group, a toggle and a new key are added in place.
    const mode = el.querySelector<HTMLSelectElement>('select[aria-label="Mode"]')!;
    expect(mode.value).toBe("a");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "b");
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(m.baseWriteText.mock.calls.at(-1)![1]).toContain("    mode: b\n");

    // Disabling the plugin removes the view type: the tab shows the placeholder, the view is unloaded.
    await act(async () => {
      await host.disable("bp");
    });
    expect(getBaseView("fake")).toBeUndefined();
    expect(el.querySelector("[data-base-plugin-view]")).toBeNull();
    expect(el.querySelector('[data-base-unsupported="fake"]')).not.toBeNull();
    expect(probe.unloaded).toBeGreaterThanOrEqual(1);
  });

  it("re-enabling brings the view back", async () => {
    await mount();
    await act(async () => {
      await host.disable("bp");
    });
    expect(el.querySelector('[data-base-unsupported="fake"]')).not.toBeNull();
    await act(async () => {
      await host.enable("bp");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(el.querySelector('[data-base-plugin-view="fake"]')).not.toBeNull();
  });
});

describe("plugin teardown", () => {
  it("disable removes every view the plugin registered and leaves built-ins", async () => {
    expect(getBaseView("fake")).toBeDefined();
    await host.disable("bp");
    expect(getBaseView("fake")).toBeUndefined();
    for (const t of ["table", "cards", "list"]) expect(getBaseView(t)?.owner).toBe("core");
  });
});
