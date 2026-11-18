// The palette and the registry meet in `commands.ts`: every palette command (built-in or from a
// feature) has an entry so it can be given a key, a key runs it with the palette's availability
// rule, the palette shows the user's key, and the dispatcher stands down while a key is recorded.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import "../src/lib/features/builtin";
import {
  BUILTIN_COMMANDS,
  commandLabel,
  resolveCommands,
  setCommandContextProvider,
  type CommandContext,
} from "../src/components/command-palette/commands";
import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";
import { createFeatureHost } from "../src/lib/features/registry";
import { featurePaletteCommands } from "../src/lib/features/palette";
import { beginKeyRecording } from "../src/lib/keybindings/recording";
import { keybindings } from "../src/lib/keybindings/registry";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const noop = () => {};
function ctxWith(over: Partial<CommandContext> = {}): CommandContext {
  return new Proxy(
    {
      hasWorkspace: true,
      isCompactFileMode: false,
      activeFilePath: "/a.md",
      hasActiveTab: true,
      unpinnedTabCount: 1,
      activeTabPin: "unpinned",
      hasClosedTabs: true,
      close: noop,
      ...over,
    },
    { get: (t, k) => (k in t ? (t as never)[k] : noop) },
  ) as never;
}

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("command entries", () => {
  it("every built-in palette command has a registry entry, the bound ones keep their binding", () => {
    for (const c of BUILTIN_COMMANDS) expect(keybindings.get(c.id), c.id).toBeDefined();
    expect(keybindings.get("toggle-sidebar")?.command).toBeUndefined(); // a core binding
    expect(keybindings.get("toggle-theme")?.command).toBe(true); // keyless until the user binds it
    expect(commandLabel("toggle-theme")).toBe("Toggle Dark Mode");
    expect(commandLabel("jump-to-tab")).toBeUndefined(); // a bare binding has no palette name
  });

  it("a feature's palette command gets an entry that goes with its owner", async () => {
    const host = createFeatureHost({ onError: () => {} });
    host.register({
      id: "demo",
      contributes: {
        commands: [{ id: "demo.run", label: "Demo: run", run: noop }],
        keybindings: [
          {
            id: "demo.bound",
            keys: ["Mod+Alt+9"],
            description: "Bound demo",
            run: noop,
          },
        ],
      },
    });
    expect(keybindings.get("demo.run")?.command).toBe(true);
    expect(keybindings.get("demo.run")?.owner).toBe("builtin:demo");
    expect(keybindings.effectiveKeys("demo.bound")).toEqual(["Mod+Alt+9"]);
    await host.unregister("demo");
    expect(keybindings.get("demo.run")).toBeUndefined();
    expect(keybindings.get("demo.bound")).toBeUndefined();
    expect(featurePaletteCommands.get("demo.run")).toBeUndefined();
  });

  it("a feature command and a keybinding with the same id are one entry that has the key", async () => {
    const host = createFeatureHost({ onError: () => {} });
    host.register({
      id: "same",
      contributes: {
        commands: [{ id: "same.go", label: "Same: go", run: noop }],
        keybindings: [{ id: "same.go", keys: ["Mod+Alt+8"], description: "Go", run: noop }],
      },
    });
    expect(keybindings.list().filter((b) => b.id === "same.go")).toHaveLength(1);
    expect(keybindings.get("same.go")?.command).toBeUndefined();
    expect(keybindings.effectiveKeys("same.go")).toEqual(["Mod+Alt+8"]);
    await host.unregister("same");
  });
});

describe("a key bound to a palette command", () => {
  let root: Root;
  function Harness() {
    useKeyboardShortcuts();
    return null;
  }
  const press = (e: KeyboardEvent) => {
    act(() => void window.dispatchEvent(e));
    return e;
  };
  const toggleTheme = vi.fn();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    toggleTheme.mockClear();
    // The real sidebar toggle applies a theme side effect that reads this (jsdom has none).
    window.matchMedia ??= (() => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    })) as never;
    useWorkspaceStore.setState({ root: "/ws", chromeMode: "workspace" });
    setCommandContextProvider(() => ctxWith({ toggleTheme }));
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    // Mounting loads hotkeys.json (the mocked IPC has none), which replaces the overrides.
    await act(async () => {});
    keybindings.setOverrides({ "toggle-theme": ["Mod+Shift+D"], "pin-tab": ["Mod+Alt+P"] });
  });
  afterEach(() => {
    act(() => root.unmount());
    keybindings.setOverrides({});
    setCommandContextProvider(null);
  });

  it("runs the command the palette would run, and the palette shows the key", () => {
    const e = press(key({ key: "D", metaKey: true, shiftKey: true }));
    expect(e.defaultPrevented).toBe(true);
    expect(toggleTheme).toHaveBeenCalledOnce();
    const shown = resolveCommands(ctxWith()).find((c) => c.id === "toggle-theme")?.shortcut;
    expect(shown).toBe(keybindings.shortcutFor("toggle-theme"));
    expect(shown).toBeTruthy();
  });

  it("lets the key through when the command is not available now", () => {
    setCommandContextProvider(() => ctxWith({ activeTabPin: "pinned" })); // "Pin Tab" needs unpinned
    expect(press(key({ key: "p", metaKey: true, altKey: true })).defaultPrevented).toBe(false);
  });

  it("does nothing, and keeps the key, with no palette mounted", () => {
    setCommandContextProvider(null);
    press(key({ key: "D", metaKey: true, shiftKey: true }));
    expect(toggleTheme).not.toHaveBeenCalled();
  });

  it("the old default of an overridden core command no longer fires, the new key does", () => {
    keybindings.setOverrides({ "toggle-sidebar": ["Mod+Shift+B"] });
    expect(press(key({ key: "\\", metaKey: true })).defaultPrevented).toBe(false);
    expect(press(key({ key: "B", metaKey: true, shiftKey: true })).defaultPrevented).toBe(true);
  });

  it("stands down while a key is being recorded", () => {
    const end = beginKeyRecording();
    expect(press(key({ key: "D", metaKey: true, shiftKey: true })).defaultPrevented).toBe(false);
    expect(toggleTheme).not.toHaveBeenCalled();
    end();
    end(); // harmless twice
    expect(press(key({ key: "D", metaKey: true, shiftKey: true })).defaultPrevented).toBe(true);
  });
});
