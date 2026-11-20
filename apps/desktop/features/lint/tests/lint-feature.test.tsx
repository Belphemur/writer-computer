// The lint feature as a built-in: registers and unregisters cleanly, the manifest matches the code
// and the schemas, the startup graph stays light, and only the IPC module imports the bindings.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { featurePaletteCommands } from "@/lib/features/palette";
import { createFeatureHost } from "@/lib/features/registry";
import { settingsSectionContributions } from "@/lib/features/settings-sections";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import schema from "@shared/settings.schema.json";
import fragment from "../settings.schema.json";
import manifest from "../feature.json";
import lint from "../web";

const host = createFeatureHost({ onError: () => {} });
const OWNER = "builtin:lint";

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

const mine = () => ({
  commands: featurePaletteCommands.list().filter((x) => x.owner === OWNER).length,
  extensions: editorExtensionContributions.list().filter((x) => x.owner === OWNER).length,
  sections: settingsSectionContributions.list().filter((x) => x.owner === OWNER).length,
});

describe("registration", () => {
  it("registers its contributions and removes exactly them on unregister", async () => {
    host.register(lint);
    expect(mine()).toEqual({ commands: 2, extensions: 1, sections: 1 });
    await host.unregister("lint");
    expect(mine()).toEqual({ commands: 0, extensions: 0, sections: 0 });
  });

  it("the fix command is for a Markdown note in a vault window only", () => {
    const fixAll = lint.contributes!.commands!.find((c) => c.id === "lint.fix-all")!;
    const base = { hasWorkspace: true, isCompactFileMode: false, activeFilePath: "/v/a.md" };
    const when = (patch: object) => fixAll.when({ ...base, ...patch } as never);
    expect(when({})).toBe(true);
    expect(when({ activeFilePath: "/v/a.MARKDOWN" })).toBe(true);
    expect(when({ activeFilePath: "/v/a.ts" })).toBe(false);
    expect(when({ activeFilePath: null })).toBe(false);
    expect(when({ hasWorkspace: false })).toBe(false);
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers, all prefixed", () => {
    const c = lint.contributes!;
    expect(lint.id).toBe(manifest.id);
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((x) => x.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    const ids = [...c.editorExtensions!, ...c.commands!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("lint."))).toBe(true);
  });

  it("has its kill switch in the shared schema and every setting prefixed in the fragment", () => {
    expect(schema.settings.find((e) => e.key === "features.lint.enabled")).toMatchObject({
      type: "boolean",
      default: true,
      scope: "global",
    });
    expect(fragment.settings.map((s) => s.key).sort()).toEqual([
      "lint.fix-on-save",
      "lint.rules-off",
      "lint.rules-on",
    ]);
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
      reached.map(rel).filter((f) => /lint\/web\/(editor|components|lib|ipc|bindings)/.test(f)),
    ).toEqual([]);
  });

  it("only ipc.ts imports the generated bindings, and core never imports the feature", () => {
    const bindings: string[] = [];
    const core: string[] = [];
    for (const f of sourceFiles(resolve(DESKTOP, "src"))) {
      if (importsOf(f).some((i) => i.spec.includes("features/lint"))) core.push(rel(f));
    }
    for (const f of sourceFiles(resolve(DESKTOP, "features/lint/web"))) {
      if (importsOf(f).some((i) => i.spec.endsWith("/bindings"))) bindings.push(rel(f));
    }
    expect(core).toEqual([]);
    expect(bindings).toEqual(["features/lint/web/ipc.ts"]);
  });
});
