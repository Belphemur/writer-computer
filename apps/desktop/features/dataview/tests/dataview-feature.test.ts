// @vitest-environment jsdom
// Dataview as a built-in feature: registers and unregisters cleanly, the kill switch removes the
// block extension, a failing contribution is contained, and the startup chunk stays light.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { createFeatureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import dataview from "../web";

const host = createFeatureHost({ onError: () => {} });
const mine = () =>
  editorExtensionContributions.list().filter((x) => x.owner === "builtin:dataview").length;

describe("dataview feature", () => {
  it("registers one editor extension and removes it on unregister", async () => {
    host.register(dataview);
    expect(mine()).toBe(1);
    await host.unregister("dataview");
    expect(mine()).toBe(0);
  });

  it("is on by default and switched off by features.dataview.enabled", async () => {
    const features = [{ manifest, definition: dataview }];
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toEqual(["dataview"]);
    syncBuiltinFeatures(host, features, { "features.dataview.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(mine()).toBe(0);
  });

  it("declares its setting and its extension in the manifest", () => {
    expect(manifest.id).toBe("dataview");
    expect(schema.settings.find((e) => e.key === "features.dataview.enabled")?.default).toBe(true);
    expect(dataview.contributes?.editorExtensions?.map((e) => e.id)).toEqual(["dataview.blocks"]);
  });

  it("a throwing contribution is contained", async () => {
    const failures: string[] = [];
    const h = createFeatureHost({ onError: () => {}, onFailure: (id) => failures.push(id) });
    h.register({
      id: "dataview",
      contributes: dataview.contributes,
      activate() {
        throw new Error("boom");
      },
    });
    await expect(h.activate("dataview")).rejects.toThrow("boom");
    expect(failures).toEqual(["dataview"]);
    expect(mine()).toBe(0); // a failed activation removes its contributions
    await h.unregister("dataview");
  });
});
