import { describe, expect, it, vi } from "vite-plus/test";
import * as cmState from "@codemirror/state";
import { PluginHost, type ScriptLoader, type StyleSink } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";

type Req = (name: string) => any;
type Factory = (module: { exports: any }, exports: any, require: Req) => void;

const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

function pluginUrlId(url: string): string {
  return decodeURIComponent(url.split("/")[3]);
}

/** Fake script injection: calls the global define exactly as the Rust-wrapped main.js would. */
function makeLoader(scripts: Record<string, Factory | "missing" | "no-define">) {
  const requested: string[] = [];
  const loader: ScriptLoader = async (url) => {
    const id = pluginUrlId(url);
    requested.push(url);
    const s = scripts[id];
    if (s === undefined || s === "missing") throw new Error("main.js refused or missing");
    if (s === "no-define") return;
    g.__writerPluginDefine(id, (module: any, exports: any, require: Req) =>
      s(module, exports, require),
    );
  };
  return { loader, requested };
}

function makeStyles() {
  const active = new Map<string, string>();
  const sink: StyleSink = {
    add(id, css) {
      active.set(id, css);
      return () => void active.delete(id);
    },
  };
  return { sink, active };
}

function setup(opts: {
  scripts: Record<string, Factory | "missing" | "no-define">;
  ipc?: FakeHostIpc;
}) {
  const ipc =
    opts.ipc ??
    new FakeHostIpc({
      trusted: true,
      enabled: Object.keys(opts.scripts),
      plugins: Object.keys(opts.scripts).map((id) => ({ id, name: `Plugin ${id}` })),
    });
  const { loader, requested } = makeLoader(opts.scripts);
  const styles = makeStyles();
  const host = new PluginHost({
    ipc,
    io: createMemoryVaultIo({ "a.md": "# A" }),
    loadScript: loader,
    styles: styles.sink,
  });
  return { host, ipc, requested, styles };
}

const simplePlugin: Factory = (module, _e, require) => {
  const { Plugin } = require("obsidian");
  module.exports = class extends Plugin {
    async onload() {
      this.addCommand({ id: "hello", name: "Hello", callback: () => {} });
    }
  };
};

describe("PluginHost boot", () => {
  it("loads nothing when the vault is not trusted", async () => {
    const ipc = new FakeHostIpc({ trusted: false, enabled: ["p"], plugins: [{ id: "p" }] });
    const { host, requested } = setup({ scripts: { p: simplePlugin }, ipc });
    await host.boot();
    expect(requested).toEqual([]);
    expect(host.getStatus("p")).toEqual({ state: "disabled" });
    expect(host.getSnapshot().trusted).toBe(false);
  });

  it("loads enabled plugins in order on a trusted boot, with no seal step", async () => {
    const order: string[] = [];
    const ipc = new FakeHostIpc({ enabled: ["a", "b"], plugins: [{ id: "a" }, { id: "b" }] });
    const { host } = setup({
      scripts: {
        a: (m, e, r) => {
          order.push("eval:a");
          simplePlugin(m, e, r);
        },
        b: (m, e, r) => {
          order.push("eval:b");
          simplePlugin(m, e, r);
        },
      },
      ipc,
    });
    await host.boot();
    expect(order).toEqual(["eval:a", "eval:b"]);
    expect(host.getStatus("a").state).toBe("enabled");
    expect(host.getStatus("b").state).toBe("enabled");
  });

  it("does not load installed plugins that are not enabled", async () => {
    const ipc = new FakeHostIpc({ enabled: ["a"], plugins: [{ id: "a" }, { id: "b" }] });
    const { host, requested } = setup({ scripts: { a: simplePlugin, b: simplePlugin }, ipc });
    await host.boot();
    expect(requested).toHaveLength(1);
    expect(host.getStatus("b")).toEqual({ state: "disabled" });
  });
});

describe("enable / disable teardown", () => {
  it("removes commands, events, intervals and styles on disable", async () => {
    vi.useFakeTimers();
    try {
      const ticks = vi.fn();
      const vaultHits = vi.fn();
      const ipc = new FakeHostIpc({
        enabled: [],
        plugins: [{ id: "p", name: "P" }],
        styles: { p: ".x{color:red}" },
      });
      const { host, styles } = setup({
        ipc,
        scripts: {
          p: (module, _e, require) => {
            const { Plugin } = require("obsidian");
            module.exports = class extends Plugin {
              async onload() {
                this.addCommand({ id: "go", name: "Go", callback: () => {} });
                this.registerEvent(this.app.vault.on("modify", vaultHits));
                this.registerInterval(setInterval(ticks, 10) as unknown as number);
              }
            };
          },
        },
      });
      await host.boot();
      await host.enable("p");
      expect(ipc.calls).toContain("setEnabled:p:true");
      expect(host.getStatus("p")).toEqual({ state: "enabled" });
      expect(host.services.commands.has("p:go")).toBe(true);
      expect(host.services.commands.get("p:go")?.name).toBe("P: Go");
      expect(styles.active.get("p")).toBe(".x{color:red}");
      host.app.vault.trigger("modify", {});
      vi.advanceTimersByTime(25);
      expect(vaultHits).toHaveBeenCalledTimes(1);
      expect(ticks).toHaveBeenCalledTimes(2);

      await host.disable("p");
      expect(ipc.calls).toContain("setEnabled:p:false");
      expect(host.getStatus("p")).toEqual({ state: "disabled" });
      expect(host.services.commands.has("p:go")).toBe(false);
      expect(styles.active.has("p")).toBe(false);
      expect(host.app.plugins.getPlugin("p")).toBeNull();
      host.app.vault.trigger("modify", {});
      vi.advanceTimersByTime(100);
      expect(vaultHits).toHaveBeenCalledTimes(1);
      expect(ticks).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onunload and can be re-enabled", async () => {
    const onunload = vi.fn();
    const { host, requested } = setup({
      scripts: {
        p: (module, _e, require) => {
          const { Plugin } = require("obsidian");
          module.exports = class extends Plugin {
            onunload() {
              onunload();
            }
          };
        },
      },
    });
    await host.boot();
    await host.disable("p");
    expect(onunload).toHaveBeenCalledTimes(1);
    await host.enable("p");
    expect(requested).toHaveLength(2);
    expect(host.getStatus("p").state).toBe("enabled");
  });

  it("loads a plugin once when enable is called twice concurrently", async () => {
    const { host, requested } = setup({
      ipc: new FakeHostIpc({ enabled: [], plugins: [{ id: "p" }] }),
      scripts: { p: simplePlugin },
    });
    await host.boot();
    await Promise.all([host.enable("p"), host.enable("p")]);
    expect(requested).toHaveLength(1);
  });

  it("refuses to enable in restricted mode", async () => {
    const ipc = new FakeHostIpc({ trusted: false, plugins: [{ id: "p" }] });
    const { host, requested } = setup({ scripts: { p: simplePlugin }, ipc });
    await host.boot();
    await expect(host.enable("p")).rejects.toThrow(/restricted mode/);
    expect(requested).toEqual([]);
  });

  it("revoking trust unloads every plugin; granting it loads the enabled ones", async () => {
    const { host, ipc } = setup({ scripts: { p: simplePlugin } });
    await host.boot();
    expect(host.services.commands.has("p:hello")).toBe(true);
    await host.setTrust(false);
    expect(ipc.calls).toContain("setTrust:false");
    expect(host.services.commands.has("p:hello")).toBe(false);
    expect(host.getStatus("p").state).toBe("disabled");
    await host.setTrust(true);
    expect(host.getStatus("p").state).toBe("enabled");
    expect(host.services.commands.has("p:hello")).toBe(true);
  });

  it("notifies subscribers with a new snapshot on status changes", async () => {
    const { host } = setup({ scripts: { p: simplePlugin } });
    const listener = vi.fn();
    host.subscribe(listener);
    const before = host.getSnapshot();
    await host.boot();
    expect(listener).toHaveBeenCalled();
    expect(host.getSnapshot()).not.toBe(before);
    expect(host.getSnapshot().status.p.state).toBe("enabled");
    expect(host.getSnapshot().installed.map((m) => m.id)).toEqual(["p"]);
  });
});

describe("failures", () => {
  it("a plugin that throws in onload ends failed and everything it registered is swept", async () => {
    const { host, styles, ipc } = setup({
      ipc: new FakeHostIpc({ enabled: ["bad"], plugins: [{ id: "bad" }], styles: { bad: "b{}" } }),
      scripts: {
        bad: (module, _e, require) => {
          const { Plugin } = require("obsidian");
          module.exports = class extends Plugin {
            async onload() {
              this.addCommand({ id: "x", name: "X", callback: () => {} });
              this.registerEvent(this.app.vault.on("create", () => {}));
              throw new Error("boom in onload");
            }
          };
        },
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("bad")).toEqual({ state: "failed", error: "boom in onload" });
    expect(host.services.commands.size).toBe(0);
    expect(styles.active.size).toBe(0);
    expect(host.app.plugins.getPlugin("bad")).toBeNull();
    // Failure does not flip the persisted enabled flag (Obsidian parity).
    expect(ipc.enabled.has("bad")).toBe(true);
  });

  it("one failing plugin does not stop the others", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = setup({
      scripts: {
        bad: () => {
          throw new Error("top-level bug");
        },
        good: simplePlugin,
      },
    });
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("bad")).toEqual({ state: "failed", error: "top-level bug" });
    expect(host.getStatus("good").state).toBe("enabled");
  });

  it("reports a missing main.js", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = setup({ scripts: { p: "missing" } });
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("p").state).toBe("failed");
    expect(host.getStatus("p").error).toMatch(/missing/);
  });

  it("reports a script that loads but never defines", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = setup({ scripts: { p: "no-define" } });
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("p").error).toMatch(/did not define/);
  });

  it("reports a module that does not export a Plugin subclass", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = setup({
      scripts: {
        p: (module) => {
          module.exports = class NotAPlugin {};
        },
      },
    });
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("p").error).toMatch(/extending Plugin/);
  });

  it("ignores a define nobody asked for", () => {
    expect(() => g.__writerPluginDefine("stray", () => {})).not.toThrow();
  });
});

describe("require", () => {
  it("serves obsidian, the app's CodeMirror and path; refuses fs calls and other builtins", async () => {
    const seen: Record<string, unknown> = {};
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = setup({
      scripts: {
        ok: (module, _e, require) => {
          const { Plugin } = require("obsidian");
          seen.state = require("@codemirror/state");
          seen.joined = require("node:path").join("a", "..", "b", "c.md");
          let fsError = "";
          try {
            require("fs").readFileSync("/etc/passwd");
          } catch (e) {
            fsError = (e as Error).message;
          }
          seen.fsError = fsError;
          module.exports = class extends Plugin {};
        },
        cp: (_m, _e, require) => {
          require("child_process");
        },
        cmx: (_m, _e, require) => {
          require("@codemirror/not-a-module");
        },
      },
    });
    await host.boot();
    errorSpy.mockRestore();
    expect(host.getStatus("ok").state).toBe("enabled");
    expect(seen.state).toBe(cmState);
    expect(seen.joined).toBe("b/c.md");
    expect(seen.fsError).toMatch(/not supported in Writer/);
    expect(host.getStatus("cp").error).toBe(
      'cp: require("child_process") is not supported in Writer (no Node.js built-ins are available to plugins)',
    );
    expect(host.getStatus("cmx").error).toMatch(/@codemirror\/not-a-module/);
  });
});

/** The slice of Plugin the persistence tests drive (the class comes from `require`, so it is untyped). */
interface PluginData {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

describe("settings persistence", () => {
  it("round-trips through loadData/saveData and keeps the last of two quick saves", async () => {
    const captured: PluginData[] = [];
    const { host, ipc } = setup({
      ipc: new FakeHostIpc({
        enabled: ["p"],
        plugins: [{ id: "p" }],
        data: { p: '{"existing":true}' },
      }),
      scripts: {
        p: (module, _e, require) => {
          const { Plugin } = require("obsidian");
          module.exports = class extends Plugin {
            async onload() {
              captured.push(this as unknown as PluginData);
            }
          };
        },
      },
    });
    await host.boot();
    const [plugin] = captured;
    expect(await plugin.loadData()).toEqual({ existing: true });
    const first = plugin.saveData({ n: 1 });
    const second = plugin.saveData({ n: 2, nested: { a: [1, 2] } });
    await Promise.all([first, second]);
    expect(JSON.parse(ipc.data.get("p")!)).toEqual({ n: 2, nested: { a: [1, 2] } });
    expect(await plugin.loadData()).toEqual({ n: 2, nested: { a: [1, 2] } });
  });

  it("loadData returns null without a data file and rejects on corrupt JSON", async () => {
    const captured: PluginData[] = [];
    const ipc = new FakeHostIpc({ enabled: ["p"], plugins: [{ id: "p" }] });
    const { host } = setup({
      ipc,
      scripts: {
        p: (module, _e, require) => {
          const { Plugin } = require("obsidian");
          module.exports = class extends Plugin {
            async onload() {
              captured.push(this as unknown as PluginData);
            }
          };
        },
      },
    });
    await host.boot();
    const [plugin] = captured;
    expect(await plugin.loadData()).toBeNull();
    ipc.data.set("p", "{not json");
    await expect(plugin.loadData()).rejects.toThrow(/p: data.json is not valid JSON/);
  });
});

describe("hand-written CJS plugin through the real loader path", () => {
  // Evaluated exactly like the Rust-wrapped main.js: a call to the global define with the factory.
  function wrapperLoader(sources: Record<string, string>): ScriptLoader {
    return async (url) => {
      const id = pluginUrlId(url);
      const body = sources[id];
      const script = `__writerPluginDefine(${JSON.stringify(id)}, function (module, exports, require, process, global, Buffer) {\n${body}\n});`;
      // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper exactly like a script tag would
      new Function(script)();
    };
  }

  it("registers a command and saves data (ES2015 class)", async () => {
    const source = `
      "use strict";
      const obsidian = require("obsidian");
      class HelloPlugin extends obsidian.Plugin {
        async onload() {
          const data = (await this.loadData()) || { runs: 0 };
          data.runs += 1;
          await this.saveData(data);
          this.addCommand({ id: "say-hello", name: "Say hello", callback: () => { global.__helloRan = true; } });
        }
      }
      module.exports = HelloPlugin;
    `;
    const ipc = new FakeHostIpc({ enabled: ["hello"], plugins: [{ id: "hello", name: "Hello" }] });
    const host = new PluginHost({
      ipc,
      io: createMemoryVaultIo(),
      loadScript: wrapperLoader({ hello: source }),
      styles: makeStyles().sink,
    });
    await host.boot();
    expect(host.getStatus("hello")).toEqual({ state: "enabled" });
    expect(JSON.parse(ipc.data.get("hello")!)).toEqual({ runs: 1 });
    expect(host.app.commands.executeCommandById("hello:say-hello")).toBe(true);
    expect((globalThis as any).__helloRan).toBe(true);
    delete (globalThis as any).__helloRan;
    await host.disable("hello");
    expect(host.app.commands.executeCommandById("hello:say-hello")).toBe(false);
  });

  it("supports ES5-style subclassing of Plugin and exports.default", async () => {
    const source = `
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var obsidian = require("obsidian");
      var Es5Plugin = (function (_super) {
        function Es5Plugin() { return _super !== null && _super.apply(this, arguments) || this; }
        Es5Plugin.prototype = Object.create(_super.prototype);
        Es5Plugin.prototype.constructor = Es5Plugin;
        Object.setPrototypeOf(Es5Plugin, _super);
        Es5Plugin.prototype.onload = function () {
          this.addCommand({ id: "es5", name: "ES5", callback: function () {} });
        };
        return Es5Plugin;
      })(obsidian.Plugin);
      exports.default = Es5Plugin;
    `;
    const ipc = new FakeHostIpc({ enabled: ["es5"], plugins: [{ id: "es5" }] });
    const host = new PluginHost({
      ipc,
      io: createMemoryVaultIo(),
      loadScript: wrapperLoader({ es5: source }),
      styles: makeStyles().sink,
    });
    await host.boot();
    expect(host.getStatus("es5")).toEqual({ state: "enabled" });
    expect(host.services.commands.has("es5:es5")).toBe(true);
  });
});
