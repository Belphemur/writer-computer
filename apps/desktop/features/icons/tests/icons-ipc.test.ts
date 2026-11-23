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
    icons_resolved: () => ipc.iconsResolved(),
    icons_set: () => ipc.iconsSet(["a.md"], "emoji:x", "#112233"),
    icons_remove: () => ipc.iconsRemove(["a.md"]),
  },
});

describe("the icons event", () => {
  it("is a manifest event named like the web half listens to it", () => {
    expect(manifest.rust.events).toEqual([`icons:${ipc.ICONS_CHANGED}`]);
  });
});

describe("the wrappers", () => {
  it("send paths, icon and colour as the Rust commands name them", async () => {
    const seen: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return null;
    });
    await ipc.iconsSet(["a.md", "d"], "emoji:🚀");
    await ipc.iconsSet(["a.md"], "icon:Rocket01Icon", "#112233");
    await ipc.iconsRemove(["a.md"]);
    expect(seen).toEqual([
      ["plugin:icons|icons_set", { paths: ["a.md", "d"], icon: "emoji:🚀", color: null }],
      ["plugin:icons|icons_set", { paths: ["a.md"], icon: "icon:Rocket01Icon", color: "#112233" }],
      ["plugin:icons|icons_remove", { paths: ["a.md"] }],
    ]);
  });

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
