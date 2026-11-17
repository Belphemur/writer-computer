// @vitest-environment jsdom
// "The completion sound keeps firing": a fixture plugin mimics the Agent Chat flow (spawn a fake
// agent, read stdout lines, play a Web Audio tone when a `result` line arrives) and the tests
// count tones per finished turn, so any host amplification (replayed output, listeners surviving
// a reload, duplicated exit) shows up as a count above one. Also covers the opt-in media trace and
// the sound-storm warning. Synthetic fixtures only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PluginHost, type ScriptLoader } from "../web/host/loader";
import { resetMediaTrace, SOUND_STORM_PLAYS } from "../web/host/api/media-trace";
import { resetNodeRuntimeForTests } from "../web/host/node/state";
import { FakeNodeIpc, flush, type FakeProc } from "../web/host/node/testing";
import { createMemoryVaultIo, FakeHostIpc } from "../web/host/testing";

const w = window as unknown as Record<string, any>;
let starts = 0;
let contexts = 0;

const FIXTURE = `
const obsidian = require("obsidian");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
class Plugin2 extends obsidian.Plugin {
  async onload() {
    this.finished = 0;
    this.addCommand({ id: "ask", name: "ask", callback: () => this.ask() });
    globalThis.__fx = this;
  }
  ask() {
    const child = spawn("claude", [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout });
    let busy = false;
    rl.on("line", (l) => {
      const m = JSON.parse(l);
      if (m.type === "state" && m.state === "running") busy = true;
      if (m.type === "state" && m.state === "idle" && busy) { busy = false; this.finished++; this.beep(); }
    });
    child.on("exit", () => { this.exited = (this.exited || 0) + 1; });
    child.stdin.write(JSON.stringify({ type: "user" }) + "\\n");
  }
  beep() {
    const ctx = (this.ctx ??= new AudioContext());
    for (const hz of [440, 660]) { const o = ctx.createOscillator(); o.start(0); }
  }
}
module.exports = Plugin2;`;

const loader: ScriptLoader = async (url) => {
  const id = decodeURIComponent(url.split("/")[3]);
  const script = `__writerPluginDefine(${JSON.stringify(id)}, function (module, exports, require, process, global, Buffer) {\n${FIXTURE}\n});\n//# sourceURL=writer-plugin://localhost/${id}/main.js`;
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper like a script tag
  new Function(script)();
};

const turn = (p: FakeProc, chunking = 5) => {
  const out =
    [
      { type: "state", state: "running" },
      { type: "assistant" },
      { type: "result" },
      { type: "state", state: "idle" },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n";
  for (let i = 0; i < out.length; i += chunking) p.stdout(out.slice(i, i + chunking));
};

async function boot() {
  resetNodeRuntimeForTests();
  const nodeIpc = new FakeNodeIpc();
  nodeIpc.probes["/Users/test/.local/bin/claude"] = { exists: true, is_file: true };
  const host = new PluginHost({
    ipc: new FakeHostIpc({ enabled: ["fx"], plugins: [{ id: "fx", name: "FX" }] }),
    io: createMemoryVaultIo({}),
    loadScript: loader,
    styles: { add: () => () => {} },
    nodeIpc,
    nodeGlobalTarget: {},
  });
  await host.boot();
  return { host, nodeIpc };
}
const plugin = () => (globalThis as any).__fx;

beforeEach(() => {
  starts = 0;
  contexts = 0;
  w.AudioScheduledSourceNode = class {
    start() {
      starts++;
    }
  };
  w.AudioContext = class {
    constructor() {
      contexts++;
    }
    createOscillator() {
      return new w.AudioScheduledSourceNode();
    }
  };
  resetMediaTrace();
});
afterEach(() => {
  delete w.AudioContext;
  delete w.AudioScheduledSourceNode;
  vi.restoreAllMocks();
  localStorage.removeItem("writer.hostMediaTrace");
});

describe("one completion, one sound", () => {
  it("a turn delivered in any chunking sounds exactly once; exit adds nothing", async () => {
    for (const chunking of [1, 3, 17, 10_000]) {
      const { host, nodeIpc } = await boot();
      plugin().ask();
      await flush();
      turn(nodeIpc.procs[0], chunking);
      await flush(5);
      nodeIpc.procs[0].exit(0);
      await flush(5);
      expect(plugin().finished, `chunking ${chunking}`).toBe(1);
      expect(plugin().exited).toBe(1);
      expect(contexts).toBe(1);
      await host.shutdown();
      starts = 0;
      contexts = 0;
    }
  });

  it("several turns on one process sound once each; a restart and a disable/enable add no echoes", async () => {
    const { host, nodeIpc } = await boot();
    plugin().ask();
    await flush();
    for (let i = 0; i < 3; i++) {
      turn(nodeIpc.procs[0]);
      await flush(5);
    }
    expect(plugin().finished).toBe(3);
    nodeIpc.procs[0].exit(0);
    await flush(5);
    plugin().ask(); // session restart: a second process
    await flush();
    turn(nodeIpc.procs[1]);
    await flush(5);
    expect(plugin().finished).toBe(4);
    await host.disable("fx");
    await host.enable("fx");
    nodeIpc.procs[1].exit(0);
    await flush(5);
    expect(starts).toBe(4 * 2);
    await host.shutdown();
  });
});

describe("media trace", () => {
  it("always logs each sound with the plugin id (no flag: the release app has no console)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, nodeIpc } = await boot();
    plugin().ask();
    await flush();
    turn(nodeIpc.procs[0]);
    await flush(5);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[plugin] sound: AudioScheduledSourceNode.start from fx");
    expect(lines.join("\n")).not.toContain("sound storm");
    await host.shutdown();
  });

  it("warns once the same plugin plays more than the threshold in the window, and still plays", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, nodeIpc } = await boot();
    plugin().ask();
    await flush();
    for (let i = 0; i < SOUND_STORM_PLAYS; i++) {
      turn(nodeIpc.procs[0]);
      await flush(200);
    }
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("sound storm");
    turn(nodeIpc.procs[0]);
    await flush(5);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("sound storm: fx");
    expect(plugin().finished).toBe(SOUND_STORM_PLAYS + 1);
    await host.shutdown();
  });
});
