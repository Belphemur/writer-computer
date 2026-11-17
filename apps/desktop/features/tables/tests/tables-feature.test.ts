// The tables feature as a built-in plugin: registers and unregisters cleanly, the kill switch
// removes everything, the manifest matches the code, and core has no static table import.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { editorExtensionContributions } from "../../../src/lib/features/editor-extensions";
import { menuContributions } from "../../../src/lib/features/menus";
import { featurePaletteCommands } from "../../../src/lib/features/palette";
import { createFeatureHost } from "../../../src/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "../../../src/lib/features/builtin";
import schema from "../../../shared/settings.schema.json";
import manifest from "../feature.json";
import tables from "../web/index";
import { TABLE_PALETTE_COMMAND_IDS } from "../web/table-commands";

const host = createFeatureHost({ onError: () => {} });
const features = [{ manifest, definition: tables }];
const counts = () => [
  featurePaletteCommands.list().filter((c: { owner: string }) => c.owner === "builtin:tables")
    .length,
  editorExtensionContributions.list().filter((c: { owner: string }) => c.owner === "builtin:tables")
    .length,
  menuContributions.size,
];

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("tables feature registration", () => {
  it("registers every contribution and removes exactly them on unregister", async () => {
    host.register(tables);
    expect(counts()).toEqual([manifest.contributes.commands.length, 1, 1]);
    await host.unregister("tables");
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("is disabled by features.tables.enabled = false and contributes nothing", async () => {
    syncBuiltinFeatures(host, features, { "features.tables.enabled": false });
    expect(host.list()).toEqual([]);
    expect(counts()).toEqual([0, 0, 0]);

    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toEqual(["tables"]);
    expect(counts()[0]).toBeGreaterThan(0);

    syncBuiltinFeatures(host, features, { "features.tables.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("is on by default", () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
  });
});

describe("tables manifest contract", () => {
  it("id equals the folder and the definition", () => {
    expect(manifest.id).toBe("tables");
    expect(tables.id).toBe(manifest.id);
  });

  it("lists exactly the palette commands the code can run, all prefixed", () => {
    const ids = manifest.contributes.commands.map((c) => c.id);
    expect([...ids].sort()).toEqual([...TABLE_PALETTE_COMMAND_IDS].sort());
    for (const id of ids) expect(id.startsWith("tables.")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has its kill switch in the shared settings schema, as the Rust contract test expects", () => {
    expect(schema.settings.find((e) => e.key === "features.tables.enabled")).toEqual({
      key: "features.tables.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: manifest.enabledByDefault,
      scope: "global",
    });
  });
});

// ---- import graph: the startup bundle must not reach the table code ----

const SRC = resolve(import.meta.dirname, "../../../src");

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? resolve(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

/** Files reachable from `entry` through static imports only (`import(...)` is not followed). */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /^\s*(?:import|export)\s[^"'()]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm,
    )) {
      const target = resolveImport(file, m[1] ?? m[2]);
      if (target) stack.push(target);
    }
  }
  return seen;
}

describe("core has no static table import", () => {
  for (const entry of [
    "components/editor-area/editor-extensions.ts",
    "components/editor-area/editor-body-menu.ts",
    "components/command-palette/commands.ts",
  ]) {
    it(`${entry} reaches no table module`, () => {
      const reached = [...staticGraph(resolve(SRC, entry))];
      expect(
        reached.filter((f) => /features\/tables|table-(editing|decorations|commands)/.test(f)),
      ).toEqual([]);
    });
  }

  it("the feature's index reaches no heavy table module statically", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))].map((f) =>
      f.replace(/.*\/features\/tables\//, ""),
    );
    expect(reached.filter((f) => f.startsWith("web/")).sort()).toEqual([
      "web/active.ts",
      "web/index.ts",
    ]);
  });
});
