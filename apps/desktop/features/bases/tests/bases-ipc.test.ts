// The Bases IPC after the move into a plugin: every command is called as `plugin:bases|<command>`,
// the manifest, the generated bindings and the typed client name the same commands, and the
// wrappers keep the argument names the Rust side reads.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import { commands } from "../web/bindings";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const call = ipc.basesCommand as unknown as (c: string, a?: object) => Promise<unknown>;

describe("the Bases commands", () => {
  it("are the same set in the manifest and in the generated bindings", () => {
    expect(Object.keys(commands).map(snake).sort()).toEqual([...manifest.rust.commands].sort());
    expect(manifest.rust.commands).toHaveLength(10);
  });

  it("are invoked by the generated bindings on the plugin route", () => {
    for (const [name, fn] of Object.entries(commands)) {
      expect(fn.toString(), name).toContain(`"plugin:bases|${snake(name)}"`);
    }
  });

  it.each(manifest.rust.commands)("%s is called as plugin:bases|%s", async (command) => {
    const seen: string[] = [];
    mockIPC((cmd) => void seen.push(cmd));
    await call(command, {});
    expect(seen).toEqual([`plugin:bases|${command}`]);
  });

  it("a command the manifest does not declare never reaches Rust", async () => {
    let reached = false;
    mockIPC(() => void (reached = true));
    await expect(call("base_nope", {})).rejects.toThrow(/declares no command/);
    expect(reached).toBe(false);
  });
});

describe("the wrappers", () => {
  it("send the camelCase argument names the Rust commands read", async () => {
    const seen: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return cmd === "plugin:bases|base_read" ? { text: "", document: null, error: null } : null;
    });
    await ipc.baseQuery({ path: "a.base", view: "V", thisPath: "n.md", nowOffsetMinutes: 60 });
    await ipc.baseQueryText({ text: "views: []", thisPath: "n.md" });
    await ipc.baseEval({ expression: "1", thisPath: "n.md", text: "formulas: {}" });
    await ipc.notePropertySet({ path: "n.md", name: "a", value: 1, valueType: "number" });
    await ipc.notePropertyRemove({ path: "n.md", name: "a" });
    await ipc.noteProperties("n.md");
    await ipc.baseRead("a.base");
    expect(seen).toEqual([
      [
        "plugin:bases|base_query",
        { path: "a.base", view: "V", thisPath: "n.md", nowOffsetMinutes: 60 },
      ],
      ["plugin:bases|base_query_text", { text: "views: []", thisPath: "n.md" }],
      ["plugin:bases|base_eval", { expression: "1", thisPath: "n.md", text: "formulas: {}" }],
      [
        "plugin:bases|note_property_set",
        { path: "n.md", name: "a", value: 1, valueType: "number" },
      ],
      ["plugin:bases|note_property_remove", { path: "n.md", name: "a" }],
      ["plugin:bases|note_properties", { path: "n.md" }],
      ["plugin:bases|base_read", { path: "a.base" }],
    ]);
  });

  it("narrows the free-form document of a read to the view model", async () => {
    mockIPC(() => ({ text: "t", document: { views: [] }, error: null }));
    const r = await ipc.baseRead("a.base");
    expect(r.document?.views).toEqual([]);
  });
});
