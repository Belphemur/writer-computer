// Plugin commands in the palette: the feature's command source lists what can run right now.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "features_status" ? { safeMode: false, crashDisabled: [], failures: [] } : [],
  ),
  convertFileSrc: (p: string) => p,
}));

import "../../../src/lib/features/builtin";
import { resolveCommands } from "../../../src/components/command-palette/commands";
import type { CommandContext } from "../../../src/components/command-palette/commands";
import { createFeatureHost } from "../../../src/lib/features/registry";
import { CommandRegistry } from "../web/host/api/core";
import obsidianHost from "../web/index";
import { usePluginsStore } from "../web/stores/plugins-store";

const host = createFeatureHost({ onError: () => {} });
const ctx = (over: Partial<CommandContext> = {}) =>
  ({ hasWorkspace: false, isCompactFileMode: false, close: vi.fn(), ...over }) as CommandContext;

function registry() {
  const reg = new CommandRegistry();
  let editor: { editor: unknown; view: unknown } | null = null;
  reg.setEditorProvider(() => editor);
  const publish = () => usePluginsStore.setState({ commands: reg.list() } as never);
  return { reg, publish, setEditor: (e: typeof editor) => void (editor = e) };
}
const pluginIds = () =>
  resolveCommands(ctx())
    .map((c) => c.id)
    .filter((i) => i.startsWith("p:"));

beforeEach(() => host.register(obsidianHost));
afterEach(async () => {
  usePluginsStore.setState({ commands: [] } as never);
  await host.unregister("obsidian-host");
  vi.useRealTimers();
});

describe("palette plugin commands", () => {
  it("merges plugin commands after the built-ins, with plugin-prefixed names", () => {
    const { reg, publish } = registry();
    reg.addForPlugin("p", "Plug", { id: "go", name: "Go", callback: () => {} });
    publish();
    const list = resolveCommands(ctx());
    expect(list[list.length - 1]).toMatchObject({ id: "p:go", label: "Plug: Go" });
  });

  it("respects checkCallback and editor requirements", () => {
    const { reg, publish, setEditor } = registry();
    let allowed = false;
    reg.addForPlugin("p", "Plug", { id: "check", name: "Check", checkCallback: () => allowed });
    reg.addForPlugin("p", "Plug", { id: "ed", name: "Ed", editorCallback: () => {} });
    reg.addForPlugin("p", "Plug", {
      id: "edcheck",
      name: "EdCheck",
      editorCheckCallback: (checking) => (checking ? true : undefined),
    });
    publish();
    expect(pluginIds()).toEqual([]);
    allowed = true;
    expect(pluginIds()).toEqual(["p:check"]);
    setEditor({ editor: {}, view: {} });
    expect(pluginIds()).toEqual(["p:check", "p:ed", "p:edcheck"]);
  });

  it("a plugin cannot shadow a built-in id", () => {
    const { reg, publish } = registry();
    reg.add("zoom-in", {
      id: "zoom-in",
      name: "Evil zoom",
      hotkeys: [],
      owner: "p",
      isAvailable: () => true,
      run: () => {},
    });
    publish();
    const list = resolveCommands(ctx());
    expect(list.filter((c) => c.id === "zoom-in")).toHaveLength(1);
    expect(list.find((c) => c.id === "zoom-in")!.label).toBe("Zoom In");
  });

  it("closes the palette first, then runs the command on the next tick", () => {
    vi.useFakeTimers();
    const { reg, publish } = registry();
    const cb = vi.fn();
    reg.addForPlugin("p", "Plug", { id: "go", name: "Go", callback: cb });
    publish();
    const c = ctx();
    resolveCommands(c)
      .find((x) => x.id === "p:go")!
      .run();
    expect(c.close).toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
