// The Bases IPC: `describeFeatureIpc` pins every wrapper to the generated bindings (route, command
// set, argument names); the cases below keep what the wrappers add (null for an omitted option).
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
    base_list: () => ipc.baseList(),
    base_read: () => ipc.baseRead("a.base"),
    base_parse_text: () => ipc.baseParseText("views: []"),
    base_functions: () => ipc.baseFunctions(),
    base_query: () =>
      ipc.baseQuery({ path: "a.base", view: "V", thisPath: "n.md", nowOffsetMinutes: 60 }),
    base_query_text: () =>
      ipc.baseQueryText({ text: "views: []", view: "V", thisPath: "n.md", nowOffsetMinutes: 60 }),
    base_eval: () =>
      ipc.baseEval({ expression: "1", thisPath: "n.md", nowOffsetMinutes: 60, text: "t" }),
    note_properties: () => ipc.noteProperties("n.md"),
    note_property_set: () =>
      ipc.notePropertySet({ path: "n.md", name: "a", value: 1, valueType: "number" }),
    note_property_remove: () => ipc.notePropertyRemove({ path: "n.md", name: "a" }),
  },
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
      [
        "plugin:bases|base_query_text",
        { text: "views: []", view: null, thisPath: "n.md", nowOffsetMinutes: null },
      ],
      [
        "plugin:bases|base_eval",
        { expression: "1", thisPath: "n.md", nowOffsetMinutes: null, text: "formulas: {}" },
      ],
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
