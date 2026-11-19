// The hotkeys feature as a built-in feature (registers and unregisters cleanly, kill switch, manifest
// matches the code, core never imports it) and its pure parts: the page's rows, the two searches,
// the Obsidian import mapping, and the actions on a private registry (record, reassign, remove,
// reset).
// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { featurePaletteCommands } from "@/lib/features/palette";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { createFeatureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { HotkeyOverrides } from "@/lib/keybindings/overrides";
import { KeybindingRegistry, type Keybinding } from "@/lib/keybindings/registry";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import hotkeys from "../web/index";
import {
  checkChord,
  importFromObsidian,
  recordKey,
  removeKey,
  resetAllKeys,
  resetKeys,
} from "../web/actions";
import { buildGroups, filterGroups, groupOf, mapObsidianHotkeys } from "../web/model";

const host = createFeatureHost({ onError: () => {} });
const features = [{ manifest, definition: hotkeys }];
const mine = (o: { owner: string }) => o.owner === "builtin:hotkeys";

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("hotkeys feature registration", () => {
  it("registers its command and page and removes exactly them on unregister", async () => {
    host.register(hotkeys);
    expect(featurePaletteCommands.list().filter(mine)).toHaveLength(1);
    expect(
      settingsSectionContributions
        .list()
        .filter(mine)
        .map((s) => s.id),
    ).toEqual(["hotkeys"]);
    await host.unregister("hotkeys");
    expect(featurePaletteCommands.list().filter(mine)).toHaveLength(0);
    expect(settingsSectionContributions.list().filter(mine)).toHaveLength(0);
  });

  it("is switched off by features.hotkeys.enabled = false and back on again", async () => {
    syncBuiltinFeatures(host, features, { "features.hotkeys.enabled": false });
    expect(host.list()).toEqual([]);
    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toEqual(["hotkeys"]);
    syncBuiltinFeatures(host, features, { "features.hotkeys.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(settingsSectionContributions.list().filter(mine)).toHaveLength(0);
  });

  it("is on by default, and its manifest matches the code", () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    expect(hotkeys.id).toBe(manifest.id);
    for (const c of manifest.contributes.commands) expect(c.id.startsWith("hotkeys.")).toBe(true);
    expect(manifest.rust.commands).toEqual([]);
  });

  it("has its kill switch in the shared settings schema", () => {
    expect(schema.settings.find((e) => e.key === "features.hotkeys.enabled")).toEqual({
      key: "features.hotkeys.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });

  it("is not imported by core (the keys stay in force with the feature off)", () => {
    const src = resolve(import.meta.dirname, "../../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && /features\/hotkeys/.test(readFileSync(p, "utf8")))
          offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- model

const always = {
  "not-compact": () => true,
  "editor-not-focused": () => true,
  "outside-agent-pane": () => true,
  "image-viewer": () => true,
  "pdf-viewer": () => true,
  "no-viewer": () => true,
};
const binding = (
  id: string,
  keys: Keybinding["keys"],
  over: Partial<Keybinding> = {},
): Keybinding => ({
  id,
  keys,
  description: id,
  category: "Feature",
  run: () => {},
  ...over,
});
function world() {
  const registry = new KeybindingRegistry(always, () => "macos");
  registry.add("core", binding("reopen", ["Mod+Shift+T"], { description: "Reopen the last tab" }));
  registry.add("core", binding("jump", ["Mod+1"], { rebindable: false, description: "Jump" }));
  registry.addCommand("core", { id: "theme", description: "Toggle Dark Mode", run: () => {} });
  registry.addCommand("builtin:graph", {
    id: "graph.open",
    description: "Open graph",
    run: () => {},
  });
  registry.add(
    "excalidraw",
    binding("excalidraw:save", ["Mod+S"], {
      group: "Excalidraw (plugin)",
      description: "Excalidraw: Save",
    }),
    { strict: false },
  );
  const writes: string[] = [];
  const overrides = new HotkeyOverrides(registry, () => "mac", {
    read: async () => null,
    write: async (t) => void writes.push(t),
  });
  const labels: Record<string, string> = { reopen: "Reopen Closed Tab", theme: "Toggle Dark Mode" };
  return { registry, overrides, writes, labelOf: (id: string) => labels[id] };
}
const section = (w: ReturnType<typeof world>) =>
  JSON.parse(w.writes.at(-1)!).mac as Record<string, string[]>;

describe("the page's rows", () => {
  it("group by owner: Writer, then features by name, then plugins; the palette's name wins", () => {
    const w = world();
    const groups = buildGroups(w.registry, w.labelOf);
    expect(groups.map((g) => g.name)).toEqual(["Writer", "Graph", "Excalidraw (plugin)"]);
    const writer = groups[0]!.rows;
    expect(writer.map((r) => r.label)).toEqual(["Jump", "Reopen Closed Tab", "Toggle Dark Mode"]);
    const reopen = writer.find((r) => r.id === "reopen")!;
    expect(reopen).toMatchObject({ chords: ["Mod+Shift+T"], modified: false, rebindable: true });
    expect(writer.find((r) => r.id === "jump")!.rebindable).toBe(false);
    expect(writer.find((r) => r.id === "theme")!.chords).toEqual([]);
  });

  it("shows the effective keys and the modified mark", () => {
    const w = world();
    w.registry.setOverrides({ reopen: ["Mod+Shift+K", "Alt+K"] });
    const row = buildGroups(w.registry, w.labelOf)[0]!.rows.find((r) => r.id === "reopen")!;
    expect(row).toMatchObject({ chords: ["Mod+Shift+K", "Alt+K"], modified: true });
  });

  it("names a feature's group from its manifest and a plain owner as itself", () => {
    expect(groupOf({ owner: "core" })).toBe("Writer");
    expect(groupOf({ owner: "builtin:graph" })).toBe("Graph");
    expect(groupOf({ owner: "something" })).toBe("something");
    expect(groupOf({ owner: "p", group: "X (plugin)" })).toBe("X (plugin)");
  });

  it("searches by name or group, and by a pressed key", () => {
    const w = world();
    const groups = buildGroups(w.registry, w.labelOf);
    const ids = (q: Parameters<typeof filterGroups>[1]) =>
      filterGroups(groups, q).flatMap((g) => g.rows.map((r) => r.id));
    expect(ids({ kind: "text", text: "" })).toHaveLength(5);
    expect(ids({ kind: "text", text: "dark" })).toEqual(["theme"]);
    expect(ids({ kind: "text", text: "EXCALIDRAW" })).toEqual(["excalidraw:save"]);
    expect(ids({ kind: "text", text: "zzz" })).toEqual([]);
    expect(ids({ kind: "chord", chord: "Mod+Shift+T" })).toEqual(["reopen"]);
    expect(ids({ kind: "chord", chord: "Mod+Shift+Y" })).toEqual([]);
  });
});

describe("Obsidian import mapping", () => {
  const registry = world().registry;
  it("maps known commands for this OS and counts what it skips", () => {
    const text = JSON.stringify({
      reopen: [{ modifiers: ["Mod", "Shift"], key: "k" }],
      "excalidraw:save": [],
      "app:go-back": [{ modifiers: ["Mod"], key: "[" }], // an Obsidian core command: not in Writer
      theme: [{ modifiers: ["Mod"], key: "q" }], // reserved here: nothing usable
      "graph.open": [{ modifiers: ["Weird"], key: "g" }], // unknown modifier
      jump: [{ modifiers: ["Mod"], key: "j" }], // not rebindable
    });
    const r = mapObsidianHotkeys(text, registry);
    expect(r.keys).toEqual({ reopen: ["Mod+Shift+K"], "excalidraw:save": [] });
    expect(r.imported).toBe(2);
    expect(r.skipped).toBe(4);
  });

  it("keeps the usable keys of a command whose other keys cannot map", () => {
    const r = mapObsidianHotkeys(
      JSON.stringify({
        reopen: [
          { modifiers: ["Nope"], key: "a" },
          { modifiers: ["Alt"], key: "r" },
          { modifiers: ["Alt"], key: "r" },
        ],
      }),
      registry,
    );
    expect(r.keys).toEqual({ reopen: ["Alt+R"] });
  });

  it("refuses a file that is not a JSON object", () => {
    expect(() => mapObsidianHotkeys("nope", registry)).toThrow(/not valid JSON/);
    expect(() => mapObsidianHotkeys("[]", registry)).toThrow(/not an object/);
  });
});

describe("actions", () => {
  it("checks a chord: refused, taken (context-aware), or free", () => {
    const w = world();
    expect(checkChord("theme", "Mod+Q", w.registry)).toEqual({
      kind: "refused",
      reason: "reserved",
    });
    expect(checkChord("theme", "K", w.registry)).toEqual({
      kind: "refused",
      reason: "needs-modifier",
    });
    expect(checkChord("theme", "Mod+Shift+T", w.registry)).toEqual({
      kind: "conflict",
      id: "reopen",
    });
    expect(checkChord("reopen", "Mod+Shift+T", w.registry)).toEqual({ kind: "ok" });
    expect(checkChord("theme", "Mod+Shift+D", w.registry)).toEqual({ kind: "ok" });
  });

  it("records a key that replaces, or adds a second one", async () => {
    const w = world();
    await recordKey("reopen", "Mod+Shift+K", { mode: "replace" }, w.overrides, w.registry);
    expect(section(w)).toEqual({ reopen: ["Mod+Shift+K"] });
    await recordKey("reopen", "Alt+K", { mode: "add" }, w.overrides, w.registry);
    expect(w.registry.effectiveKeys("reopen")).toEqual(["Mod+Shift+K", "Alt+K"]);
    // adding to a command that still has its defaults keeps them
    await recordKey("jump", "Mod+Alt+J", { mode: "add" }, w.overrides, w.registry);
    expect(w.registry.effectiveKeys("jump")).toEqual(["Mod+1", "Mod+Alt+J"]);
  });

  it("stores no override when the keys equal the defaults", async () => {
    const w = world();
    await recordKey("reopen", "Mod+Shift+K", { mode: "replace" }, w.overrides, w.registry);
    await recordKey("reopen", "Mod+Shift+T", { mode: "replace" }, w.overrides, w.registry);
    expect(section(w)).toEqual({});
    expect(w.registry.isModified("reopen")).toBe(false);
  });

  it("refuses a reserved key, and a taken one unless it is reassigned", async () => {
    const w = world();
    await expect(
      recordKey("theme", "Mod+Q", { mode: "replace" }, w.overrides, w.registry),
    ).rejects.toThrow("Reserved by the system");
    await expect(
      recordKey("theme", "Mod+Shift+T", { mode: "replace" }, w.overrides, w.registry),
    ).rejects.toThrow(/used by another command/);
    expect(w.writes).toEqual([]);
  });

  it("reassigns: the key leaves the other command and arrives here in one save", async () => {
    const w = world();
    await recordKey(
      "theme",
      "Mod+Shift+T",
      { mode: "replace", reassign: true },
      w.overrides,
      w.registry,
    );
    expect(w.writes).toHaveLength(1);
    expect(section(w)).toEqual({ reopen: [], theme: ["Mod+Shift+T"] });
    expect(w.registry.effectiveKeys("reopen")).toEqual([]);
    expect(w.registry.effectiveKeys("theme")).toEqual(["Mod+Shift+T"]);
  });

  it("reassigning one of two keys leaves the other with its command", async () => {
    const w = world();
    w.registry.setOverrides({ reopen: ["Mod+Shift+T", "Alt+R"] });
    await recordKey(
      "theme",
      "Mod+Shift+T",
      { mode: "replace", reassign: true },
      w.overrides,
      w.registry,
    );
    expect(w.registry.effectiveKeys("reopen")).toEqual(["Alt+R"]);
  });

  it("removes one key, resets one command, resets all", async () => {
    const w = world();
    w.registry.setOverrides({ reopen: ["Mod+Shift+K", "Alt+K"] });
    await removeKey("reopen", "Alt+K", w.overrides, w.registry);
    expect(w.registry.effectiveKeys("reopen")).toEqual(["Mod+Shift+K"]);
    await removeKey("reopen", "Mod+Shift+K", w.overrides, w.registry);
    expect(w.registry.effectiveKeys("reopen")).toEqual([]);
    await resetKeys("reopen", w.overrides);
    expect(w.registry.effectiveKeys("reopen")).toEqual(["Mod+Shift+T"]);
    await recordKey("theme", "Mod+Shift+D", { mode: "replace" }, w.overrides, w.registry);
    await resetAllKeys(w.overrides);
    expect(section(w)).toEqual({});
    expect(w.registry.isModified("theme")).toBe(false);
  });

  it("imports what maps, writes it once, and reports null when the vault has no file", async () => {
    const w = world();
    const text = JSON.stringify({
      reopen: [{ modifiers: ["Mod", "Shift"], key: "k" }],
      "app:go-back": [{ modifiers: ["Mod"], key: "[" }],
    });
    const r = await importFromObsidian(w.overrides, w.registry, async () => text);
    expect(r).toMatchObject({ imported: 1, skipped: 1 });
    expect(w.writes).toHaveLength(1);
    expect(section(w)).toEqual({ reopen: ["Mod+Shift+K"] });
    expect(await importFromObsidian(w.overrides, w.registry, async () => null)).toBeNull();
    // nothing to import: no write
    await importFromObsidian(w.overrides, w.registry, async () => '{"app:x":[]}');
    expect(w.writes).toHaveLength(1);
  });
});
