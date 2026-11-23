// The Bases IPC: `describeFeatureIpc` pins every wrapper to the generated bindings (route, command
// set, argument names and values); the cases below keep what the wrappers add (null for an omitted option).
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
    base_list: { call: () => ipc.baseList(), args: {} },
    base_read: { call: () => ipc.baseRead("p1"), args: { path: "p1" } },
    base_parse_text: { call: () => ipc.baseParseText("t1"), args: { text: "t1" } },
    base_functions: { call: () => ipc.baseFunctions(), args: {} },
    // An option the caller leaves out goes as `null` (Rust `Option`), the same key set always.
    base_query: {
      call: () => ipc.baseQuery({ path: "p1", view: "v1", thisPath: "tp1", nowOffsetMinutes: 60 }),
      args: { path: "p1", view: "v1", thisPath: "tp1", nowOffsetMinutes: 60 },
    },
    base_query_text: {
      call: () => ipc.baseQueryText({ text: "t1", thisPath: "tp1" }),
      args: { text: "t1", view: null, thisPath: "tp1", nowOffsetMinutes: null },
    },
    base_eval: {
      call: () => ipc.baseEval({ expression: "e1", thisPath: "tp1", text: "t1" }),
      args: { expression: "e1", thisPath: "tp1", nowOffsetMinutes: null, text: "t1" },
    },
    note_properties: { call: () => ipc.noteProperties("p1"), args: { path: "p1" } },
    note_property_set: {
      call: () => ipc.notePropertySet({ path: "p1", name: "n1", value: 1, valueType: "number" }),
      args: { path: "p1", name: "n1", value: 1, valueType: "number" },
    },
    note_property_remove: {
      call: () => ipc.notePropertyRemove({ path: "p1", name: "n1" }),
      args: { path: "p1", name: "n1" },
    },
  },
});

describe("the wrappers", () => {
  it("narrows the free-form document of a read to the view model", async () => {
    mockIPC(() => ({ text: "t", document: { views: [] }, error: null }));
    const r = await ipc.baseRead("a.base");
    expect(r.document?.views).toEqual([]);
  });
});
