// @vitest-environment jsdom
// Regression tests for "notices keep firing": the host must not amplify one plugin-side event
// into many, and must cap/diagnose notices when a plugin does fire them in a loop.
// Synthetic fixture plugin only (mimics the patterns of a plugin that writes or notifies in
// response to vault events); no third-party code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";
import {
  MAX_VISIBLE_NOTICES,
  Notice,
  NOTICE_STORM_REPEATS,
  NOTICE_STORM_WINDOW_MS,
  resetNotices,
} from "../src/lib/obsidian-host/api/core";

const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };
const visible = () => document.querySelectorAll(".notice-container .notice").length;

beforeEach(() => {
  vi.useFakeTimers();
  resetNotices();
});
afterEach(() => {
  resetNotices();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Notice shim", () => {
  it("hides after the default duration and keeps duration 0 until hide()", () => {
    const timed = new Notice("a");
    const sticky = new Notice("b", 0);
    expect(visible()).toBe(2);
    vi.advanceTimersByTime(5001);
    expect(visible()).toBe(1);
    sticky.hide();
    expect(visible()).toBe(0);
    timed.hide(); // idempotent
  });

  it("caps visible notices and drops the oldest", () => {
    const first = new Notice("n0", 0);
    for (let i = 1; i <= MAX_VISIBLE_NOTICES + 2; i++) new Notice(`n${i}`, 0);
    expect(visible()).toBe(MAX_VISIBLE_NOTICES);
    expect(first.noticeEl.isConnected).toBe(false);
    const texts = [...document.querySelectorAll(".notice")].map((n) => n.textContent);
    expect(texts[texts.length - 1]).toBe(`n${MAX_VISIBLE_NOTICES + 2}`);
  });

  it("warns about a notice storm once a message repeats more than the threshold in the window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < NOTICE_STORM_REPEATS; i++) new Notice("same");
    expect(warn).not.toHaveBeenCalled();
    new Notice("same");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("notice storm");
    expect(String(warn.mock.calls[0][0])).toContain('"same"');
    // Outside the window the counter starts over.
    vi.advanceTimersByTime(NOTICE_STORM_WINDOW_MS + 1);
    new Notice("same");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs every notice with its text when the trace flag is set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    localStorage.setItem("writer.hostNoticeTrace", "1");
    try {
      new Notice("hello");
    } finally {
      localStorage.removeItem("writer.hostNoticeTrace");
    }
    expect(String(info.mock.calls[0][0])).toContain('"hello"');
  });
});

describe("host does not amplify events into notices", () => {
  async function bootFixture() {
    // A plugin that shows a notice per vault `modify` and, like many plugins, persists state
    // in response (vault.modify of a bookkeeping note, then vault.rename of another file).
    const ipc = new FakeHostIpc({ enabled: ["fx"], plugins: [{ id: "fx" }] });
    const io = createMemoryVaultIo({ "a.md": "# A", "b.md": "# B" });
    const loadScript: ScriptLoader = async () => {
      g.__writerPluginDefine("fx", (module: any, _e: any, require: any) => {
        const { Plugin, Notice: N } = require("obsidian");
        module.exports = class extends Plugin {
          async onload() {
            this.registerEvent(
              this.app.vault.on("modify", (f: any) => {
                new N(`modified ${f.path}`);
              }),
            );
          }
        };
      });
    };
    const host = new PluginHost({ ipc, io, loadScript, styles: { add: () => () => {} } });
    await host.boot();
    host.app.workspace.markLayoutReady();
    return { host, io };
  }

  it("a plugin's own modify/rename echoed by the file watcher fires no extra modify", async () => {
    const { host, io } = await bootFixture();
    const vault = host.app.vault;
    const a = vault.getFileByPath("a.md")!;
    await vault.modify(a, "# A changed");
    expect(visible()).toBe(1);
    // The watcher reports the plugin's own write (not recorded as a self-write) and the rename.
    await vault.notifyExternal("modify", "a.md");
    await vault.rename(a, "c.md");
    await vault.notifyExternal("create", "c.md");
    await vault.notifyExternal("delete", "a.md");
    expect(io.files.has("c.md")).toBe(true);
    expect(visible()).toBe(1);
  });

  it("a real external change still fires exactly one modify", async () => {
    const { host, io } = await bootFixture();
    const vault = host.app.vault;
    io.files.set("b.md", "# B edited elsewhere, longer");
    await vault.notifyExternal("modify", "b.md");
    await vault.notifyExternal("modify", "b.md");
    expect(visible()).toBe(1);
  });

  it("reloading a plugin does not leave listeners behind (one event, one notice)", async () => {
    const { host } = await bootFixture();
    await host.disable("fx");
    await host.enable("fx");
    await host.disable("fx");
    await host.enable("fx");
    const vault = host.app.vault;
    await vault.modify(vault.getFileByPath("b.md")!, "# B2");
    expect(visible()).toBe(1);
  });
});
