// The TypeScript half of the manifest contract (SPECs/builtin-plugins-spec.md section 11): for
// every built-in feature, and for the test-only sidebar fixture, the ids `feature.json` lists for
// a contribution point are exactly the ids its `defineFeature` call registers there. The Rust
// contract test checks the prefix and uniqueness of the same lists.
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { BUILTIN_FEATURES } from "../src/lib/features/builtin";
import type { FeatureDefinition, FeatureManifest } from "../src/lib/features/types";
import {
  fixtureSidebarFeature,
  manifest as fixtureManifest,
} from "./fixtures/features/fixture-sidebar";

type Ids = Record<string, string[]>;

/** Point name (as in `feature.json`) to the ids the definition registers there. */
function definedIds(def: FeatureDefinition): Ids {
  const c = def.contributes ?? {};
  const ids = (xs?: readonly { id: string }[]) => (xs ?? []).map((x) => x.id).sort();
  return {
    docks: ids(c.docks),
    sidebarPanels: ids(c.sidebarPanels),
    sidebarActions: ids(c.sidebarActions),
    statusItems: ids(c.statusItems),
    overlays: ids(c.overlays),
    fileTreeDecorations: ids(c.fileTreeDecorations),
    ...Object.fromEntries(Object.entries(c.menus ?? {}).map(([s, m]) => [`menus.${s}`, ids(m)])),
  };
}

function declaredIds(manifest: FeatureManifest): Ids {
  const c = manifest.contributes ?? {};
  const list = (xs?: string[]) => [...(xs ?? [])].sort();
  return {
    docks: list(c.docks),
    sidebarPanels: list(c.sidebarPanels),
    sidebarActions: list(c.sidebarActions),
    statusItems: list(c.statusItems),
    overlays: list(c.overlays),
    fileTreeDecorations: list(c.fileTreeDecorations),
    ...Object.fromEntries(Object.entries(c.menus ?? {}).map(([s, m]) => [`menus.${s}`, list(m)])),
  };
}

const nonEmpty = (ids: Ids) => Object.fromEntries(Object.entries(ids).filter(([, v]) => v.length));

describe("feature.json lists the ids the feature registers", () => {
  const cases = [
    ...BUILTIN_FEATURES.map((f) => [f.manifest.id, f.manifest, f.definition] as const),
    [fixtureManifest.id, fixtureManifest as FeatureManifest, fixtureSidebarFeature()] as const,
  ];

  it.each(cases)("%s", (_id, manifest, definition) => {
    expect(nonEmpty(declaredIds(manifest))).toEqual(nonEmpty(definedIds(definition)));
  });

  it("covers the shipped features and the fixture", () => {
    expect(cases.map((c) => c[0])).toEqual(
      expect.arrayContaining(["agent", "tables", "fixture-sidebar"]),
    );
  });

  it("the fixture declares every new point", () => {
    expect(Object.keys(nonEmpty(declaredIds(fixtureManifest as FeatureManifest))).sort()).toEqual([
      "menus.sidebar-bulk",
      "menus.sidebar-file",
      "menus.sidebar-folder",
      "sidebarActions",
      "sidebarPanels",
      "statusItems",
    ]);
  });
});
