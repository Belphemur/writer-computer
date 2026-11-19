// The spellcheck feature as a built-in: registers and unregisters cleanly, the manifest matches the
// code and the schemas, the startup graph stays light, and only the IPC module imports the bindings.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { createFeatureHost } from "@/lib/features/registry";
import { featurePaletteCommands } from "@/lib/features/palette";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import schema from "@shared/settings.schema.json";
import fragment from "../settings.schema.json";
import manifest from "../feature.json";
import spellcheck from "../web";

const host = createFeatureHost({ onError: () => {} });

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("registration", () => {
  it("registers its command and removes exactly it on unregister", async () => {
    const mine = () =>
      featurePaletteCommands.list().filter((x) => x.owner === "builtin:spellcheck").length;
    host.register(spellcheck);
    expect(mine()).toBe(1);
    await host.unregister("spellcheck");
    expect(mine()).toBe(0);
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers, all prefixed", () => {
    const c = spellcheck.contributes!;
    expect(spellcheck.id).toBe(manifest.id);
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((x) => x.id));
    expect(manifest.contributes.statusItems).toEqual(c.statusItems!.map((x) => x.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    const ids = [...c.editorExtensions!, ...c.statusItems!, ...c.commands!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("spellcheck."))).toBe(true);
  });

  it("has its kill switch in the shared schema and every setting prefixed in the fragment", () => {
    expect(schema.settings.find((e) => e.key === "features.spellcheck.enabled")).toMatchObject({
      type: "boolean",
      default: true,
      scope: "global",
    });
    expect(fragment.settings.length).toBeGreaterThan(0);
    expect(fragment.settings.every((s) => s.key.startsWith("spellcheck."))).toBe(true);
  });
});

describe("imports", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("the entry reaches neither the linter library nor a heavy module", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))];
    const specs = reached.flatMap((f) =>
      importsOf(f)
        .filter((i) => !i.dynamic && !i.typeOnly)
        .map((i) => i.spec),
    );
    expect(specs.filter((s) => s.startsWith("@codemirror/lint"))).toEqual([]);
    expect(
      reached.map(rel).filter((f) => /spellcheck\/web\/(editor|components|ipc|bindings)/.test(f)),
    ).toEqual([]);
  });

  it("only ipc.ts imports the generated bindings, and core never imports the feature", () => {
    const bindings: string[] = [];
    const core: string[] = [];
    for (const f of sourceFiles(resolve(DESKTOP, "src"))) {
      if (importsOf(f).some((i) => i.spec.includes("features/spellcheck"))) core.push(rel(f));
    }
    for (const f of sourceFiles(resolve(DESKTOP, "features/spellcheck/web"))) {
      if (importsOf(f).some((i) => i.spec.endsWith("/bindings"))) bindings.push(rel(f));
    }
    expect(core).toEqual([]);
    expect(bindings).toEqual(["features/spellcheck/web/ipc.ts"]);
  });
});
