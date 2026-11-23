// The icons IPC: the manifest, the generated bindings and the typed client name the same
// commands, every call goes to `plugin:icons|<command>`, and the wrappers send the argument names
// the Rust commands read.
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
    icons_resolved: { call: () => ipc.iconsResolved(), args: {} },
    icons_set: {
      call: () => ipc.iconsSet(["p1", "p2"], "i1", "c1"),
      args: { paths: ["p1", "p2"], icon: "i1", color: "c1" },
    },
    icons_remove: { call: () => ipc.iconsRemove(["p1"]), args: { paths: ["p1"] } },
  },
});

describe("the icons event", () => {
  it("is a manifest event named like the web half listens to it", () => {
    expect(manifest.rust.events).toEqual([`icons:${ipc.ICONS_CHANGED}`]);
  });
});

describe("the wrappers", () => {
  it("read the resolved icons, dropping the nulls the generator adds", async () => {
    mockIPC(() => ({
      icons: [
        { path: "a.md", icon: "emoji:🚀", color: null, source: "writer" },
        { path: "d", icon: "emoji:📁", color: "#ff0000", source: "iconize" },
      ],
      iconizeUnsupported: 3,
    }));
    expect(await ipc.iconsResolved()).toEqual({
      icons: [
        { path: "a.md", icon: "emoji:🚀", source: "writer" },
        { path: "d", icon: "emoji:📁", color: "#ff0000", source: "iconize" },
      ],
      iconizeUnsupported: 3,
    });
  });
});
