// @vitest-environment jsdom
// "Copilot re-seeds its skills folder forever": a fixture plugin mimics the SkillManager pattern
// (subscribe to vault create/delete/modify, ignore events while its own mutation runs, otherwise
// reconcile after a debounce; a reconcile rewrites a builtin skill only when its version marker
// is stale or a file is missing) on the real host event path. The watcher echoes of the plugin's
// own writes arrive late, as they do from the OS, and the plugin must settle. Also covers the
// churn guard that names a plugin whose own changes keep re-triggering it. Synthetic fixtures only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sent = vi.hoisted(() => [] as { level: string; plugin?: string; message: string }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { entries: never[] }) => {
    if (cmd === "log_event") sent.push(...args.entries);
  }),
}));

import { logger } from "../src/lib/logger";
import {
  CHURN_LONG_MAX,
  CHURN_SHORT_MAX,
  recordPluginMutation,
  resetChurnGuard,
} from "../src/lib/obsidian-host/api/churn-guard";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { resetNodeRuntimeForTests } from "../src/lib/obsidian-host/node/state";
import { FakeNodeIpc } from "../src/lib/obsidian-host/node/testing";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";

const FIXTURE = `
const obsidian = require("obsidian");
const VERSION = 10;
const FILES = ["web-search.sh", "web-search.cmd"];
const marker = (t) => { const m = /copilot-builtin-version: "(\\d+)"/.exec(t); return m ? Number(m[1]) : null; };
class SkillSeeder extends obsidian.Plugin {
  async onload() {
    this.writes = 0; this.passes = 0; this.depth = 0; this.timer = null; this.wanted = true;
    const v = this.app.vault;
    const on = (p) => { if (this.depth > 0) return; if (p.startsWith("skills")) this.schedule(); };
    for (const ev of ["create", "delete", "modify"]) this.registerEvent(v.on(ev, (f) => on(f.path)));
    this.registerEvent(v.on("rename", (f) => on(f.path)));
    globalThis.__seeder = this;
    await this.reconcile();
  }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.reconcile(), 250); }
  async reconcile() {
    this.passes++;
    this.depth++;
    try { await this.seed("skills/web-search"); } finally { this.depth--; }
  }
  async seed(dir) {
    const a = this.app.vault.adapter;
    const md = dir + "/SKILL.md";
    let ok = false;
    if (!this.wanted) { if (await a.exists(md)) { await this.rm(dir); } return; }
    if (await a.exists(md)) {
      const v = marker(await a.read(md));
      if (v === null) return;
      if (v >= VERSION) ok = (await Promise.all(FILES.map((f) => a.exists(dir + "/" + f)))).every(Boolean);
    }
    if (ok) return;
    if (await a.exists(dir)) await this.rm(dir);
    await a.mkdir("skills"); await a.mkdir(dir);
    for (const f of FILES) { await a.write(dir + "/" + f, "echo " + f); this.writes++; }
    await a.write(md, '---\\nmetadata:\\n  copilot-builtin-version: "' + VERSION + '"\\n---\\nbody'); this.writes++;
  }
  async rm(dir) {
    const a = this.app.vault.adapter;
    const l = await a.list(dir);
    for (const d of l.folders) await a.rmdir(d, true);
    for (const f of l.files) if (!f.endsWith("SKILL.md")) await a.remove(f);
    await a.rmdir(dir, true);
  }
  // A loop: every modify of the file rewrites it.
  loopOnModify(path) {
    this.registerEvent(this.app.vault.on("modify", async (f) => { if (f.path === path) await this.app.vault.adapter.write(path, "x" + Math.random()); }));
  }
  spam(path, n) { return (async () => { for (let i = 0; i < n; i++) await this.app.vault.adapter.write(path, "v" + i); })(); }
}
module.exports = SkillSeeder;`;

const loader: ScriptLoader = async (url) => {
  const id = decodeURIComponent(url.split("/")[3]);
  const script = `__writerPluginDefine(${JSON.stringify(id)}, function (module, exports, require, process, global, Buffer) {\n${FIXTURE}\n});\n//# sourceURL=writer-plugin://localhost/${id}/main.js`;
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the wrapper like a script tag
  new Function(script)();
};

const seeder = () => (globalThis as any).__seeder;

async function boot(files: Record<string, string> = {}) {
  resetNodeRuntimeForTests();
  const io = createMemoryVaultIo(files);
  const host = new PluginHost({
    ipc: new FakeHostIpc({ enabled: ["seeder"], plugins: [{ id: "seeder", name: "Seeder" }] }),
    io,
    loadScript: loader,
    styles: { add: () => () => {} },
    nodeIpc: new FakeNodeIpc(),
    nodeGlobalTarget: {},
  });
  await host.boot();
  host.app.workspace.markLayoutReady();
  return { host, io };
}

/** What the OS watcher reports for everything under `dir`, after the plugin's mutation ended. */
async function echoWatcher(host: PluginHost, io: ReturnType<typeof createMemoryVaultIo>) {
  const paths = [...io.folders, ...io.files.keys()].sort();
  for (const p of paths) await host.app.vault.notifyExternal("create", p);
  for (const p of paths) await host.app.vault.notifyExternal("modify", p);
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetChurnGuard();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a skill seeder settles on the real host event path", () => {
  it("seeds once; late watcher echoes of its own writes cause no further writes", async () => {
    const { host, io } = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    const afterSeed = seeder().writes;
    expect(afterSeed).toBe(3);
    for (let round = 0; round < 6; round++) {
      await echoWatcher(host, io);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(seeder().writes).toBe(afterSeed);
    expect(seeder().passes).toBeLessThan(10);
    await host.shutdown();
  });

  it("a stale version is upgraded exactly once, then it is quiet", async () => {
    const stale = '---\nmetadata:\n  copilot-builtin-version: "3"\n---\nold';
    const { host, io } = await boot({
      "skills/web-search/SKILL.md": stale,
      "skills/web-search/web-search.sh": "old",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seeder().writes).toBe(3);
    for (let round = 0; round < 4; round++) {
      await echoWatcher(host, io);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(seeder().writes).toBe(3);
    await host.shutdown();
  });

  it("a foreign actor that deletes the folder each time is a fight the guard names once", async () => {
    const { host, io } = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    await echoWatcher(host, io);
    for (let round = 0; round < 40; round++) {
      // The other app removes the folder; the watcher reports it; the plugin reseeds.
      for (const p of [...io.files.keys()])
        if (p.startsWith("skills/web-search")) io.files.delete(p);
      io.folders.delete("skills/web-search");
      await host.app.vault.notifyExternal("delete", "skills/web-search");
      await vi.advanceTimersByTimeAsync(500);
      await echoWatcher(host, io);
      await vi.advanceTimersByTimeAsync(500);
    }
    logger.flush();
    const warns = sent.filter(
      (e) => e.level === "warn" && e.plugin === "seeder" && e.message.includes("times in"),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("skills/web-search");
    await host.shutdown();
  });
});

describe("churn guard", () => {
  it("warns once per plugin after more than 20 writes of one path in 10 s, without blocking", async () => {
    const { host } = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    const before = sent.length;
    await seeder().spam("skills/hot.txt", CHURN_SHORT_MAX + 5);
    await seeder().spam("skills/hot.txt", 10);
    logger.flush();
    const warns = sent
      .slice(before)
      .filter((e) => e.level === "warn" && e.plugin === "seeder" && e.message.includes("times in"));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("skills/hot.txt");
    expect(host.app.vault.adapter).toBeDefined();
    await host.shutdown();
  });

  it("stays quiet for ordinary use and catches a slow fight", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    for (let i = 0; i < CHURN_SHORT_MAX; i++)
      recordPluginMutation("calm", "a.md", "write", i * 100);
    for (let i = 0; i < 10; i++)
      recordPluginMutation("calm", "b.md", "write", 100_000 + i * 20_000);
    expect(warn).not.toHaveBeenCalled();
    // 2 changes every 4 s (a remove and a seed): over the minute that is past the long limit.
    for (let i = 0; i <= CHURN_LONG_MAX; i++)
      recordPluginMutation("slow", "skills/x", i % 2 ? "remove" : "write", 1_000_000 + i * 1_900);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][2]).toEqual({ plugin: "slow" });
    // Once per plugin.
    for (let i = 0; i < 100; i++) recordPluginMutation("slow", "skills/x", "write", 2_000_000 + i);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
