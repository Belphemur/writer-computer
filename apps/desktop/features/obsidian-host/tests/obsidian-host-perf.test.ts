// @vitest-environment jsdom
// Performance harness for the plugin host's vault layer, on SYNTHETIC data only.
//
// A fake Tauri `invoke` models the Rust commands the host calls (read_directory with its per-file
// title read, read_file, file_exists, plugin_fs_probe, write_file, ...), counts every call and
// delays each by a fixed latency. The scenarios replay what Copilot does when a project is
// selected (list the chat folder, read cached frontmatter per chat, probe a few paths, autosave
// the chat note) and while a reply streams (re-render the growing message with wiki links).
// The assertions are call-count and complexity budgets, not wall-clock limits, so they stay
// stable on slow CI. Run with `HOST_PERF_REPORT=1` to print the measured table.
import process from "node:process";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { vi } from "vite-plus/test";

const fake = vi.hoisted(() => {
  type Dir = { dirs: Set<string>; files: Map<string, string> };
  const state = {
    latencyMs: 1,
    calls: {} as Record<string, number>,
    fileOpens: 0,
    fs: new Map<string, string>(),
    mtime: new Map<string, number>(),
  };
  const bump = (cmd: string): void => void (state.calls[cmd] = (state.calls[cmd] ?? 0) + 1);
  const root = "/vault";
  const rel = (p: string): string => p.slice(root.length + 1);
  const children = (dir: string): { name: string; path: string; isDir: boolean }[] => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const seen = new Map<string, boolean>();
    for (const p of state.fs.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name.startsWith(".")) continue;
      seen.set(name, slash >= 0 || seen.get(name) === true);
    }
    return [...seen].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir }));
  };
  const isDirPath = (p: string): boolean => p === "" || children(p).length > 0;
  const entryOf = (c: { name: string; path: string; isDir: boolean }) => ({
    name: c.name,
    path: `${root}/${c.path}`,
    is_dir: c.isDir,
    is_markdown: !c.isDir,
    modified_at: (state.mtime.get(c.path) ?? 1) / 1000,
    created_at: 1,
    title: null,
  });
  const handlers: Record<string, (a: any) => unknown> = {
    read_directory: ({ path, titles }) => {
      const dir = rel(path);
      const list = children(dir).filter((c) => c.isDir || c.name.endsWith(".md"));
      // The real command opens every markdown file to extract a title.
      if (titles !== false) state.fileOpens += list.filter((c) => !c.isDir).length;
      return list.map(entryOf);
    },
    read_file: ({ path }) => {
      state.fileOpens++;
      const v = state.fs.get(rel(path));
      if (v === undefined) throw new Error("not found");
      return { path, content: v, modified_at: 1 };
    },
    write_file: ({ path, content }) => {
      state.fs.set(rel(path), content);
      state.mtime.set(rel(path), Date.now());
      return { path, modified_at: Date.now() / 1000 };
    },
    file_exists: ({ path }) => state.fs.has(rel(path)) || isDirPath(rel(path)),
    plugin_fs_probe: ({ paths }) =>
      (paths as string[]).map((path) => {
        const r = rel(path);
        const f = state.fs.get(r);
        const d = f === undefined && isDirPath(r);
        return {
          path,
          exists: f !== undefined || d,
          is_file: f !== undefined,
          is_dir: d,
          size: f?.length ?? null,
          modified_ms: f === undefined ? null : (state.mtime.get(r) ?? 1),
          created_ms: f === undefined ? null : 1,
        };
      }),
    create_directory: () => ({}),
    rename_entry: () => undefined,
    delete_entry: () => undefined,
  };
  return {
    state,
    root,
    async invoke(cmd: string, args: Record<string, unknown>) {
      bump(cmd);
      await new Promise((r) => setTimeout(r, state.latencyMs));
      const h = handlers[cmd];
      if (!h) throw new Error(`fake invoke: unhandled ${cmd}`);
      return h(args ?? {});
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => fake.invoke(cmd, args),
  Channel: class {},
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../web/host/node/external-links", () => ({ openExternalUrl: () => true }));

import { createApp, type App } from "../web/host/api/app";
import { createHostServices } from "../web/host/api/core";
import { setMarkdownRenderer } from "../web/host/api/functions";
import { createMarkdownRenderer } from "../web/host/api/markdown-render";
import { Component } from "../web/host/api/core";
import { createTauriVaultIo } from "../web/host/api/vault-io-tauri";
import { detachedBridge } from "../web/host/api/views";
import type { TFile } from "../web/host/api/vault";
import {
  pluginScopedFetch,
  setNetIpc,
  type NetIpc,
  type StreamEventWire,
} from "../web/host/api/network";

const NOTES = 2000;
const CHATS = 300;
const CHAT_DIR = "copilot/copilot-conversations";
const report = process.env.HOST_PERF_REPORT === "1";

function seedVault(): void {
  const { fs } = fake.state;
  fs.clear();
  fake.state.mtime.clear();
  for (let i = 0; i < NOTES; i++) {
    const folder = `area-${i % 20}`;
    const links = [`[[note-${(i * 7) % NOTES}]]`, `[[Concept ${i % 50}]]`, `[[Missing ${i}]]`];
    fs.set(
      `${folder}/note-${i}.md`,
      `---\ntitle: Note ${i}\ntags: [t${i % 10}]\n---\n# Heading ${i}\n${links.join(" ")} #tag${i % 9}\n`,
    );
  }
  for (let i = 0; i < CHATS; i++) {
    const project = i % 3 === 0 ? "proj-a" : "proj-b";
    fs.set(
      `${CHAT_DIR}/${project}__chat-${i}.md`,
      `---\nepoch: ${1_700_000_000_000 + i}\nprojectId: ${project}\ntopic: Chat ${i}\n---\n**user**: hi [[note-${i}]]\n\n**ai**: see [[Missing ${i}]]\n`,
    );
  }
  fs.set("copilot/projects/proj-a/project.md", "---\nid: proj-a\n---\nbody\n");
  fs.set("AGENTS.md", "# agents\n");
  for (let i = 0; i < 400; i++) fs.set(`root-${i}.md`, `# root ${i}\n`);
}

const totalCalls = (): number => Object.values(fake.state.calls).reduce((a, b) => a + b, 0);
const reset = (): void => {
  fake.state.calls = {};
  fake.state.fileOpens = 0;
};

async function boot(): Promise<App> {
  const app = createApp({
    io: createTauriVaultIo(fake.root, "vault"),
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge: detachedBridge,
  });
  await app.start();
  // indexAll is fire-and-forget in start(); wait until the cache holds every note.
  const deadline = Date.now() + 120_000;
  while (app.metadataCache.getFileCache(app.vault.getMarkdownFiles()[0]) === null) {
    if (Date.now() > deadline) throw new Error("indexAll did not finish");
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise<void>((resolve) => {
    const ref = app.metadataCache.on("resolved", () => {
      app.metadataCache.offref(ref);
      resolve();
    });
    // already resolved? resolve soon anyway
    setTimeout(resolve, 3000);
  });
  return app;
}

/** What Copilot does on project select, from its public behavior (listing is synchronous). */
async function copilotProjectSwitch(app: App): Promise<number> {
  const folder = app.vault.getAbstractFileByPath(CHAT_DIR);
  const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder!.path));
  let hits = 0;
  await Promise.all(
    files.map(async (file) => {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.projectId === "proj-a") hits++;
      else if (!fm) await app.vault.adapter.read(file.path);
    }),
  );
  // Housekeeping Copilot does around entering a project.
  await app.vault.adapter.exists("AGENTS.md");
  await app.vault.adapter.exists("copilot/projects/proj-a");
  await app.vault.adapter.exists(`${CHAT_DIR}/proj-a__chat-0.md`);
  await app.vault.modify(app.vault.getFileByPath("copilot/projects/proj-a/project.md")!, "touched");
  return hits;
}

beforeEach(() => {
  fake.state.latencyMs = 1;
  seedVault();
  reset();
});

describe("host vault performance (synthetic)", () => {
  it("boot: vault load + metadata indexing cost", async () => {
    const t0 = performance.now();
    const app = await boot();
    const ms = performance.now() - t0;
    const row = { ms: Math.round(ms), calls: totalCalls(), opens: fake.state.fileOpens };
    if (report) console.log("BOOT", JSON.stringify(row), JSON.stringify(fake.state.calls));
    expect(app.vault.getMarkdownFiles().length).toBe(NOTES + CHATS + 402);
    // One IPC per directory listing + one read per note is the floor today; the budget
    // guards against per-file extra round trips (stat, exists) creeping in.
    expect(fake.state.calls.file_exists ?? 0).toBe(0);
  }, 180_000);

  it("project switch: chat listing is served from memory, probes are O(1)", async () => {
    const app = await boot();
    reset();
    const t0 = performance.now();
    const hits = await copilotProjectSwitch(app);
    const ms = performance.now() - t0;
    const row = {
      ms: Math.round(ms),
      calls: totalCalls(),
      opens: fake.state.fileOpens,
      hits,
    };
    if (report) console.log("SWITCH", JSON.stringify(row), JSON.stringify(fake.state.calls));
    expect(hits).toBe(CHATS / 3);
    // No directory listings and no file opens just to answer exists/stat/modify.
    expect(fake.state.calls.read_directory ?? 0).toBe(0);
    expect(fake.state.fileOpens).toBeLessThanOrEqual(2);
    expect(totalCalls()).toBeLessThanOrEqual(8);
  }, 180_000);

  it("chat autosave: modify of a chat note does not rescan the vault", async () => {
    const app = await boot();
    reset();
    const chat = app.vault.getFileByPath(`${CHAT_DIR}/proj-a__chat-0.md`) as TFile;
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      await app.vault.modify(
        chat,
        `---\nepoch: 1\nprojectId: proj-a\n---\n${"[[Missing 1]] [[note-3]] ".repeat(i + 1)}`,
      );
      // let the metadata re-index (read + parse + resolve) settle
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(tick);
    const ms = performance.now() - t0;
    if (report)
      console.log(
        "AUTOSAVE x20",
        JSON.stringify({
          ms: Math.round(ms),
          calls: totalCalls(),
          maxLoopGapMs: Math.round(maxGap),
        }),
      );
    // Before the incremental resolve this was one full-vault link resolution (seconds) per save.
    expect(maxGap).toBeLessThan(250);
    expect(fake.state.calls.read_directory ?? 0).toBe(0);
    expect(fake.state.fileOpens).toBeLessThanOrEqual(40);
  }, 180_000);

  it("streaming render: per-token markdown render cost does not scale with vault size", async () => {
    const app = await boot();
    setMarkdownRenderer(createMarkdownRenderer({ app }));
    const render = createMarkdownRenderer({ app });
    const el = document.createElement("div");
    const component = new Component();
    const words = [
      "The",
      "note",
      "[[note-5]]",
      "and",
      "[[Missing 7]]",
      "or",
      "[[Concept 3]]",
      "ok",
    ];
    let text = "";
    const stalls: number[] = [];
    const t0 = performance.now();
    const TOKENS = 400;
    for (let i = 0; i < TOKENS; i++) {
      text += `${words[i % words.length]} `;
      const s = performance.now();
      await render(text, el, {
        app,
        component,
        sourcePath: "copilot/chat.md",
      } as never);
      const d = performance.now() - s;
      if (d > 50) stalls.push(d);
    }
    const ms = performance.now() - t0;
    if (report)
      console.log(
        "STREAM",
        JSON.stringify({
          tokens: TOKENS,
          totalMs: Math.round(ms),
          perTokenMs: +(ms / TOKENS).toFixed(2),
          stalls50: stalls.length,
        }),
      );
    expect(stalls.length).toBe(0);
  }, 180_000);
});

describe("host streaming path (synthetic)", () => {
  it("20 LLM-style streams of 5k small chunks: no event-loop stalls, nothing retained", async () => {
    const enc = (t: string): string => btoa(t);
    const open: Set<(ev: StreamEventWire) => void> = new Set();
    const ipc: NetIpc = {
      request: async () => {
        throw new Error("unused");
      },
      streamStart: async (_req, onEvent) => {
        open.add(onEvent);
        // Events arrive from a macrotask loop, like Channel messages, in bursts of 50.
        let sent = 0;
        queueMicrotask(() =>
          onEvent({ type: "head", status: 200, headers: [], url: "https://x/" }),
        );
        const pump = (): void => {
          for (let i = 0; i < 50 && sent < 5000; i++, sent++)
            onEvent({ type: "chunk", data_base64: enc(`data: {"t":"tok${sent}"}\n\n`) });
          if (sent < 5000) setTimeout(pump, 0);
          else onEvent({ type: "end" });
        };
        setTimeout(pump, 0);
        return 1;
      },
      streamCancel: async () => true,
    };
    setNetIpc(ipc);
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    let bytes = 0;
    for (let r = 0; r < 20; r++) {
      const res = await pluginScopedFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: "{}",
      });
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
    }
    clearInterval(tick);
    setNetIpc(null);
    const ms = performance.now() - t0;
    if (report)
      console.log(
        "NETSTREAM",
        JSON.stringify({
          requests: 20,
          chunks: 100_000,
          ms: Math.round(ms),
          maxLoopGapMs: Math.round(maxGap),
          bytes,
        }),
      );
    expect(maxGap).toBeLessThan(250);
  }, 120_000);
});
