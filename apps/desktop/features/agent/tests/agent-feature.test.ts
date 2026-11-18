// The agent feature as a built-in: its commands, the Cmd+Shift+A binding and the dock register and
// unregister cleanly, the dock follows the pane store and the saved settings, and the kill switch
// removes everything.
// @vitest-environment jsdom
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { dockContributions, openDock } from "@/lib/features/docks";
import { fileTreeDecorationContributions } from "@/lib/features/file-tree";
import { menuContributions, menuKey } from "@/lib/features/menus";
import { overlayContributions } from "@/lib/features/overlays";
import { featurePaletteCommands } from "@/lib/features/palette";
import { featureHost as host } from "@/lib/features/registry";
import "@/lib/features/builtin";
import { keybindings } from "@/lib/keybindings/registry";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  DESKTOP,
  importsOf,
  resolveSpec,
  sourceFiles,
  staticGraph,
} from "@tests/helpers/import-graph";
import manifest from "../feature.json";

// The app's own host: importing the loader registers every enabled built-in, as at startup.
type Contributed = { owner: string; id: string; when?: (x: never) => boolean };
const agentCommands = () =>
  (featurePaletteCommands.list() as Contributed[]).filter((c) => c.owner === "builtin:agent");
const ctx = {
  hasWorkspace: true,
  isCompactFileMode: false,
  activeFilePath: "/ws/Docs/n.md",
} as never;

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  usePaneStore.setState({ open: false, width: 420 });
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
    const compact = {
      hasWorkspace: true,
      isCompactFileMode: true,
      activeFilePath: "/ws/Docs/n.md",
    } as never;
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
    expect(usePaneStore.getState().open).toBe(false);
  });
});

describe("dock sync (activation)", () => {
  it("adopts the saved pane state at startup and when Settings changes it, and stops with the feature", async () => {
    // Activate again from a clean slate so the sync runs against this test's state.
    await host.deactivate("agent");
    useSettingsStore.setState({ settings: { "agent.pane-open": true, "agent.pane-width": 500 } });
    await host.activate("agent");
    expect(usePaneStore.getState().open).toBe(true);
    expect(usePaneStore.getState().width).toBe(500);

    useSettingsStore.setState({ settings: { "agent.pane-open": false, "agent.pane-width": 500 } });
    expect(usePaneStore.getState().open).toBe(false);

    await host.deactivate("agent");
    useSettingsStore.setState({ settings: { "agent.pane-open": true, "agent.pane-width": 500 } });
    expect(usePaneStore.getState().open).toBe(false);
  });

  it("never touches the chat store: an open pane at startup needs the pane, not the store", async () => {
    const restore = vi.fn(async () => {});
    useAgentStore.setState({ restoreChats: restore });
    await host.deactivate("agent");
    useSettingsStore.setState({ settings: { "agent.pane-open": true } });
    await host.activate("agent");
    useWorkspaceStore.setState({ root: "/other" });
    expect(restore).not.toHaveBeenCalled();
  });
});

// The startup graph: `web/index.ts` is loaded eagerly, so what it imports statically lands in the
// entry chunk. The chat store, the reducer, the components and the rest of `web/lib` must stay
// behind dynamic imports (bundle numbers in the CHANGELOG).
describe("the startup graph of the agent feature", () => {
  const reached = [...staticGraph(join(DESKTOP, "features/agent/web/index.ts"))].map((f) =>
    relative(DESKTOP, f),
  );

  it("does not reach the chat store, the pane or the transcript code", () => {
    const heavy = reached.filter(
      (f) =>
        f.startsWith("features/agent/web/components/") ||
        f.startsWith("features/agent/web/hooks/") ||
        f === "features/agent/web/stores/agent-store.ts" ||
        f === "features/agent/web/lib/reduce.ts" ||
        f === "features/agent/web/lib/chat-note.ts",
    );
    expect(heavy).toEqual([]);
  });

  it("holds the light state the dock needs", () => {
    expect(reached).toContain("features/agent/web/stores/pane-store.ts");
    expect(reached).toContain("features/agent/web/stores/projects-store.ts");
  });
});

describe("core and the agent feature", () => {
  it("no file of src/ imports the feature (it reaches core only through contribution points)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(DESKTOP, "src"))) {
      for (const { spec } of importsOf(file)) {
        const target = resolveSpec(file, spec);
        if (target && relative(DESKTOP, target).startsWith("features/agent/"))
          offenders.push(`${relative(DESKTOP, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contributes the project entry points: dialog, folder menu item, tree badge", () => {
    expect(manifest.contributes.overlays).toEqual([
      "agent.new-project-dialog",
      "agent.archive-project-dialog",
    ]);
    expect(manifest.contributes.menus).toEqual({ "sidebar-folder": ["agent.make-project"] });
    expect(manifest.contributes.fileTreeDecorations).toEqual(["agent.project-badge"]);
    expect(overlayContributions.has("agent.new-project-dialog")).toBe(true);
    expect(overlayContributions.has("agent.archive-project-dialog")).toBe(true);
    expect(fileTreeDecorationContributions.has("agent.project-badge")).toBe(true);
    expect(menuContributions.has(menuKey("sidebar-folder", "agent.make-project"))).toBe(true);
  });

  it("with the feature off there is no badge, no dialog and no folder item", async () => {
    useSettingsStore.setState({ settings: { "features.agent.enabled": false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(overlayContributions.has("agent.new-project-dialog")).toBe(false);
    expect(overlayContributions.has("agent.archive-project-dialog")).toBe(false);
    expect(fileTreeDecorationContributions.has("agent.project-badge")).toBe(false);
    expect(menuContributions.has(menuKey("sidebar-folder", "agent.make-project"))).toBe(false);
  });
});
