import { describe, expect, it } from "vite-plus/test";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { Buffer } from "../web/host/node/buffer";
import { getSharedProcess } from "../web/host/node/process";
import { resetNodeRuntimeForTests } from "../web/host/node/state";
import { FakeNodeIpc, flush, type FakeProc } from "../web/host/node/testing";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";

/** A CJS "fake SDK" in the shape the Claude Agent SDK uses: spawn + readline + stdin JSON lines. */
const FAKE_SDK = `
"use strict";
const obsidian = require("obsidian");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { StringDecoder } = require("node:string_decoder");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

async function query(prompt) {
  const claude = path.join(os.homedir(), ".local", "bin", "claude");
  const child = spawn(claude, ["--output-format", "stream-json", "--input-format", "stream-json"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MARK: "sdk" },
    windowsHide: true,
  });
  let stderr = "";
  const decoder = new StringDecoder("utf8");
  child.stderr.on("data", (d) => { stderr += decoder.write(d); });
  const exited = new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", reject);
  });
  const rl = createInterface(child.stdout);
  function createInterface(input) { return readline.createInterface({ input }); }

  const id = crypto.randomBytes(4).toString("hex");
  child.stdin.write(JSON.stringify({ type: "user", id, text: prompt }) + "\\n");
  const replies = [];
  for await (const line of rl) {
    const msg = JSON.parse(line);
    replies.push(msg);
    if (msg.type === "result") break;
  }
  child.stdin.write(JSON.stringify({ type: "user", id, text: "second" }) + "\\n");
  for await (const line of readline.createInterface({ input: child.stdout })) {
    replies.push(JSON.parse(line));
    break;
  }
  const killed = child.kill("SIGTERM");
  const result = await exited;
  return { replies, killed, exit: result, stderr, id, wasKilled: child.killed, signalCode: child.signalCode };
}

class SdkPlugin extends obsidian.Plugin {
  async onload() {
    globalThis.__sdkSeen = {
      platform: process.platform,
      cwd: process.cwd(),
      versionsNode: process.versions.node,
      isBuffer: Buffer.isBuffer(Buffer.from("x")),
      desktopApp: obsidian.Platform.isDesktopApp,
      adapterBase: this.app.vault.adapter.getBasePath(),
      instanceOfFsa: this.app.vault.adapter instanceof obsidian.FileSystemAdapter,
      claudeExists: require("fs").existsSync(require("os").homedir() + "/.local/bin/claude"),
      pathEnv: process.env.PATH,
    };
    globalThis.__sdkResult = await query("hello");
  }
}
module.exports = SdkPlugin;
`;

function fakeClaude(proc: FakeProc): void {
  proc.onStdin = (text) => {
    const msg = JSON.parse(text.trim());
    const out =
      msg.text === "hello"
        ? [
            { type: "system", subtype: "init", cwd: proc.request.cwd },
            { type: "assistant", text: `echo:${msg.text}` },
            { type: "result", ok: true },
          ]
        : [{ type: "assistant", text: `echo:${msg.text}` }];
    const data = out.map((o) => JSON.stringify(o)).join("\n") + "\n";
    // chunk it awkwardly: mid-line splits, one multi-byte-safe chunk boundary
    const cuts = [7, 31, 32, 80];
    let last = 0;
    for (const c of [...cuts.filter((c) => c < data.length), data.length]) {
      proc.stdout(data.slice(last, c));
      last = c;
    }
  };
}

const g = globalThis as unknown as {
  __writerPluginDefine: (id: string, factory: unknown) => void;
  __sdkSeen?: Record<string, unknown>;
  __sdkResult?: any;
};

function sourceLoader(sources: Record<string, string>): ScriptLoader {
  return async (url) => {
    const id = decodeURIComponent(url.split("/")[3]);
    const script = `__writerPluginDefine(${JSON.stringify(id)}, function (module, exports, require, process, global, Buffer) {\n${sources[id]}\n});\n//# sourceURL=writer-plugin://localhost/${id}/main.js`;
    // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper exactly like a script tag would
    new Function(script)();
  };
}

describe("fake SDK through the loader", () => {
  it("spawns a fake claude, reads lines with for-await, writes JSON lines, kills it", async () => {
    resetNodeRuntimeForTests();
    delete g.__sdkSeen;
    delete g.__sdkResult;
    const nodeIpc = new FakeNodeIpc();
    nodeIpc.probes["/vault"] = { exists: true, is_dir: true };
    nodeIpc.probes["/Users/test/.local/bin/claude"] = { exists: true, is_file: true };
    nodeIpc.whichMap.claude = "/Users/test/.local/bin/claude";
    const target: Record<string, unknown> = {};
    const states: string[] = [];
    nodeIpc.onSpawn = (p) => {
      states.push(`spawn:${Object.getOwnPropertyNames(target).sort().join(",")}`);
      fakeClaude(p);
    };

    const host = new PluginHost({
      ipc: new FakeHostIpc({ enabled: ["sdk"], plugins: [{ id: "sdk", name: "SDK" }] }),
      io: createMemoryVaultIo({ "a.md": "# A" }),
      loadScript: sourceLoader({ sdk: FAKE_SDK }),
      styles: { add: () => () => {} },
      nodeIpc,
      nodeGlobalTarget: target,
    });

    // The query kills the child with SIGTERM and awaits 'exit': play the OS's part.
    const finishWhenKilled = (async () => {
      for (let i = 0; i < 200 && !(nodeIpc.procs[0]?.kills.length > 0); i++) await flush(1);
      nodeIpc.procs[0].exit(null, "SIGTERM");
    })();
    await host.boot();
    await finishWhenKilled;

    expect(host.getStatus("sdk")).toEqual({ state: "enabled" });
    const seen = g.__sdkSeen!;
    expect(seen).toMatchObject({
      platform: "darwin",
      cwd: "/vault",
      isBuffer: true,
      desktopApp: true,
      adapterBase: "/vault",
      instanceOfFsa: true,
      claudeExists: true,
      pathEnv: "/opt/bin:/usr/bin",
    });
    expect(seen.versionsNode).toBeUndefined();

    const proc = nodeIpc.procs[0];
    expect(proc.request).toMatchObject({
      plugin_id: "sdk",
      command: "/Users/test/.local/bin/claude",
      args: ["--output-format", "stream-json", "--input-format", "stream-json"],
      cwd: "/vault",
      inherit_env: false,
      stdin: "pipe",
    });
    expect(proc.request.env).toMatchObject({
      MARK: "sdk",
      PATH: "/opt/bin:/usr/bin",
      HOME: "/Users/test",
    });
    expect(proc.stdinWrites).toHaveLength(2);
    expect(JSON.parse(proc.stdinWrites[0])).toMatchObject({ type: "user", text: "hello" });

    const r = g.__sdkResult;
    expect(r.replies).toEqual([
      { type: "system", subtype: "init", cwd: "/vault" },
      { type: "assistant", text: "echo:hello" },
      { type: "result", ok: true },
      { type: "assistant", text: "echo:second" },
    ]);
    expect(r.killed).toBe(true);
    expect(r.wasKilled).toBe(true);
    expect(r.signalCode).toBe("SIGTERM");
    expect(r.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(proc.kills).toEqual([{ signal: "SIGTERM", group: true }]);

    // process/Buffer/require were real globals while the plugin was loaded, before its script ran
    expect(states[0]).toBe("spawn:Buffer,SharedArrayBuffer,process,require");
    expect(target.process).toBe(getSharedProcess());
    expect(target.Buffer).toBe(Buffer);
    expect(typeof target.require).toBe("function");
    expect(typeof (target.require as (id: string) => unknown)("node:child_process")).toBe("object");

    await host.disable("sdk");
    expect(Object.getOwnPropertyNames(target)).toEqual([]); // restored on the last teardown
    await host.shutdown();
  });

  it("the bare global require identifies the calling plugin from the script's sourceURL", async () => {
    resetNodeRuntimeForTests();
    const nodeIpc = new FakeNodeIpc();
    const target: Record<string, unknown> = {};
    const src = `
      const obsidian = require("obsidian");
      module.exports = class extends obsidian.Plugin {
        async onload() {
          const { spawn } = globalThis.__targetRequire("child_process");
          spawn("claude", ["--version"]);
          this.register(() => { globalThis.__unloaded = true; });
        }
      };`;
    (globalThis as Record<string, unknown>).__targetRequire = (id: string) =>
      (target.require as (id: string) => unknown)(id);
    const host = new PluginHost({
      ipc: new FakeHostIpc({ enabled: ["bundled"], plugins: [{ id: "bundled", name: "Bundled" }] }),
      io: createMemoryVaultIo({}),
      loadScript: sourceLoader({ bundled: src }),
      styles: { add: () => () => {} },
      nodeIpc,
      nodeGlobalTarget: target,
    });
    await host.boot();
    expect(host.getStatus("bundled")).toEqual({ state: "enabled" });
    expect(nodeIpc.procs[0].request.plugin_id).toBe("bundled");
    await host.shutdown();
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
    delete (globalThis as Record<string, unknown>).__targetRequire;
    delete (globalThis as Record<string, unknown>).__unloaded;
  });

  it("two hosts sharing a target keep the globals until the last plugin unloads", async () => {
    resetNodeRuntimeForTests();
    const target: Record<string, unknown> = {};
    const mk = (id: string) =>
      new PluginHost({
        ipc: new FakeHostIpc({ enabled: [id], plugins: [{ id, name: id }] }),
        io: createMemoryVaultIo({}),
        loadScript: sourceLoader({
          [id]: `const o = require("obsidian"); module.exports = class extends o.Plugin {};`,
        }),
        styles: { add: () => () => {} },
        nodeIpc: new FakeNodeIpc(),
        nodeGlobalTarget: target,
      });
    const a = mk("a");
    const b = mk("b");
    await a.boot();
    await b.boot();
    expect(Object.getOwnPropertyNames(target).sort()).toEqual([
      "Buffer",
      "SharedArrayBuffer",
      "process",
      "require",
    ]);
    await a.shutdown();
    expect(Object.getOwnPropertyNames(target).sort()).toEqual([
      "Buffer",
      "SharedArrayBuffer",
      "process",
      "require",
    ]);
    await b.shutdown();
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
  });

  it("a plugin script never evaluates before the node runtime is preloaded", async () => {
    resetNodeRuntimeForTests();
    const nodeIpc = new FakeNodeIpc();
    let osInfoResolved = false;
    const real = nodeIpc.osInfo.bind(nodeIpc);
    nodeIpc.osInfo = async () => {
      await flush(15);
      osInfoResolved = true;
      return real();
    };
    let sawResolved: boolean | null = null;
    const host = new PluginHost({
      ipc: new FakeHostIpc({ enabled: ["early"], plugins: [{ id: "early", name: "e" }] }),
      io: createMemoryVaultIo({}),
      loadScript: async (url) => {
        sawResolved = osInfoResolved;
        await sourceLoader({
          early: `const o = require("obsidian"); module.exports = class extends o.Plugin { async onload() { globalThis.__home = require("os").homedir(); } };`,
        })(url);
      },
      styles: { add: () => () => {} },
      nodeIpc,
      nodeGlobalTarget: {},
    });
    await host.boot();
    expect(sawResolved).toBe(true);
    expect((globalThis as Record<string, unknown>).__home).toBe("/Users/test");
    delete (globalThis as Record<string, unknown>).__home;
    await host.shutdown();
  });
});
