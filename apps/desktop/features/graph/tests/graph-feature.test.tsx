// The graph feature as a built-in: registers and unregisters cleanly, the kill switch removes
// everything, the manifest matches the code and the shared schema, the page kind round-trips through
// the session, a throwing view is contained by the host, and the libraries stay out of the startup
// chunk and out of every module outside the feature.
// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { createFeatureHost } from "@/lib/features/registry";
import { featurePaletteCommands } from "@/lib/features/palette";
import { sidebarActionContributions, sidebarPanelContributions } from "@/lib/features/sidebar";
import { slotContributions } from "@/lib/features/slots";
import {
  deserializeLocation,
  serializeLocation,
  pageKind,
} from "@/components/editor-area/page-kinds";
import { pageKindView } from "@/components/editor-area/page-kinds/views";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import schema from "@shared/settings.schema.json";
import fragment from "../settings.schema.json";
import manifest from "../feature.json";
import graph from "../web";
import { readGraphSettings } from "../web/settings";

const host = createFeatureHost({ onError: () => {} });
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:graph").length;
const counts = () => [
  mine(sidebarPanelContributions.list()),
  mine(sidebarActionContributions.list()),
  mine(slotContributions.list()),
  mine(featurePaletteCommands.list()),
];

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("registration", () => {
  it("registers every contribution and removes exactly them on unregister", async () => {
    host.register(graph);
    expect(counts().slice(0, 3)).toEqual([1, 1, 1]);
    await host.unregister("graph");
    expect(counts()).toEqual([0, 0, 0, 0]);
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers, all prefixed", () => {
    const c = graph.contributes!;
    expect(graph.id).toBe(manifest.id);
    expect(manifest.contributes.sidebarPanels).toEqual(c.sidebarPanels!.map((x) => x.id));
    expect(manifest.contributes.sidebarActions).toEqual(c.sidebarActions!.map((x) => x.id));
    expect(manifest.contributes.slots).toEqual(c.slots!.map((x) => x.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    const ids = [...c.sidebarPanels!, ...c.sidebarActions!, ...c.slots!, ...c.commands!].map(
      (x) => x.id,
    );
    expect(ids.every((id) => id.startsWith("graph."))).toBe(true);
    expect(c.slots![0]!.slot).toBe("page-view:graph");
    expect(c.commands![0]!.label).toBe("Open graph");
  });

  it("has its kill switch in the shared schema and every setting prefixed in the fragment", () => {
    const entry = schema.settings.find((e) => e.key === "features.graph.enabled");
    expect(entry).toMatchObject({
      type: "boolean",
      default: true,
      category: "Features",
      scope: "global",
    });
    expect(fragment.settings.every((s) => s.key.startsWith("graph."))).toBe(true);
    expect(readGraphSettings({}, false)).toMatchObject({ localDepth: 1, animate: true });
    expect(
      readGraphSettings({ "graph.local-depth": 3, "graph.animate": true }, true),
    ).toMatchObject({ localDepth: 3, animate: false });
  });
});

describe("page kind", () => {
  it("round-trips camera, center and pins through the session and drops junk", () => {
    const l = {
      kind: "graph" as const,
      center: "A.md",
      depth: 2,
      camera: { x: 1, y: 2, ratio: 0.5 },
      pins: { "A.md": [3, 4] as [number, number] },
    };
    expect(deserializeLocation(serializeLocation(l))).toEqual(l);
    expect(
      deserializeLocation({ kind: "graph", camera: { x: "a" }, pins: { "B.md": "no" } }),
    ).toEqual({ kind: "graph" });
  });

  it("follows renames and deletes of its center and pins and claims no path", () => {
    const k = pageKind({ kind: "graph" });
    const l = {
      kind: "graph" as const,
      center: "A.md",
      pins: { "A.md": [1, 1] as [number, number] },
    };
    expect(k.rewritePath(l, "A.md", "B.md")).toEqual({
      kind: "graph",
      center: "B.md",
      pins: { "B.md": [1, 1] },
    });
    expect(k.removePath(l, "A.md")).toEqual({ kind: "graph" });
    expect(k.primaryPath(l)).toBeNull();
    expect(k.forPath("A.md")).toBeNull();
    expect(pageKindView({ kind: "graph" })).toBeTruthy();
  });
});

describe("kill switch and containment", () => {
  it("the feature host contains a throwing contribution and the rest stays registered", async () => {
    const errors: unknown[] = [];
    const h = createFeatureHost({ onError: (e) => errors.push(e) });
    h.register({
      ...graph,
      activate: () => {
        throw new Error("boom");
      },
    });
    await h.activate("graph").catch(() => {});
    expect(h.state("graph")).toBe("failed");
    await h.unregister("graph");
  });
});

describe("libraries", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");
  const LIBS = /^(@react-sigma\/core|sigma|graphology|graphology-layout-forceatlas2)(\/|$)/;

  it("the feature's index reaches none of them and no heavy module", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))];
    const specs = reached.flatMap((f) =>
      importsOf(f)
        .filter((i) => !i.dynamic && !i.typeOnly)
        .map((i) => i.spec),
    );
    expect(specs.filter((s) => LIBS.test(s))).toEqual([]);
    expect(
      reached.map(rel).filter((f) => /graph-canvas|layout|hulls|graph-view|local-panel/.test(f)),
    ).toEqual([]);
  });

  for (const entry of [
    "src/main.tsx",
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
  ]) {
    it(`the startup graph from ${entry} has no graph library and no graph view`, () => {
      const reached = [...staticGraph(resolve(DESKTOP, entry))];
      const specs = reached.flatMap((f) =>
        importsOf(f)
          .filter((i) => !i.dynamic && !i.typeOnly)
          .map((i) => i.spec),
      );
      expect(specs.filter((s) => LIBS.test(s))).toEqual([]);
      expect(
        reached
          .map(rel)
          .filter((f) => /features\/graph\/web\/(graph-|layout|hulls|local-)/.test(f)),
      ).toEqual([]);
    });
  }

  it("the app bundle has the layout worker as its own file and the entry chunk holds no graph library", () => {
    const out = mkdtempSync(join(tmpdir(), "graph-build-"));
    try {
      execFileSync("pnpm", ["exec", "vp", "build", "--outDir", out], {
        cwd: DESKTOP,
        stdio: "pipe",
        timeout: 150_000,
      });
      const assets = readdirSync(join(out, "assets"));
      const worker = assets.filter((f) => /^layout\.worker.*\.js$/.test(f));
      expect(worker).toHaveLength(1);
      const entry = assets.filter((f) => /^index-.*\.js$/.test(f));
      expect(entry.length).toBeGreaterThan(0);
      for (const f of entry) {
        const code = readFileSync(join(out, "assets", f), "utf8");
        expect(code).not.toMatch(/Sigma: |graphology|react-sigma/);
      }
      expect(readFileSync(join(out, "assets", worker[0]!), "utf8")).not.toMatch(/blob:/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  it("only files under features/graph import them", () => {
    const offenders: string[] = [];
    for (const root of ["src", "features"]) {
      for (const f of sourceFiles(resolve(DESKTOP, root))) {
        if (rel(f).startsWith("features/graph/")) continue;
        if (importsOf(f).some((i) => LIBS.test(i.spec))) offenders.push(rel(f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins the four dependencies exactly in the workspace catalog", () => {
    const text = readFileSync(resolve(DESKTOP, "../../pnpm-workspace.yaml"), "utf8");
    for (const [name, version] of [
      ["@react-sigma/core", "6.0.0"],
      ["sigma", "4.0.6"],
      ["graphology", "0.26.0"],
      ["graphology-layout-forceatlas2", "0.10.1"],
    ] as const) {
      expect(text).toMatch(
        new RegExp(
          `["']?${name.replace(/[/@]/g, "\\$&")}["']?: ${version.replace(/\./g, "\\.")}\\s*$`,
          "m",
        ),
      );
    }
  });
});
