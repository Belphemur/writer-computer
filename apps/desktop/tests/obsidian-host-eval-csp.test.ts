// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { PluginHost, type ScriptLoader } from "../src/lib/obsidian-host/loader";
import { createMemoryVaultIo, FakeHostIpc } from "../src/lib/obsidian-host/testing";

const g = globalThis as unknown as { __writerPluginDefine: (id: string, factory: unknown) => void };

/** `new Function` and `WebAssembly` are what Excalidraw/Templater do; jsdom does not enforce CSP. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function runPlugin(
  onload: (plugin: any) => void | Promise<void>,
  files: Record<string, string> = { "a.md": "# A" },
): Promise<PluginHost> {
  const loadScript: ScriptLoader = async () => {
    g.__writerPluginDefine("fx", (module: { exports: unknown }, _e: unknown, require: any) => {
      const { Plugin: P } = require("obsidian");
      module.exports = class extends P {
        async onload() {
          await onload(this);
        }
      };
    });
  };
  const host = new PluginHost({
    ipc: new FakeHostIpc({ enabled: ["fx"], plugins: [{ id: "fx", name: "fx" }] }),
    io: createMemoryVaultIo(files),
    loadScript,
    styles: { add: () => () => {} },
  });
  await host.boot();
  return host;
}

describe("app CSP (tauri.conf.json)", () => {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const csp: string = conf.app.security.csp;
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find(([n]) => n === name)
      ?.slice(1) ?? [];

  it("script-src allows exactly the intended sources", () => {
    expect(directive("script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'wasm-unsafe-eval'",
      "writer-plugin:",
      "http://writer-plugin.localhost",
    ]);
  });

  it("does not widen anything else (no blob:, no remote script or connect origins)", () => {
    expect(csp).not.toMatch(/blob:/);
    expect(directive("connect-src")).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
    expect(directive("default-src")).toEqual(["'self'"]);
    for (const name of ["style-src", "font-src"])
      expect(directive(name)).not.toContain("'unsafe-eval'");
  });
});

describe("plugins that evaluate strings or compile WebAssembly", () => {
  it("runs new Function, indirect eval and WebAssembly from onload (Excalidraw / Templater shapes)", async () => {
    const seen: Record<string, unknown> = {};
    const host = await runPlugin(async () => {
      seen.fn = new Function("return 1")();
      // Excalidraw: window.eval of a wrapper that returns a library factory.
      seen.eval = (window as any).eval.call(window, "(function(a){ return a + 1; })")(1);
      // Templater: a wasm engine plus an AsyncFunction template runner.
      seen.wasm = new WebAssembly.Module(EMPTY_WASM) instanceof WebAssembly.Module;
      seen.instance =
        (await WebAssembly.instantiate(EMPTY_WASM)).instance instanceof WebAssembly.Instance;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      seen.async = await new AsyncFunction("x", "return await x")(7);
    });
    expect(host.getStatus("fx")).toEqual({ state: "enabled" });
    expect(seen).toEqual({ fn: 1, eval: 2, wasm: true, instance: true, async: 7 });
    await host.shutdown();
  });
});

describe("undocumented Vault members used by Templater and Excalidraw", () => {
  it("getAvailablePath picks the first free name, case-insensitively", async () => {
    const out: Record<string, unknown> = {};
    const host = await runPlugin(
      (p) => {
        const v = p.app.vault;
        out.free = v.getAvailablePath("Notes/New", "md");
        out.taken = v.getAvailablePath("Notes/Untitled", "md");
        out.dotExt = v.getAvailablePath("Notes/Untitled", ".md");
        out.insensitive = v.getAbstractFileByPathInsensitive("notes/UNTITLED.md")?.path;
        out.exact = v.getAbstractFileByPathInsensitive("a.md")?.path;
        out.none = v.getAbstractFileByPathInsensitive("zzz");
      },
      { "Notes/Untitled.md": "", "Notes/Untitled 1.md": "" },
    );
    expect(out).toEqual({
      free: "Notes/New.md",
      taken: "Notes/Untitled 2.md",
      dotExt: "Notes/Untitled 2.md",
      insensitive: "Notes/Untitled.md",
      exact: undefined,
      none: null,
    });
    await host.shutdown();
  });
});
