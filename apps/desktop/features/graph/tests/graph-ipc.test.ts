// The graph IPC: the manifest, the generated bindings and the typed client name the same
// commands, every call goes to `plugin:graph|<command>`, and the wrappers send the argument names
// the Rust commands read (`graph_slice` takes one `request` object).
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    graph_slice: () => ipc.graphSlice({ center: "a.md", depth: 1 }),
    graph_stats: () => ipc.graphStats(),
    graph_config_read: () => ipc.graphConfigRead(),
    graph_config_write: () => ipc.graphConfigWrite("{}"),
  },
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
