// The Excalidraw feature as a built-in: registers and unregisters cleanly, the manifest matches the
// code and the shared schema, the drawing page kind routes by path and by the "who opens drawings"
// setting, and Excalidraw stays out of the startup chunk and out of every module outside the
// feature.
// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { createFeatureHost } from "@/lib/features/registry";
import { slotContributions } from "@/lib/features/slots";
import { serviceContributions } from "@/lib/features/services";
import { ipcRequestHandlers } from "@/lib/features/ipc-requests";
import { featurePaletteCommands } from "@/lib/features/palette";
import {
  deserializeLocation,
  serializeLocation,
  pageKind,
  locationForPath,
} from "@/components/editor-area/page-kinds";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { drawingsHandledNatively } from "@/lib/drawing-files";
import schema from "@shared/settings.schema.json";
import fragment from "../settings.schema.json";
import manifest from "../feature.json";
import excalidraw from "../web";

const host = createFeatureHost({ onError: () => {} });
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:excalidraw").length;
const counts = () => [
  mine(slotContributions.list()),
  mine(serviceContributions.list()),
  mine(ipcRequestHandlers.list()),
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
    host.register(excalidraw);
    expect(counts().slice(0, 3)).toEqual([1, 1, 1]);
    await host.unregister("excalidraw");
    expect(counts()).toEqual([0, 0, 0, 0]);
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers, all prefixed", () => {
    const c = excalidraw.contributes!;
    expect(excalidraw.id).toBe(manifest.id);
    expect(manifest.contributes.slots).toEqual(c.slots!.map((x) => x.id));
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((x) => x.id));
    expect(manifest.contributes.ipcRequests).toEqual(c.ipcRequests!.map((x) => x.id));
    expect(manifest.contributes.workspaceListeners).toEqual(c.workspaceListeners!.map((x) => x.id));
    expect(manifest.contributes.services).toEqual(c.services!.map((x) => x.id));
    expect(manifest.provides).toEqual(c.services!.map((x) => x.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    const ids = [...c.slots!, ...c.commands!, ...c.editorExtensions!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("excalidraw."))).toBe(true);
    expect(c.slots![0]!.slot).toBe("page-view:drawing");
    expect(c.ipcRequests![0]!.topic).toBe("excalidraw:render");
  });

  it("names the Rust commands the CLI exposes", () => {
    expect(manifest.rust.cliCommands).toEqual([
      "excalidraw:create",
      "excalidraw:add",
      "excalidraw:update",
      "excalidraw:read",
      "excalidraw:lint",
      "excalidraw:export",
      "excalidraw:preview",
    ]);
    expect(manifest.rust.skills).toEqual(["writer-excalidraw", "writer-diagram"]);
  });

  it("has its kill switch in the shared schema and every setting prefixed in the fragment", () => {
    expect(schema.settings.find((e) => e.key === "features.excalidraw.enabled")).toMatchObject({
      type: "boolean",
      default: true,
      category: "Features",
      scope: "global",
    });
    expect(fragment.settings.every((s) => s.key.startsWith("excalidraw."))).toBe(true);
    expect(fragment.settings.map((s) => s.key)).toContain("excalidraw.handle-files");
  });
});

describe("page kind", () => {
  it("claims both drawing extensions and nothing else", () => {
    expect(locationForPath("Notes/a.excalidraw.md")).toEqual({
      kind: "drawing",
      path: "Notes/a.excalidraw.md",
    });
    expect(locationForPath("a.excalidraw")).toEqual({ kind: "drawing", path: "a.excalidraw" });
    expect(locationForPath("a.md")?.kind).not.toBe("drawing");
    expect(locationForPath("a.excalidraw.png")?.kind).not.toBe("drawing");
  });

  it("round-trips through the session and follows renames and deletes", () => {
    const l = { kind: "drawing" as const, path: "A.excalidraw.md" };
    expect(deserializeLocation(serializeLocation(l))).toEqual(l);
    expect(deserializeLocation({ kind: "drawing", path: 3 })).toBeNull();
    const k = pageKind(l);
    expect(k.rewritePath(l, "A.excalidraw.md", "B.excalidraw.md")).toEqual({
      kind: "drawing",
      path: "B.excalidraw.md",
    });
    expect(k.removePath(l, "A.excalidraw.md")).toBeNull();
    expect(k.title(l)).toBe("A");
    expect(
      pageKind({ kind: "drawing", path: "x.excalidraw" }).title({
        kind: "drawing",
        path: "x.excalidraw",
      }),
    ).toBe("x");
  });

  it("hands the files to the Obsidian plugin when the setting says so, and claims them with the feature off", () => {
    // feature off: no service, core still claims them (the tab shows the off page)
    expect(drawingsHandledNatively()).toBe(true);
    host.register(excalidraw);
    expect(drawingsHandledNatively()).toBe(true);
    useSettingsStore.setState({ settings: { "excalidraw.handle-files": "plugin" } });
    expect(drawingsHandledNatively()).toBe(false);
    expect(locationForPath("a.excalidraw.md")?.kind).not.toBe("drawing");
  });
});

describe("libraries", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");
  const LIBS = /^(@excalidraw\/excalidraw|lz-string)(\/|$)/;
  const staticSpecs = (entry: string) =>
    [...staticGraph(entry)].flatMap((f) =>
      importsOf(f)
        .filter((i) => !i.dynamic && !i.typeOnly)
        .map((i) => i.spec),
    );

  it("the feature's index reaches neither the package nor a heavy module", () => {
    const entry = resolve(import.meta.dirname, "../web/index.ts");
    expect(staticSpecs(entry).filter((s) => LIBS.test(s))).toEqual([]);
    expect(
      [...staticGraph(entry)]
        .map(rel)
        .filter((f) => /excalidraw\/web\/(lib\/(session|excalidraw-lib)|components\/)/.test(f)),
    ).toEqual([]);
  });

  for (const entry of [
    "src/main.tsx",
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
  ]) {
    it(`the startup graph from ${entry} has no Excalidraw`, () => {
      expect(staticSpecs(resolve(DESKTOP, entry)).filter((s) => LIBS.test(s))).toEqual([]);
    });
  }

  it("only files under features/excalidraw import the package", () => {
    const offenders: string[] = [];
    for (const root of ["src", "features"]) {
      for (const f of sourceFiles(resolve(DESKTOP, root))) {
        if (rel(f).startsWith("features/excalidraw/")) continue;
        if (importsOf(f).some((i) => LIBS.test(i.spec))) offenders.push(rel(f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins the two dependencies exactly in the workspace catalog", () => {
    const text = readFileSync(resolve(DESKTOP, "../../pnpm-workspace.yaml"), "utf8");
    expect(text).toMatch(/["']?@excalidraw\/excalidraw["']?: 0\.18\.1\s*$/m);
    expect(text).toMatch(/["']?lz-string["']?: 1\.5\.0\s*$/m);
  });

  it("the app bundle keeps Excalidraw out of the entry chunk and ships its fonts", () => {
    const out = mkdtempSync(join(tmpdir(), "excalidraw-build-"));
    try {
      execFileSync("pnpm", ["exec", "vp", "build", "--outDir", out], {
        cwd: DESKTOP,
        stdio: "pipe",
        timeout: 150_000,
      });
      const assets = readdirSync(join(out, "assets"));
      const entry = assets.filter((f) => /^index-.*\.js$/.test(f));
      expect(entry.length).toBeGreaterThan(0);
      for (const f of entry) {
        const code = readFileSync(join(out, "assets", f), "utf8");
        expect(code).not.toMatch(/EXCALIDRAW_ASSET_PATH|@excalidraw|excalidraw-app/);
      }
      expect(existsSync(join(out, "excalidraw-assets", "fonts"))).toBe(true);
      const fonts = readdirSync(join(out, "excalidraw-assets", "fonts"));
      expect(fonts).toContain("Excalifont");
      expect(fonts).not.toContain("Xiaolai");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});
