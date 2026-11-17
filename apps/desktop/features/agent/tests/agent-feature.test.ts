// The agent feature as a built-in: its commands, the Cmd+Shift+A binding and the dock register and
// unregister cleanly, the dock follows the pane store and the saved settings, and the kill switch
// removes everything.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { dockContributions, openDock } from "../../../src/lib/features/docks";
import { featurePaletteCommands } from "../../../src/lib/features/palette";
import { featureHost as host } from "../../../src/lib/features/registry";
import "../../../src/lib/features/builtin";
import { keybindings } from "../../../src/lib/keybindings/registry";
import { useAgentStore } from "../../../src/stores/agent-store";
import { useSettingsStore } from "../../../src/stores/settings-store";
import { useWorkspaceStore } from "../../../src/stores/workspace-store";
import manifest from "../feature.json";

// The app's own host: importing the loader registers every enabled built-in, as at startup.
type Contributed = { owner: string; id: string; when?: (x: never) => boolean };
const agentCommands = () =>
  (featurePaletteCommands.list() as Contributed[]).filter((c) => c.owner === "builtin:agent");
const ctx = { hasWorkspace: true, isCompactFileMode: false } as never;

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useAgentStore.setState({ paneOpen: false, paneWidth: 420 });
  useWorkspaceStore.setState({ root: "/ws", chromeMode: "workspace" });
});
afterEach(() => {
  useSettingsStore.setState({ settings: {} });
});

describe("agent feature registration", () => {
  it("registers its commands, key and dock and removes exactly them", async () => {
    const commands = agentCommands();
    expect(commands.map((c) => c.id).sort()).toEqual(
      manifest.contributes.commands.map((c) => c.id).sort(),
    );
    expect(keybindings.shortcutFor("agent.toggle-pane")).toBeTruthy();
    expect(dockContributions.has("agent.pane")).toBe(true);
    useSettingsStore.setState({ settings: { "features.agent.enabled": false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(agentCommands()).toEqual([]);
    expect(keybindings.list().some((b) => b.id === "agent.toggle-pane")).toBe(false);
    expect(dockContributions.has("agent.pane")).toBe(false);
  });

  it("comes back when the kill switch is turned on again", async () => {
    useSettingsStore.setState({ settings: { "features.agent.enabled": false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.list()).not.toContain("agent");
    useSettingsStore.setState({ settings: {} });
    expect(host.list()).toContain("agent");
    expect(dockContributions.has("agent.pane")).toBe(true);
  });

  it("is activated at startup because the saved pane state must apply before first paint", () => {
    expect(manifest.activation).toContain("onStartup");
  });
});

describe("commands", () => {
  it("are offered in a workspace window only, the demo backend in development", () => {
    const cmds = agentCommands();
    const available = (c: { when?: (x: never) => boolean }, x = ctx) => c.when?.(x) ?? true;
    for (const c of cmds) expect(available(c), c.id).toBe(true);
    const compact = { hasWorkspace: true, isCompactFileMode: true } as never;
    for (const c of cmds) expect(available(c, compact), c.id).toBe(false);
  });

  it("toggle the pane (the dock follows) and the key does it from anywhere in a workspace", async () => {
    const toggle = featurePaletteCommands.get("agent.toggle-pane")!;
    expect(openDock()).toBeNull();
    toggle.run(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(openDock()?.id).toBe("agent.pane");
    expect(openDock()?.width()).toBe(420);
    const key = new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true });
    keybindings.find(key, "bubble")!.run(key);
    await new Promise((r) => setTimeout(r, 0));
    expect(openDock()).toBeNull();
  });

  it("the key does nothing without a workspace", async () => {
    useWorkspaceStore.setState({ root: null });
    const key = new KeyboardEvent("keydown", { key: "a", metaKey: true, shiftKey: true });
    keybindings.find(key, "bubble")!.run(key);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAgentStore.getState().paneOpen).toBe(false);
  });
});

describe("dock sync (activation)", () => {
  it("adopts the saved pane state and restores the vault's chats on a change of root", async () => {
    const restore = vi.fn(async () => {});
    useAgentStore.setState({ restoreChats: restore });
    // Activate again from a clean slate so the sync runs against this test's state.
    await host.deactivate("agent");
    useSettingsStore.setState({ settings: { "agent.pane-open": true, "agent.pane-width": 500 } });
    await host.activate("agent");
    expect(useAgentStore.getState().paneOpen).toBe(true);
    expect(useAgentStore.getState().paneWidth).toBe(500);
    expect(restore).toHaveBeenCalledWith("/ws");

    useSettingsStore.setState({ settings: { "agent.pane-open": false, "agent.pane-width": 500 } });
    expect(useAgentStore.getState().paneOpen).toBe(false);

    useWorkspaceStore.setState({ root: "/other" });
    expect(restore).toHaveBeenLastCalledWith("/other");
    await host.deactivate("agent");
    useWorkspaceStore.setState({ root: "/third" });
    expect(restore).toHaveBeenCalledTimes(2);
  });
});
