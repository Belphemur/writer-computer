// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as lezerLr from "@lezer/lr";
import { moment } from "../src/lib/obsidian-host/api/functions";
import { ToggleComponent } from "../src/lib/obsidian-host/api/ui";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { makeRequire, UnsupportedModuleError } from "../src/lib/obsidian-host/modules";
import { NODE_MODULE_IDS } from "../src/lib/obsidian-host/node/registry";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";

type W = Record<string, any>;
const win = window as unknown as W;
const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

/** Fixture plugins whose onload runs the same calls as the real failing code paths. */
function hostWith(bodies: Record<string, (w: W, require: (n: string) => any) => void>): PluginHost {
  const loadScript: ScriptLoader = async (url) => {
    const id = decodeURIComponent(url.split("/")[3]);
    g.__writerPluginDefine(id, (module: { exports: unknown }, _e: unknown, require: any) => {
      const { Plugin: P } = require("obsidian");
      module.exports = class extends P {
        async onload() {
          bodies[id](window as unknown as W, require);
        }
      };
    });
  };
  const ids = Object.keys(bodies);
  return new PluginHost({
    ipc: new FakeHostIpc({ enabled: ids, plugins: ids.map((id) => ({ id, name: id })) }),
    io: createMemoryVaultIo({ "a.md": "# A" }),
    loadScript,
    styles: { add: () => () => {} },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("legacy window globals", () => {
  it("serves CodeMirror 5 registries (dataview, meta-bind, templater paths) and removes them", async () => {
    expect("CodeMirror" in win).toBe(false);
    const seen: Record<string, unknown> = {};
    const host = hostWith({
      cm: (w) => {
        // dataview / meta-bind: define a mode that delegates to another one, then resolve it.
        w.CodeMirror.defineMode("dataviewjs", (config: object) =>
          w.CodeMirror.getMode(config, "javascript"),
        );
        w.CodeMirror.defineMode("meta-bind", () => ({ token: () => null }));
        // templater: its bundled JS mode assigns onto the global and registers helpers/MIMEs.
        w.CodeMirror.defineMode("javascript", () => ({}));
        w.CodeMirror.registerHelper("wordChars", "javascript", /[\w$]/);
        w.CodeMirror.defineMIME("text/javascript", "javascript");
        w.CodeMirror.defineMIME("application/json", { name: "javascript", json: true });
        w.CodeMirror.customOverlayMode = () => ({});
        seen.js = w.CodeMirror.getMode({}, "javascript");
        seen.mime = w.CodeMirror.getMode({}, "text/javascript");
        seen.json = w.CodeMirror.getMode({}, "application/json");
        seen.missing = w.CodeMirror.getMode({}, "nope");
        seen.state = w.CodeMirror.startState(seen.js);
        seen.copy = w.CodeMirror.copyState({ startState: () => 1 }, { a: [1], b: 2 });
        seen.registered = Object.keys(w.CodeMirror.modes);
        seen.pos = new w.CodeMirror.Pos(1, 2);
        // inert mode is a valid CM6 StreamLanguage token function input
        const stream = { skipToEnd: vi.fn() };
        seen.token = (seen.js as any).token(stream);
        seen.skipped = stream.skipToEnd.mock.calls.length;
        // linter: vim save command
        w.CodeMirrorAdapter.commands.save = () => {};
        seen.save = typeof w.CodeMirrorAdapter.commands.save;
        w.CodeMirrorAdapter.Vim.defineEx("write", "w", () => {});
        seen.handled = w.CodeMirrorAdapter.Vim.handleKey({}, "i", "mapping");
      },
    });
    await host.boot();
    expect(host.getStatus("cm")).toEqual({ state: "enabled" });
    expect((seen.js as any).name).toBe("javascript");
    expect((seen.mime as any).name).toBe("javascript");
    expect((seen.json as any).name).toBe("javascript");
    expect((seen.missing as any).name).toBe("null");
    expect(seen.state).toBe(true);
    expect(seen.copy).toEqual({ a: [1], b: 2 });
    expect(seen.registered).toEqual(["dataviewjs", "meta-bind", "javascript"]);
    expect(seen.pos).toMatchObject({ line: 1, ch: 2 });
    expect(seen.token).toBeNull();
    expect(seen.skipped).toBe(1);
    expect(seen.save).toBe("function");
    expect(seen.handled).toBeUndefined();
    await host.shutdown();
    expect("CodeMirror" in win).toBe(false);
    expect("CodeMirrorAdapter" in win).toBe(false);
  });

  it("exposes the module's moment as window.moment while plugins are loaded", async () => {
    let calls: unknown;
    const host = hostWith({
      tasks: (w) => {
        calls = [w.moment === moment, typeof w.moment().format()];
      },
    });
    expect("moment" in win).toBe(false);
    await host.boot();
    expect(host.getStatus("tasks")).toEqual({ state: "enabled" });
    expect(calls).toEqual([true, "string"]);
    await host.shutdown();
    expect("moment" in win).toBe(false);
  });

  it("exposes the host App as a bare `app` global and removes it", async () => {
    let same = false;
    const host = hostWith({
      extractor: (w) => {
        // text-extractor reads the bare identifier `app`, not `this.app`.
        same = new Function("return app")() === host.app && w.app === host.app;
      },
    });
    expect("app" in win).toBe(false);
    await host.boot();
    expect(host.getStatus("extractor")).toEqual({ state: "enabled" });
    expect(same).toBe(true);
    await host.disable("extractor");
    expect("app" in win).toBe(false);
    expect(() => new Function("return app")()).toThrow(ReferenceError);
  });

  it("never overwrites or removes a global the page already has", async () => {
    win.moment = "page-moment";
    const host = hostWith({ p: () => {} });
    await host.boot();
    expect(win.moment).toBe("page-moment");
    await host.shutdown();
    expect(win.moment).toBe("page-moment");
    delete win.moment;
  });
});

describe("node builtin shims", () => {
  const req = makeRequire("p", {});

  it("diagnostics_channel: channels never have subscribers; tracingChannel runs the function", () => {
    for (const id of ["diagnostics_channel", "node:diagnostics_channel"]) {
      const dc = req(id) as any;
      const ch = dc.channel("undici:request:create");
      expect(dc.channel("undici:request:create")).toBe(ch);
      expect(ch.hasSubscribers).toBe(false);
      expect(dc.hasSubscribers("x")).toBe(false);
      const fn = vi.fn();
      ch.subscribe(fn);
      ch.publish({ a: 1 });
      expect(fn).not.toHaveBeenCalled();
      expect(ch.unsubscribe(fn)).toBe(false);
      dc.subscribe("x", fn);
      expect(dc.unsubscribe("x", fn)).toBe(false);
      const tc = dc.tracingChannel("fetch");
      expect(tc.start.name).toBe("tracing:fetch:start");
      expect(tc.hasSubscribers).toBe(false);
      expect(tc.traceSync((a: number, b: number) => a + b, {}, null, 1, 2)).toBe(3);
    }
  });

  it("covers the cheap builtins and keeps the rest unsupported", async () => {
    expect((req("worker_threads") as any).isMainThread).toBe(true);
    expect(() => new (req("worker_threads") as any).Worker()).toThrow(/not supported/);
    expect((req("perf_hooks") as any).performance).toBe(globalThis.performance);
    expect((req("tty") as any).isatty(1)).toBe(false);
    expect((req("v8") as any).getHeapStatistics().used_heap_size).toBe(0);
    expect(() => (req("vm") as any).runInNewContext("1")).toThrow(/not supported/);
    expect(req("sys") as any).toBe(req("util"));
    const qs = req("querystring") as any;
    expect(qs.parse("a=1&a=2&b=x+y")).toEqual({ a: ["1", "2"], b: "x y" });
    expect(qs.stringify({ a: [1, 2], b: "x y" })).toBe("a=1&a=2&b=x%20y");
    const pc = req("punycode") as any;
    expect(pc.toASCII("mañana.com")).toBe("xn--maana-pta.com");
    expect(pc.toUnicode("xn--maana-pta.com")).toBe("mañana.com");
    const d = (req("domain") as any).create();
    expect(d.run((x: number) => x * 2, 4)).toBe(8);
    const tp = req("timers/promises") as any;
    await expect(tp.setTimeout(1, "v")).resolves.toBe("v");
    const ac = new AbortController();
    ac.abort();
    await expect(tp.setTimeout(1, "v", { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    // still failing for what Writer cannot do
    for (const id of ["tls", "dns", "dgram", "http2", "cluster", "inspector", "node:repl"]) {
      expect(NODE_MODULE_IDS.includes(id)).toBe(false);
      expect(() => req(id)).toThrow(/Cannot find module/);
    }
  });
});

describe("editor modules offered to plugins", () => {
  const req = makeRequire("excalidraw", {});

  it("provides @lezer/lr from the app's own copy", () => {
    expect(req("@lezer/lr")).toBe(lezerLr);
  });

  it("provides the sample plugin's externals except @codemirror/collab", () => {
    for (const id of [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ])
      expect(req(id), id).toBeTruthy();
    expect(() => req("@codemirror/collab")).toThrow(UnsupportedModuleError);
  });
});

describe("ToggleComponent compat", () => {
  it("has setTooltip and onClick like the public typings", () => {
    const el = document.createElement("div");
    const t = new ToggleComponent(el);
    const seen: boolean[] = [];
    t.onChange((v) => void seen.push(v));
    expect(t.setTooltip("Skip top heading level")).toBe(t);
    expect(t.toggleEl.getAttribute("aria-label")).toBe("Skip top heading level");
    t.onClick();
    expect(seen).toEqual([true]);
  });
});

describe("YAML template placeholders", () => {
  it("parse without the `mapAsMap` console warning", async () => {
    const { parseYaml } = await import("../src/lib/obsidian-host/api/functions");
    const { parseYamlEntries } = await import("../src/lib/yaml-entries");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseYaml("created: {{date}}\ntitle: x");
    parseYamlEntries("created: {{date}}");
    expect(warn).not.toHaveBeenCalled();
  });
});
