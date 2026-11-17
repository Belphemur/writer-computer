// The graph IPC: the manifest, the generated bindings and the typed client name the same
// commands, every call goes to `plugin:graph|<command>`, and the wrappers send the argument names
// the Rust commands read (`graph_slice` takes one `request` object).
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import { commands } from "../web/bindings";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("the graph commands", () => {
  it("are the same set in the manifest and in the generated bindings", () => {
    expect(Object.keys(commands).map(snake).sort()).toEqual([...manifest.rust.commands].sort());
  });

  it("are invoked by the generated bindings on the plugin route", () => {
    for (const [name, fn] of Object.entries(commands)) {
      expect(fn.toString(), name).toContain(`"plugin:graph|${snake(name)}"`);
    }
  });
});

describe("the wrappers", () => {
  it("send the slice arguments as one request object", async () => {
    const seen: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return { nodes: [], edges: [], truncated: false, limit: 10_000, epoch: 1 };
    });
    await ipc.graphSlice({ center: "a.md", depth: 2, includeUnresolved: true });
    expect(seen).toEqual([
      [
        "plugin:graph|graph_slice",
        { request: { center: "a.md", depth: 2, includeUnresolved: true } },
      ],
    ]);
  });

  it("read and write the per-vault config through the two config commands", async () => {
    const seen: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return null;
    });
    expect(await ipc.graphConfigRead()).toBeNull();
    await ipc.graphConfigWrite("{}");
    await ipc.graphStats();
    expect(seen).toEqual([
      ["plugin:graph|graph_config_read", expect.anything()],
      ["plugin:graph|graph_config_write", { content: "{}" }],
      ["plugin:graph|graph_stats", expect.anything()],
    ]);
  });
});
