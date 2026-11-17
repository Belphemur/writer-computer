import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { makeRequire } from "../web/host/modules";
import { COPILOT_DEVICE_ID_KEY, ensureDeviceId } from "../web/host/node/device-id";
import { EventEmitter } from "../web/host/node/events";
import { constants } from "../web/host/node/fs";
import { createProcessShim } from "../web/host/node/process";
import { installNodeGlobals } from "../web/host/node/runtime";
import { buildCopilotSeed, seedCopilotDataIfAbsent } from "../web/host/node/seed-plugin-data";
import { resetNodeRuntimeForTests } from "../web/host/node/state";
import { FakeNodeIpc } from "../web/host/node/testing";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";

beforeEach(() => resetNodeRuntimeForTests());

describe("registry coverage for the unmodified Copilot/SDK bundle", () => {
  const req = makeRequire("p", { o: 1 });
  it("resolves every id with and without node:, plus obsidian/@codemirror/@lezer", () => {
    const ids = [
      "async_hooks",
      "string_decoder",
      "url",
      "net",
      "process",
      "fs",
      "fs/promises",
      "module",
      "events",
      "buffer",
      "util",
      "path",
      "os",
      "crypto",
      "child_process",
      "readline",
      "stream",
      "http",
      "https",
      "zlib",
      "electron",
      "diagnostics_channel",
      "perf_hooks",
      "worker_threads",
      "tty",
      "v8",
      "vm",
      "constants",
      "querystring",
      "punycode",
      "domain",
      "timers",
      "timers/promises",
      "sys",
    ];
    for (const id of ids) {
      expect(req(id), id).toBeTruthy();
      expect(req(`node:${id}`), `node:${id}`).toBe(req(id));
    }
    expect(req("obsidian")).toEqual({ o: 1 });
    expect(req("@codemirror/state")).toBeTruthy();
    expect(req("@codemirror/view")).toBeTruthy();
    expect(req("@lezer/common")).toBeTruthy();
    expect(req("@lezer/highlight")).toBeTruthy();
    expect(req("@lezer/lr")).toBeTruthy();
    expect((req("module") as { createRequire(): unknown }).createRequire()).toBe(req);
  });

  it("url: URL, fileURLToPath, pathToFileURL, parse", () => {
    const url = req("url") as Record<string, any>;
    expect(url.fileURLToPath("file:///a/b%20c.txt")).toBe("/a/b c.txt");
    expect(url.pathToFileURL("/a/b c.txt").href).toBe("file:///a/b%20c.txt");
    expect(url.parse("https://u.test:8080/p?q=1#h")).toMatchObject({
      protocol: "https:",
      hostname: "u.test",
      port: "8080",
      pathname: "/p",
      search: "?q=1",
      hash: "#h",
    });
    expect(url.parse("/rel?x=1", true).query).toEqual({ x: "1" });
    expect(new url.URL("http://x")).toBeInstanceOf(URL);
  });

  it("net has isIP helpers and sockets are refused", () => {
    const net = req("net") as Record<string, any>;
    expect([net.isIP("1.2.3.4"), net.isIPv4("1.2.3"), net.isIPv6("::1"), net.isIP("x")]).toEqual([
      4,
      false,
      true,
      0,
    ]);
    expect(() => net.connect()).toThrow(/not supported/);
  });

  it("AsyncLocalStorage: run/getStore/exit/enterWith with a synchronous context", () => {
    const { AsyncLocalStorage } = req("async_hooks") as { AsyncLocalStorage: new () => any };
    const als = new AsyncLocalStorage();
    expect(als.getStore()).toBeUndefined();
    expect(als.run({ id: 1 }, () => als.run({ id: 2 }, () => als.getStore().id))).toBe(2);
    expect(als.getStore()).toBeUndefined();
    als.run("a", () => expect(als.exit(() => als.getStore())).toBeUndefined());
    als.enterWith("e");
    expect(als.getStore()).toBe("e");
  });
});

describe("module-scope needs of the SDK", () => {
  it("fs.constants has O_* values and sync probes never throw", () => {
    const fs = req_("fs");
    expect(fs.constants.O_NONBLOCK).toBeTypeOf("number");
    expect(fs.constants.O_NOFOLLOW).toBeTypeOf("number");
    expect(fs.constants.O_RDONLY).toBe(0);
    expect(constants.X_OK).toBe(1);
    expect(fs.existsSync("/never/probed")).toBe(false);
  });

  it("process.emitWarning does not throw; on('exit') is inert", () => {
    const p = createProcessShim();
    expect(() => p.emitWarning("w", { code: "X" })).not.toThrow();
    let fired = false;
    p.on("exit", () => (fired = true));
    p.exit(0);
    expect(fired).toBe(false);
    p.env.CLAUDE_AGENT_SDK_VERSION = "0.3.306"; // env is writable
    expect(p.env.CLAUDE_AGENT_SDK_VERSION).toBe("0.3.306");
  });

  it("SharedArrayBuffer stand-in is installed when missing and restored after", () => {
    const target: Record<string, unknown> = {};
    const un = installNodeGlobals(() => 0, target);
    const SAB = target.SharedArrayBuffer as new (n: number) => ArrayBuffer;
    expect(new Int32Array(new SAB(4)).length).toBe(1);
    un();
    expect("SharedArrayBuffer" in target).toBe(false);
    const real = class {};
    const t2: Record<string, unknown> = { SharedArrayBuffer: real };
    const un2 = installNodeGlobals(() => 0, t2);
    expect(t2.SharedArrayBuffer).toBe(real);
    un2();
  });

  it("window.require is installed alongside the global one and removed", () => {
    const win: Record<string, unknown> = {};
    const target: Record<string, unknown> = { window: win };
    const req = (() => 1) as never;
    const un = installNodeGlobals(req, target);
    expect(target.require).toBe(req);
    expect(win.require).toBe(req);
    un();
    expect("require" in win).toBe(false);
    expect("require" in target).toBe(false);
  });

  it("events statics: setMaxListeners, defaultMaxListeners, once, on", async () => {
    const original = EventEmitter.defaultMaxListeners;
    EventEmitter.setMaxListeners(20);
    expect(EventEmitter.defaultMaxListeners).toBe(20);
    const e = new EventEmitter();
    EventEmitter.setMaxListeners(5, e);
    expect(e.getMaxListeners()).toBe(5);
    EventEmitter.defaultMaxListeners = original;

    // Copilot's renderer shim assigns a wrapper over the writable static
    const wrapped = () => {};
    const ee = EventEmitter as unknown as { setMaxListeners: unknown };
    const prev = ee.setMaxListeners;
    ee.setMaxListeners = wrapped;
    expect(ee.setMaxListeners).toBe(wrapped);
    ee.setMaxListeners = prev;

    const ac = new AbortController();
    const it = EventEmitter.on(e, "tick", { signal: ac.signal });
    e.emit("tick", 1);
    e.emit("tick", 2);
    expect((await it.next()).value).toEqual([1]);
    expect((await it.next()).value).toEqual([2]);
    const pending = it.next();
    ac.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(e.listenerCount("tick")).toBe(0);
  });

  it("electron: ipcRenderer never throws synchronously, shell stays, remote undefined", async () => {
    const el = req_("electron");
    expect(el.ipcRenderer.sendSync("cli", null)).toBeUndefined();
    expect(() => el.ipcRenderer.send("x")).not.toThrow();
    expect(el.ipcRenderer.on("x", () => {})).toBe(el.ipcRenderer);
    expect(el.ipcRenderer.removeListener("x", () => {})).toBe(el.ipcRenderer);
    await expect(el.ipcRenderer.invoke("x")).rejects.toThrow(/not supported/);
    expect(el.remote).toBeUndefined();
    expect(typeof el.shell.openExternal).toBe("function");
  });
});
const req_ = (id: string): any => makeRequire("p", {})(id);

describe("device id", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };
  it("creates a UUIDv4 only when absent and keeps it stable", () => {
    const st = mem();
    const id = ensureDeviceId(st);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(st.m.get(COPILOT_DEVICE_ID_KEY)).toBe(id);
    expect(ensureDeviceId(st)).toBe(id);
    st.m.set(COPILOT_DEVICE_ID_KEY, "existing");
    expect(ensureDeviceId(st)).toBe("existing");
  });
  it("never throws on broken storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(ensureDeviceId(broken)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureDeviceId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Copilot data seed", () => {
  it("writes the seed once for copilot with the device id and claude path", async () => {
    const writes: string[] = [];
    const wrote = await seedCopilotDataIfAbsent({
      pluginId: "copilot",
      dataExists: async () => false,
      writeData: async (j) => void writes.push(j),
      claudePath: "/u/.local/bin/claude",
      deviceId: "dev-1",
    });
    expect(wrote).toBe(true);
    const seed = JSON.parse(writes[0]);
    expect(seed.settingsVersion).toBe(16);
    expect(seed.agentMode.activeBackend).toBe("claude");
    expect(seed.agentMode.deviceProfiles).toEqual({
      "dev-1": { claudeCliPath: "/u/.local/bin/claude" },
    });
    expect(seed.agentMode.debugFullFrames).toBe(false);
    expect(seed.autosaveChat).toBe(false);
  });

  it("omits deviceProfiles when claude is not found", () => {
    const seed = buildCopilotSeed(null, "d") as { agentMode: Record<string, unknown> };
    expect("deviceProfiles" in seed.agentMode).toBe(false);
  });

  it("never overwrites existing data and ignores other plugins", async () => {
    const writes: string[] = [];
    const args = {
      claudePath: "/c",
      deviceId: "d",
      writeData: async (j: string) => void writes.push(j),
    };
    expect(
      await seedCopilotDataIfAbsent({ ...args, pluginId: "copilot", dataExists: async () => true }),
    ).toBe(false);
    expect(
      await seedCopilotDataIfAbsent({ ...args, pluginId: "other", dataExists: async () => false }),
    ).toBe(false);
    expect(writes).toEqual([]);
  });

  describe("wired into the loader", () => {
    const g = globalThis as unknown as { __writerPluginDefine: (id: string, f: unknown) => void };
    const loader: ScriptLoader = async (url) => {
      const id = decodeURIComponent(url.split("/")[3]);
      g.__writerPluginDefine(
        id,
        (module: { exports: unknown }, _e: unknown, require: (n: string) => any) => {
          const { Plugin } = require("obsidian");
          module.exports = class extends Plugin {
            async onload() {
              (globalThis as Record<string, unknown>).__dataAtLoad = await this.loadData();
              (globalThis as Record<string, unknown>).__deviceAtLoad = this.app.loadLocalStorage(
                "obsidian-copilot:device-id:v1",
              );
            }
          };
        },
      );
    };
    const make = (ipc: FakeHostIpc) =>
      new PluginHost({
        ipc,
        io: createMemoryVaultIo({}),
        loadScript: loader,
        styles: { add: () => () => {} },
        nodeIpc: new FakeNodeIpc(),
        nodeGlobalTarget: {},
      });

    it("seeds before onload on first enable, and not on later loads", async () => {
      const store = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      });
      const ipc = new FakeHostIpc({
        enabled: ["copilot"],
        plugins: [{ id: "copilot", name: "C" }],
      });
      const host = make(ipc);
      await host.boot();
      expect(host.getStatus("copilot")).toEqual({ state: "enabled" });
      const first = JSON.parse(ipc.data.get("copilot")!);
      expect(first.settingsVersion).toBe(16);
      expect(
        first.agentMode.deviceProfiles[Object.keys(first.agentMode.deviceProfiles)[0]]
          .claudeCliPath,
      ).toBe("/Users/test/.local/bin/claude");
      expect((globalThis as Record<string, unknown>).__dataAtLoad).toEqual(first); // visible to onload
      // Copilot reads its device id through app.loadLocalStorage: the seeded profile key must be it.
      expect(Object.keys(first.agentMode.deviceProfiles)).toEqual([
        (globalThis as Record<string, unknown>).__deviceAtLoad,
      ]);
      ipc.data.set("copilot", '{"mine":true}');
      await host.disable("copilot");
      await host.enable("copilot");
      expect(ipc.data.get("copilot")).toBe('{"mine":true}'); // never overwritten
      await host.shutdown();
      delete (globalThis as Record<string, unknown>).__dataAtLoad;
      vi.unstubAllGlobals();
    });

    it("does not seed other plugins", async () => {
      const ipc = new FakeHostIpc({ enabled: ["zzz"], plugins: [{ id: "zzz", name: "Z" }] });
      const host = make(ipc);
      await host.boot();
      expect(ipc.data.has("zzz")).toBe(false);
      await host.shutdown();
      delete (globalThis as Record<string, unknown>).__dataAtLoad;
    });
  });
});
