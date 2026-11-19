// @vitest-environment jsdom
// Plugin hotkeys in the keybinding registry: a plugin's `addCommand({ hotkeys })` and
// `hotkeyManager.addDefaultHotkeys` appear as entries owned by the plugin (its name is the group),
// follow the command's life, run it through the one dispatcher, and the plugin reads the keys in
// force through `hotkeyManager` (`getHotkeys`, `customKeys`); `setHotkeys` writes through the
// override path. Nothing touches `.obsidian`.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { HotkeyOverrides } from "@/lib/keybindings/overrides";
import { KeybindingRegistry } from "@/lib/keybindings/registry";
import { CommandRegistry } from "../web/host/api/core";
import { HotkeyManager } from "../web/host/api/hotkey-manager";
import { bridgeCommandHotkeys } from "../web/host/command-hotkeys";

const always = {
  "not-compact": () => true,
  "editor-not-focused": () => true,
  "outside-agent-pane": () => true,
  "image-viewer": () => true,
  "pdf-viewer": () => true,
  "no-viewer": () => true,
};
const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

function setup(names: Record<string, string> = { excalidraw: "Excalidraw" }) {
  const registry = new KeybindingRegistry(always, () => "macos");
  registry.add("core", {
    id: "close-tab",
    keys: ["Mod+W"],
    description: "Close",
    category: "Tabs",
    run: () => {},
  });
  const writes: string[] = [];
  const overrides = new HotkeyOverrides(registry, () => "mac", {
    read: async () => null,
    write: async (t) => void writes.push(t),
  });
  const commands = new CommandRegistry();
  const hotkeys = new HotkeyManager(registry, overrides);
  const stop = bridgeCommandHotkeys(commands, hotkeys, (id) => names[id] ?? id, registry);
  return { registry, overrides, commands, hotkeys, stop, writes };
}

describe("plugin commands in the registry", () => {
  it("lists a command's hotkeys under the plugin, owned by it", () => {
    const { registry, commands } = setup();
    const run = vi.fn();
    commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "save",
      name: "Save",
      callback: run,
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
    });
    const e = registry.get("excalidraw:save")!;
    expect(e.owner).toBe("excalidraw");
    expect(e.group).toBe("Excalidraw (plugin)");
    expect(e.description).toBe("Excalidraw: Save");
    expect(registry.effectiveKeys("excalidraw:save")).toEqual(["Mod+S"]);
    expect(registry.find(key({ key: "s", metaKey: true }), "bubble")?.id).toBe("excalidraw:save");
    registry.find(key({ key: "s", metaKey: true }), "bubble")?.run(key({}));
    expect(run).toHaveBeenCalledOnce();
  });

  it("lists a command without hotkeys too, so it can be given one", () => {
    const { registry, commands } = setup();
    commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "new",
      name: "New",
      callback: vi.fn(),
    });
    expect(registry.get("excalidraw:new")).toBeDefined();
    expect(registry.effectiveKeys("excalidraw:new")).toEqual([]);
  });

  it("takes the defaults a plugin sets through the hotkey manager", () => {
    const { registry, commands, hotkeys } = setup();
    commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "save",
      name: "Save",
      callback: vi.fn(),
    });
    hotkeys.addDefaultHotkeys("excalidraw:save", [{ modifiers: ["Ctrl"], key: "s" }]);
    expect(registry.effectiveKeys("excalidraw:save")).toEqual(["Ctrl+S"]);
    hotkeys.removeDefaultHotkeys("excalidraw:save");
    expect(registry.effectiveKeys("excalidraw:save")).toEqual([]);
  });

  it("follows the command: gone when the plugin's commands are removed, and on stop", () => {
    const { registry, commands, stop } = setup();
    commands.addForPlugin("excalidraw", "Excalidraw", { id: "a", name: "A", callback: vi.fn() });
    commands.addForPlugin("excalidraw", "Excalidraw", { id: "b", name: "B", callback: vi.fn() });
    commands.removeOwner("excalidraw");
    expect(registry.list().map((b) => b.id)).toEqual(["close-tab"]);
    commands.addForPlugin("excalidraw", "Excalidraw", { id: "c", name: "C", callback: vi.fn() });
    stop();
    expect(registry.list().map((b) => b.id)).toEqual(["close-tab"]);
  });

  it("never errors on a key a core command has: the plugin's key just has no effect", () => {
    const { registry, commands } = setup();
    expect(() =>
      commands.addForPlugin("excalidraw", "Excalidraw", {
        id: "close",
        name: "Close",
        callback: vi.fn(),
        hotkeys: [
          { modifiers: ["Mod"], key: "w" },
          { modifiers: ["Mod"], key: "q" },
          { modifiers: ["Mod", "Shift"], key: "w" },
        ],
      }),
    ).not.toThrow();
    expect(registry.effectiveKeys("excalidraw:close")).toEqual(["Mod+Shift+W"]);
    expect(registry.effectiveKeys("close-tab")).toEqual(["Mod+W"]);
  });

  it("lets the key through while the command is not available", () => {
    const { registry, commands } = setup();
    let ok = false;
    commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "save",
      name: "Save",
      checkCallback: (checking) => (ok ? (checking ? true : undefined) : false),
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
    });
    expect(registry.find(key({ key: "s", metaKey: true }), "bubble")).toBeUndefined();
    ok = true;
    expect(registry.find(key({ key: "s", metaKey: true }), "bubble")?.id).toBe("excalidraw:save");
  });

  it("does not take over an id another owner has", () => {
    const { registry, commands } = setup();
    registry.add("core", {
      id: "excalidraw:save",
      keys: ["Mod+Alt+Z"],
      description: "x",
      category: "Tabs",
      run: () => {},
    });
    commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "save",
      name: "Save",
      callback: vi.fn(),
    });
    expect(registry.get("excalidraw:save")?.owner).toBe("core");
  });
});

describe("what a plugin reads and writes through hotkeyManager", () => {
  const withSave = () => {
    const s = setup();
    s.commands.addForPlugin("excalidraw", "Excalidraw", {
      id: "save",
      name: "Save",
      callback: vi.fn(),
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
    });
    return s;
  };

  it("getHotkeys / getDefaultHotkeys read the registry; customKeys is the user's keys", async () => {
    const { hotkeys, overrides } = withSave();
    expect(hotkeys.getHotkeys("excalidraw:save")).toEqual([{ modifiers: ["Mod"], key: "s" }]);
    expect(hotkeys.customKeys).toEqual({});
    await overrides.setKeys("excalidraw:save", ["Mod+Shift+K"]);
    expect(hotkeys.getHotkeys("excalidraw:save")).toEqual([
      { modifiers: ["Mod", "Shift"], key: "k" },
    ]);
    expect(hotkeys.getDefaultHotkeys("excalidraw:save")).toEqual([
      { modifiers: ["Mod"], key: "s" },
    ]);
    expect(hotkeys.customKeys).toEqual({
      "excalidraw:save": [{ modifiers: ["Mod", "Shift"], key: "k" }],
    });
    expect(hotkeys.printHotkeyForCommand("excalidraw:save")).toBe("Mod+Shift+k");
  });

  it("a command the registry does not know falls back to the defaults the plugin set", () => {
    const { hotkeys } = setup();
    hotkeys.addDefaultHotkeys("later:cmd", [{ modifiers: ["Alt"], key: "x" }]);
    expect(hotkeys.getHotkeys("later:cmd")).toEqual([{ modifiers: ["Alt"], key: "x" }]);
    expect(hotkeys.getHotkeys("none")).toEqual([]);
  });

  it("setHotkeys writes through the override path (this OS only); removeHotkeys resets", async () => {
    const { hotkeys, registry, writes } = withSave();
    hotkeys.setHotkeys("excalidraw:save", [
      { modifiers: ["Mod", "Shift"], key: "k" },
      { modifiers: ["Super" as never], key: "z" }, // unmappable: dropped
    ]);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0]!)).toEqual({
      version: 1,
      mac: { "excalidraw:save": ["Mod+Shift+K"] },
      windows: {},
      linux: {},
    });
    expect(registry.effectiveKeys("excalidraw:save")).toEqual(["Mod+Shift+K"]);
    hotkeys.removeHotkeys("excalidraw:save");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(registry.effectiveKeys("excalidraw:save")).toEqual(["Mod+S"]);
    hotkeys.setHotkeys("excalidraw:save", []);
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(registry.effectiveKeys("excalidraw:save")).toEqual([]);
  });
});
