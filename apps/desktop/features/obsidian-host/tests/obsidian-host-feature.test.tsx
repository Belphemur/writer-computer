// The Obsidian host as a built-in feature: registration through the registries, the lifecycle
// (attach, detach, trust gate left to `attach`), the kill switch (no host, no pages, no browser),
// the Settings order, and the guard on a host that fails to boot.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "features_status" ? { safeMode: false, crashDisabled: [], failures: [] } : [],
  ),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { syncBuiltinFeatures } from "@/lib/features/builtin";
import { dockContributions } from "@/lib/features/docks";
import { overlayContributions } from "@/lib/features/overlays";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { featurePaletteCommands, featurePaletteSources } from "@/lib/features/palette";
import { slotContributions } from "@/lib/features/slots";
import {
  emitFileChanged,
  emitSecretChanged,
  emitSecretsReady,
  workspaceListeners,
} from "@/lib/features/workspace-events";
import { createFeatureHost, featureHost } from "@/lib/features/registry";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { buildSettingsNav } from "@/components/settings-panel/settings-sections";
import { resolveCommands } from "@/components/command-palette/commands";
import { useFeatureHealth, isOffForSession } from "@/stores/feature-health-store";
import { usePluginsStore } from "../web/stores/plugins-store";
import { useUpdatesStore } from "../web/stores/plugin-updates-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePluginBrowserStore } from "../web/stores/plugin-browser-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import manifest from "../feature.json";
import obsidianHost from "../web/index";
import { hostRoot, startHostLifecycle } from "../web/lifecycle";
import { syncSettingsPages } from "../web/settings-pages";

const host = createFeatureHost({ onError: () => {} });
const features = [{ manifest, definition: obsidianHost }];
function mine<T extends { owner: string }>(xs: T[]): T[] {
  return xs.filter((x) => x.owner === "builtin:obsidian-host");
}
/** The registries' types do not resolve in the test program (core imports through `@/`). */
const asContributions = (xs: object[]) =>
  xs as unknown as { id: string; slot: string; load: () => Promise<never> }[];
const hostSections = () =>
  settingsSectionContributions
    .list()
    .filter((x: { owner: string }) => x.owner === "builtin:obsidian-host");
// Commands, docks, overlays, Settings pages, slots, palette sources, workspace listeners, editor
// extensions: everything the feature puts into a registry.
const counts = () => [
  mine(featurePaletteCommands.list()).length,
  mine(dockContributions.list()).length,
  mine(overlayContributions.list()).length,
  hostSections().length,
  mine(slotContributions.list()).length,
  mine(featurePaletteSources.list()).length,
  mine(workspaceListeners.list()).length,
  mine(editorExtensionContributions.list()).length,
];

const attach = vi.fn(async () => {});
const detach = vi.fn(async () => {});
const attachRoot = vi.fn(async () => {});
const stopChecks = vi.fn();
const startScheduler = vi.fn(() => stopChecks);

beforeEach(async () => {
  vi.clearAllMocks();
  // Importing the loader starts the real one; keep it from also running this feature.
  useSettingsStore.setState({ settings: { "features.obsidian-host.enabled": false } });
  await featureHost.unregister("obsidian-host");
  usePluginsStore.setState({
    attach,
    detach,
    bootError: null,
    settingTabs: [],
    snapshot: null,
  } as never);
  useUpdatesStore.setState({ attachRoot, startScheduler, available: {} } as never);
  useWorkspaceStore.setState({ root: null, isStartupResolved: true, chromeMode: "workspace" });
  useFeatureHealth.setState({ failures: {}, sessionOff: {}, safeMode: false });
});

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  useWorkspaceStore.setState({ root: null });
});

describe("registration", () => {
  it("registers its commands, dock and overlay, and removes exactly them", async () => {
    host.register(obsidianHost);
    expect(counts()).toEqual([2, 1, 1, 0, 4, 1, 1, 1]);
    expect(manifest.contributes.docks).toEqual(["obsidian-host.pane"]);
    await host.activate("obsidian-host");
    expect(counts()[3]).toBe(1); // Manage plugins
    await host.unregister("obsidian-host");
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("contributes the two palette commands under the feature prefix", () => {
    host.register(obsidianHost);
    useWorkspaceStore.setState({ root: "/v" });
    const ctx = { hasWorkspace: true, isCompactFileMode: false, activeFilePath: null } as never;
    const ids = resolveCommands(ctx).map((c) => c.id);
    expect(ids).toContain("obsidian-host.browse-plugins");
    // the pane toggle needs a plugin leaf
    expect(ids).not.toContain("obsidian-host.toggle-pane");
    usePluginsStore.setState({ leaves: [{}] } as never);
    expect(resolveCommands(ctx).map((c) => c.id)).toContain("obsidian-host.toggle-pane");
    usePluginsStore.setState({ leaves: [] } as never);
  });

  it("lists the plugin commands that can run, after the built-ins, and runs them on the next tick", () => {
    vi.useFakeTimers();
    try {
      host.register(obsidianHost);
      const run = vi.fn();
      usePluginsStore.setState({
        commands: [
          { id: "p:go", name: "Plug: Go", isAvailable: () => true, run },
          { id: "p:off", name: "Plug: Off", isAvailable: () => false, run: vi.fn() },
        ],
      } as never);
      const close = vi.fn();
      const ctx = {
        hasWorkspace: true,
        isCompactFileMode: false,
        activeFilePath: null,
        close,
      } as never;
      const list = resolveCommands(ctx);
      expect(list.map((c) => c.id)).toContain("p:go");
      expect(list.map((c) => c.id)).not.toContain("p:off");
      list.find((c) => c.id === "p:go")!.run();
      expect(close).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      usePluginsStore.setState({ commands: [] } as never);
      vi.useRealTimers();
    }
  });

  it("opens the plugin browser from its command", () => {
    host.register(obsidianHost);
    useWorkspaceStore.setState({ root: "/v" });
    const ctx = {
      hasWorkspace: true,
      isCompactFileMode: false,
      activeFilePath: null,
      close: () => {},
    } as never;
    resolveCommands(ctx)
      .find((c) => c.id === "obsidian-host.browse-plugins")!
      .run();
    return vi.waitFor(() => expect(usePluginBrowserStore.getState().isOpen).toBe(true));
  });
});

describe("lifecycle", () => {
  it("follows the workspace: attach, switch, detach; never for the welcome or compact window", () => {
    const stop = startHostLifecycle();
    expect(attach).not.toHaveBeenCalled();
    useWorkspaceStore.setState({ root: "/a" });
    expect(attach).toHaveBeenCalledWith("/a");
    expect(attachRoot).toHaveBeenCalledWith("/a");
    expect(startScheduler).toHaveBeenCalledTimes(1);
    useWorkspaceStore.setState({ root: "/b" });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenLastCalledWith("/b");
    stop();
    expect(detach).toHaveBeenCalledTimes(2);
    expect(stopChecks).toHaveBeenCalledTimes(2);
    expect(attachRoot).toHaveBeenLastCalledWith(null);
  });

  it("does not attach before startup resolves or without a root", () => {
    expect(hostRoot({ root: "/a", chromeMode: "workspace", isStartupResolved: false })).toBeNull();
    expect(
      hostRoot({ root: null, chromeMode: "compact-file", isStartupResolved: true }),
    ).toBeNull();
    expect(hostRoot({ root: "/a", chromeMode: "workspace", isStartupResolved: true })).toBe("/a");
  });

  it("activates on workspace open and detaches when the feature is switched off", async () => {
    const sync = (settings: Record<string, unknown>) =>
      syncBuiltinFeatures(
        host,
        features,
        settings,
        () => false,
        () => useWorkspaceStore.getState().root !== null,
      );
    sync({});
    expect(host.state("obsidian-host")).toBe("registered");
    expect(attach).not.toHaveBeenCalled(); // no workspace yet
    useWorkspaceStore.setState({ root: "/v" });
    sync({});
    await vi.waitFor(() => expect(host.state("obsidian-host")).toBe("active"));
    expect(attach).toHaveBeenCalledWith("/v");
  });
});

describe("kill switch", () => {
  it("off: nothing registers, no host attaches, no pages, no browser", async () => {
    useWorkspaceStore.setState({ root: "/v" });
    syncBuiltinFeatures(
      host,
      features,
      { "features.obsidian-host.enabled": false },
      () => false,
      () => true,
    );
    expect(host.list()).toEqual([]);
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(attach).not.toHaveBeenCalled();
  });

  it("switching off while running detaches the host and closes the browser", async () => {
    useWorkspaceStore.setState({ root: "/v" });
    const on = () =>
      syncBuiltinFeatures(
        host,
        features,
        {},
        () => false,
        () => true,
      );
    on();
    await vi.waitFor(() => expect(attach).toHaveBeenCalled());
    usePluginBrowserStore.getState().open();
    syncBuiltinFeatures(
      host,
      features,
      { "features.obsidian-host.enabled": false },
      () => false,
      () => true,
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalled());
    expect(usePluginBrowserStore.getState().isOpen).toBe(false);
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("contributions to core UI", () => {
  it("mounts the ribbon, the status strip and the tab bodies of the plugin page kinds in their slots", () => {
    host.register(obsidianHost);
    expect(
      asContributions(mine(slotContributions.list()))
        .map((s) => s.slot)
        .sort(),
    ).toEqual([
      "editor-status",
      "page-view:plugin-file",
      "page-view:plugin-view",
      "sidebar-ribbon",
    ]);
  });

  it("forwards what core tells features to the plugins store, only while it is on", async () => {
    const notifyExternal = vi.fn(async () => {});
    const syncSecret = vi.fn();
    const retrySecrets = vi.fn(async () => {});
    usePluginsStore.setState({ notifyExternal, syncSecret, retrySecrets } as never);
    await emitFileChanged("modify", "/v/a.md");
    expect(notifyExternal).not.toHaveBeenCalled();
    host.register(obsidianHost);
    await emitFileChanged("modify", "/v/a.md");
    await emitSecretChanged("k", "v");
    await emitSecretChanged("k", null);
    await emitSecretsReady();
    expect(notifyExternal).toHaveBeenCalledWith("modify", "/v/a.md");
    expect(syncSecret.mock.calls).toEqual([
      ["k", "v"],
      ["k", null],
    ]);
    expect(retrySecrets).toHaveBeenCalledTimes(1);
  });

  it("contributes the plugin editor extension, built on demand with the shared compartment", async () => {
    host.register(obsidianHost);
    const [contribution] = asContributions(mine(editorExtensionContributions.list()));
    expect(contribution?.id).toBe("obsidian-host.editor");
    const { pluginExtensionCompartment } = await import("../web/host/editor-bridge");
    const { EditorState } = await import("@codemirror/state");
    const extension = await contribution!.load();
    const state = EditorState.create({ extensions: extension });
    expect(pluginExtensionCompartment.get(state)).toBeDefined();
  });
});

describe("running plugins published to core", () => {
  it("lists the enabled plugins while the feature is active and clears them when it stops", async () => {
    const { isCommunityPluginRunning } = await import("@/lib/community-plugins");
    const status = (id: string, state: string) => ({ [id]: { state } });
    usePluginsStore.setState({
      snapshot: { status: { ...status("a", "enabled"), ...status("b", "failed") } },
    } as never);
    host.register(obsidianHost);
    await host.activate("obsidian-host");
    expect(isCommunityPluginRunning("a")).toBe(true);
    expect(isCommunityPluginRunning("b")).toBe(false);
    usePluginsStore.setState({ snapshot: { status: status("b", "enabled") } } as never);
    expect(isCommunityPluginRunning("a")).toBe(false);
    expect(isCommunityPluginRunning("b")).toBe(true);
    await host.unregister("obsidian-host");
    expect(isCommunityPluginRunning("b")).toBe(false);
  });
});

describe("guard on a failing host boot", () => {
  it("a boot error switches the feature off for the session, not the app", async () => {
    attach.mockImplementationOnce(async () => {
      usePluginsStore.setState({ bootError: "Plugins failed to start: boom" } as never);
    });
    useWorkspaceStore.setState({ root: "/v" });
    const sync = () =>
      syncBuiltinFeatures(
        host,
        features,
        {},
        (id) => isOffForSession(useFeatureHealth.getState(), id),
        () => true,
      );
    sync();
    await vi.waitFor(() =>
      expect(isOffForSession(useFeatureHealth.getState(), "obsidian-host")).toBe(true),
    );
    expect(useFeatureHealth.getState().failures["obsidian-host"]?.boundary).toBe("boot");
    sync(); // what the loader does when the health store changes
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detach).toHaveBeenCalled();
  });

  it("calls onBootFailure with the host's message", async () => {
    const onBootFailure = vi.fn();
    const stop = startHostLifecycle({
      plugins: { getState: () => ({ attach: async () => {}, detach, bootError: "x" }) } as never,
      onBootFailure,
    });
    useWorkspaceStore.setState({ root: "/v" });
    await vi.waitFor(() => expect(onBootFailure).toHaveBeenCalledWith("x"));
    stop();
  });
});

describe("Settings pages", () => {
  it("keep the sidebar order: Manage plugins, then one page per plugin tab, in Community plugins", () => {
    const tab = (id: string, name: string) => ({ owner: id, tab: { id, name } });
    usePluginsStore.setState({
      settingTabs: [tab("copilot", "Copilot"), tab("tasks", "Tasks")],
    } as never);
    const stop = syncSettingsPages();
    const sections = hostSections();
    const groups = buildSettingsNav({ hasWorkspace: true, featureSections: sections });
    expect(groups.map((g) => g.group)).toEqual(["General", "Community plugins"]);
    expect(groups[0]!.items.map((i) => i.label)).toEqual([
      "Editor",
      "Appearance",
      "Files & vault",
      "Features",
      "Privacy",
      "Secrets",
      "Command line",
      "Logs",
    ]);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(["Manage plugins", "Copilot", "Tasks"]);
    expect(sections.find((s: { footer?: unknown }) => s.footer)?.footer?.label).toBe(
      "Browse plugins…",
    );
    expect(
      buildSettingsNav({ hasWorkspace: false, featureSections: sections }).map((g) => g.group),
    ).toEqual(["General"]);
    usePluginsStore.setState({ settingTabs: [tab("copilot", "Copilot")] } as never);
    expect(hostSections()).toHaveLength(2);
    stop();
    expect(hostSections()).toHaveLength(0);
  });

  it("badges Manage plugins with the update count", () => {
    useUpdatesStore.setState({ available: { a: {}, b: {} } } as never);
    const stop = syncSettingsPages();
    expect(settingsSectionContributions.get("community-plugins")?.badge).toBe(2);
    stop();
  });
});

describe("boundaries", () => {
  it("core names no part of the feature, and the feature's UI never imports the shim's API files", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const sources = (dir: string, skip = ""): string[] =>
      readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
        .map((e) => `${e.parentPath}/${e.name}`)
        .filter((f) => !skip || !f.includes(skip));
    // An import specifier (static, dynamic or a mock) that reaches `what`; `import type` is
    // erased, so a type-only import never loads code and is not counted.
    const reaches = (file: string, what: RegExp) =>
      [
        ...readFileSync(file, "utf8")
          .replace(/import type[^;]*;/g, "")
          .matchAll(/(?:from|import\()\s*["'`]([^"'`]+)["'`]/g),
      ].some((m) => what.test(m[1]!));
    expect(sources("src").filter((f) => reaches(f, /obsidian-host/))).toEqual([]);
    // Another feature reaches the host's state through core (`lib/community-plugins.ts`).
    expect(
      ["features/agent/web", "features/tables/web"]
        .flatMap((d) => sources(d))
        .filter((f) => reaches(f, /obsidian-host/)),
    ).toEqual([]);
    expect(
      sources("features/obsidian-host/web", "/host/").filter((f) => reaches(f, /host\/api\//)),
    ).toEqual([]);
  });

  it("the manifest lists the palette commands the definition registers", () => {
    expect(manifest.contributes.commands.map((c: { id: string }) => c.id).sort()).toEqual(
      (obsidianHost.contributes?.commands ?? []).map((c: { id: string }) => c.id).sort(),
    );
  });
});
