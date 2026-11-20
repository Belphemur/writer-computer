// The Icons feature as a built-in feature: registers and unregisters cleanly, the kill switch
// removes every surface and clears the icons, activation loads what Rust resolves and follows the
// workspace and the change event, the picker writes through the commands and reloads, the menus
// offer "Change icon...", and neither core nor the startup chunk reaches the feature's modules.
// Rust twin: `features::icons::tests` and `icons::tests`. Spec: SPECs/icons-spec.md.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { staticGraph } from "@tests/helpers/import-graph";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { menuContributions, contributedMenuItems } from "@/lib/features/menus";
import { overlayContributions } from "@/lib/features/overlays";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { slotContributions } from "@/lib/features/slots";
import { createFeatureHost, featureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { clearFileIcons, fileIconOf, useFileIconStore } from "@/lib/file-icons";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import icons from "../web";
import { openIconPicker, useIconPickerStore } from "../web/picker-store";
import IconPickerOverlay from "../web/picker";
import { useIconizeStatus } from "../web/sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The picker's virtualized grid needs a size jsdom does not have.
for (const name of ["offsetHeight", "clientHeight"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 216 });
for (const name of ["offsetWidth", "clientWidth"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 316 });

const listeners = new Map<string, () => void>();
const host = createFeatureHost({
  onError: () => {},
  listen: (async (name: string, cb: (e: never) => void) => {
    listeners.set(name, () => cb({ payload: null } as never));
    return () => listeners.delete(name);
  }) as never,
});
const features = [{ manifest, definition: icons }];
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:icons").length;
const counts = () => [
  mine(menuContributions.list()),
  mine(overlayContributions.list()),
  mine(slotContributions.list()),
  mine(editorExtensionContributions.list()),
  mine(settingsSectionContributions.list()),
];

let rows: { path: string; icon: string; color?: string; source: string }[];
let unsupported: number;

beforeEach(async () => {
  // The app's own host has the real feature (it loads every built-in): this file drives its own.
  if (featureHost.list().includes("icons")) await featureHost.unregister("icons");
  rows = [{ path: "Notes/Idea.md", icon: "emoji:🚀", source: "writer" }];
  unsupported = 2;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:icons|icons_resolved")
      return { icons: rows, iconizeUnsupported: unsupported };
    return null;
  });
  listeners.clear();
  useWorkspaceStore.setState({ root: "/vault" });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
  useIconPickerStore.getState().close();
  clearFileIcons();
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("registration", () => {
  it("registers every contribution and removes exactly them on unregister", async () => {
    host.register(icons);
    expect(counts()).toEqual([4, 1, 0, 2, 1]);
    await host.unregister("icons");
    expect(counts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("is on by default and switched off by features.icons.enabled, which clears the icons", async () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    syncBuiltinFeatures(host, features, {});
    await vi.waitFor(() => expect(fileIconOf("/vault/Notes/Idea.md")?.icon).toBe("emoji:🚀"));
    syncBuiltinFeatures(host, features, { "features.icons.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(counts()).toEqual([0, 0, 0, 0, 0]);
    expect(fileIconOf("/vault/Notes/Idea.md")).toBeUndefined();
    expect(useFileIconStore.getState().icons.size).toBe(0);
    expect(await contributedMenuItems("sidebar-file", { path: "/vault/a.md" } as never)).toEqual(
      [],
    );
  });

  it("a throwing activation is contained", async () => {
    const failures: string[] = [];
    const h = createFeatureHost({ onError: () => {}, onFailure: (id) => failures.push(id) });
    h.register({
      id: "icons",
      activate() {
        throw new Error("boom");
      },
    });
    await expect(h.activate("icons")).rejects.toThrow("boom");
    expect(failures).toEqual(["icons"]);
    await h.unregister("icons");
  });
});

describe("activation", () => {
  it("loads the resolved icons into core's store and keeps Iconize's unsupported count", async () => {
    host.register(icons);
    await host.activate("icons");
    await vi.waitFor(() => expect(fileIconOf("/vault/Notes/Idea.md")?.icon).toBe("emoji:🚀"));
    expect(useIconizeStatus.getState().unsupported).toBe(2);
    expect(invoke).toHaveBeenCalledWith("plugin:icons|icons_resolved", undefined);
  });

  it("reloads when the backend reports a change on disk and when the workspace changes", async () => {
    host.register(icons);
    await host.activate("icons");
    await vi.waitFor(() => expect(fileIconOf("Notes/Idea.md")).toBeDefined());
    rows = [{ path: "B.md", icon: "emoji:📚", color: "#00ff00", source: "iconize" }];
    listeners.get("icons:changed")!();
    await vi.waitFor(() =>
      expect(fileIconOf("B.md")).toEqual({ icon: "emoji:📚", color: "#00ff00" }),
    );
    expect(fileIconOf("Notes/Idea.md")).toBeUndefined();
    rows = [{ path: "C.md", icon: "emoji:🎯", source: "writer" }];
    act(() => useWorkspaceStore.setState({ root: "/other", workspaceGeneration: 7 }));
    await vi.waitFor(() => expect(fileIconOf("C.md")?.icon).toBe("emoji:🎯"));
  });

  it("without a workspace there are no icons and no call", async () => {
    useWorkspaceStore.setState({ root: null });
    // the app's loader re-registers the real feature on a workspace change; this test drives its own
    if (featureHost.list().includes("icons")) await featureHost.unregister("icons");
    invoke.mockClear();
    host.register(icons);
    await host.activate("icons");
    expect(invoke.mock.calls.filter(([c]) => String(c).startsWith("plugin:icons|"))).toEqual([]);
    expect(useFileIconStore.getState().icons.size).toBe(0);
  });

  it("the newest answer wins over a slow older one", async () => {
    let release!: (v: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)));
    host.register(icons);
    await host.activate("icons");
    rows = [{ path: "New.md", icon: "emoji:🎯", source: "writer" }];
    listeners.get("icons:changed")!();
    await vi.waitFor(() => expect(fileIconOf("New.md")).toBeDefined());
    release({
      icons: [{ path: "Old.md", icon: "emoji:📚", source: "writer" }],
      iconizeUnsupported: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fileIconOf("Old.md")).toBeUndefined();
    expect(fileIconOf("New.md")).toBeDefined();
  });

  it("a failing load keeps the icons as they were", async () => {
    host.register(icons);
    await host.activate("icons");
    await vi.waitFor(() => expect(fileIconOf("Notes/Idea.md")).toBeDefined());
    invoke.mockRejectedValue(new Error("down"));
    listeners.get("icons:changed")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(fileIconOf("Notes/Idea.md")).toBeDefined();
  });
});

describe("menus", () => {
  it("offer Change icon... on a file, a folder, a selection and a tab, and it opens the picker", async () => {
    host.register(icons);
    const entry = { name: "a.md", path: "/vault/a.md", is_dir: false } as never;
    for (const [surface, args] of [
      ["sidebar-file", [entry]],
      ["sidebar-folder", [{ name: "d", path: "/vault/d", is_dir: true }]],
      ["sidebar-bulk", [["/vault/a.md", "/vault/b.md"]]],
      ["editor-tab", ["/vault/a.md"]],
    ] as const) {
      const items = await (
        contributedMenuItems as (s: string, ...a: unknown[]) => Promise<{ text?: string }[]>
      )(surface, ...args);
      // other shipped features may contribute too (the agent's "Make project"): ours is last
      expect(items.map((i) => i.text).at(-1), surface).toBe("Change icon...");
    }
    const [item] = await contributedMenuItems("sidebar-bulk", ["/vault/a.md", "/vault/b.md"]);
    (item as { action: () => void }).action();
    expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md", "/vault/b.md"]);
  });
});

describe("the picker", () => {
  let container: HTMLElement;
  let root: Root;
  // The grid picks on mousedown, like every option of the core picker.
  const pickCell = (cell: HTMLElement) =>
    act(async () => {
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
  // Only this feature's writes: the app's own host boots in the background and its other
  // features (agent projects, the logger) invoke too, at a time that depends on machine load.
  const iconCalls = () =>
    invoke.mock.calls.filter(
      ([c]) => String(c).startsWith("plugin:icons|") && c !== "plugin:icons|icons_resolved",
    );

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    host.register(icons);
    await host.activate("icons");
    await vi.waitFor(() => expect(fileIconOf("Notes/Idea.md")).toBeDefined());
    await act(async () => root.render(<IconPickerOverlay />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("is closed until opened", () => {
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it(
    "sets the picked emoji on every path in one call, reloads and closes",
    { timeout: 20_000 },
    async () => {
      await act(async () => openIconPicker(["/vault/Notes/Idea.md", "/vault/Notes"]));
      expect(container.querySelector("[role=dialog][aria-label='Change icon']")).not.toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>("[role=tab]:last-child")!.click(),
      );
      const cell = await vi.waitFor(
        () => {
          const el = container.querySelector<HTMLElement>("[role=option][data-emoji]");
          expect(el).not.toBeNull();
          return el!;
        },
        { timeout: 15_000 },
      );
      await pickCell(cell);
      await vi.waitFor(() => expect(iconCalls()).toHaveLength(1));
      const [cmd, args] = iconCalls()[0]!;
      expect(cmd).toBe("plugin:icons|icons_set");
      expect(args).toMatchObject({ paths: ["/vault/Notes/Idea.md", "/vault/Notes"], color: null });
      expect((args as { icon: string }).icon).toMatch(/^emoji:/);
      await vi.waitFor(() => expect(container.querySelector("[role=dialog]")).toBeNull());
      expect(
        invoke.mock.calls.filter(([c]) => c === "plugin:icons|icons_resolved").length,
      ).toBeGreaterThanOrEqual(2);
    },
  );

  it("offers Remove icon for one path that has an icon, and removes it", async () => {
    await act(async () => openIconPicker(["/vault/Notes/Idea.md"]));
    const remove = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove icon",
    );
    expect(remove).toBeDefined();
    await act(async () => remove!.click());
    await vi.waitFor(() => expect(iconCalls()).toHaveLength(1));
    expect(iconCalls()[0]).toEqual([
      "plugin:icons|icons_remove",
      { paths: ["/vault/Notes/Idea.md"] },
    ]);
  });

  it("has no Remove icon for a path without one or for a selection", async () => {
    for (const paths of [["/vault/None.md"], ["/vault/Notes/Idea.md", "/vault/Notes/Other.md"]]) {
      await act(async () => openIconPicker(paths));
      expect(
        [...container.querySelectorAll("button")].some((b) => b.textContent === "Remove icon"),
      ).toBe(false);
      await act(async () => useIconPickerStore.getState().close());
    }
  });

  it("shows the error and stays open when the write fails", { timeout: 20_000 }, async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:icons|icons_set") throw "Invalid path: outside the vault";
      return { icons: rows, iconizeUnsupported: 0 };
    });
    await act(async () => openIconPicker(["/vault/Notes/Idea.md"]));
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[role=tab]:last-child")!.click(),
    );
    const cell = await vi.waitFor(
      () => {
        const el = container.querySelector<HTMLElement>("[role=option][data-emoji]");
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 15_000 },
    );
    await pickCell(cell);
    await vi.waitFor(() => expect(container.textContent).toContain("outside the vault"));
    expect(container.querySelector("[role=dialog]")).not.toBeNull();
  });
});

describe("manifest and settings contract", () => {
  it("id equals the folder and the definition; every contributed id is prefixed", () => {
    expect(manifest.id).toBe("icons");
    expect(icons.id).toBe(manifest.id);
    const c = icons.contributes!;
    const ids = [
      ...c.commands!,
      ...c.overlays!,
      ...c.editorExtensions!,
      ...Object.values(c.menus!).flat(),
    ].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("icons."))).toBe(true);
    expect(manifest.contributes.overlays).toEqual(c.overlays!.map((o) => o.id));
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((e) => e.id));
    expect(manifest.contributes.menus).toEqual(
      Object.fromEntries(Object.entries(c.menus!).map(([s, m]) => [s, m.map((i) => i.id)])),
    );
    // the note icon is an editor extension next to the first H1; the old slot above the properties is gone
    expect((c as { slots?: unknown }).slots).toBeUndefined();
    expect("slots" in manifest.contributes).toBe(false);
    expect(c.editorExtensions!.map((e) => e.id)).toContain("icons.note-icon");
  });

  it("has its kill switch in the shared settings schema", () => {
    expect(schema.settings.find((e) => e.key === "features.icons.enabled")).toEqual({
      key: "features.icons.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off. The Rust part takes effect after a restart.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });
});

describe("the Change icon command", () => {
  it("is available with an active file in a workspace window, and opens the picker for it", () => {
    host.register(icons);
    const command = icons.contributes!.commands![0]!;
    const ctx = (over: object) =>
      ({
        hasWorkspace: true,
        isCompactFileMode: false,
        activeFilePath: "/vault/a.md",
        ...over,
      }) as never;
    expect(command.when!(ctx({}))).toBe(true);
    expect(command.when!(ctx({ activeFilePath: null }))).toBe(false);
    expect(command.when!(ctx({ hasWorkspace: false }))).toBe(false);
    expect(command.when!(ctx({ isCompactFileMode: true }))).toBe(false);
    command.run(ctx({}));
    expect(useIconPickerStore.getState().paths).toEqual(["/vault/a.md"]);
  });
});

describe("startup chunk and core independence", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("the feature's index reaches no picker, shortcode or icon data statically", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))].map(rel);
    expect(
      reached.filter((f) => /picker\.tsx|shortcodes|note-icon|icon-picker\/icon-shards/.test(f)),
    ).toEqual([]);
    expect(reached.filter((f) => /@codemirror|emoji\.json/.test(f))).toEqual([]);
  });

  for (const entry of [
    "src/components/sidebar/file-tree-node.tsx",
    "src/components/editor-area/editor-tabs.tsx",
    "src/components/editor-area/editor-pane.tsx",
    "src/components/editor-area/wiki-link-extension.ts",
    "src/components/editor-area/property-wikilink.tsx",
    "src/lib/file-icons.ts",
  ]) {
    it(`${entry} reaches no Icons feature module`, () => {
      const reached = [...staticGraph(resolve(import.meta.dirname, "../../..", entry))].map(rel);
      expect(reached.filter((f) => f.startsWith("features/icons/"))).toEqual([]);
    });
  }
});
