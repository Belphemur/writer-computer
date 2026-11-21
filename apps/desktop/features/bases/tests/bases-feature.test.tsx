// The Bases feature as a built-in feature: registers and unregisters cleanly, the kill switch
// removes everything (base files open as text, the tab shows the off page, embeds are plain, the
// service is gone), the manifest matches the code, and neither core nor the startup chunk reaches
// the Bases UI.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));

import { staticGraph } from "@tests/helpers/import-graph";
import { createFeatureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { getService, serviceContributions } from "@/lib/features/services";
import { slotContributions } from "@/lib/features/slots";
import { isFeatureActive } from "@/lib/features/active";
import { locationForPath, opensAsDocument } from "@/components/editor-area/page-kinds";
import { pageKindView } from "@/components/editor-area/page-kinds/views";
import { useSettingsStore } from "@/stores/settings-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import bases from "../web";
import { BASES_VIEWS, type BasesViewsService } from "../web/api";
import { basesViewsService } from "../web/service";
import { getBaseView, registerBaseView } from "../web/lib/view-registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {} });
const features = [{ manifest, definition: bases }];
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:bases").length;
const counts = () => [
  mine(editorExtensionContributions.list()),
  mine(slotContributions.list()),
  mine(serviceContributions.list()),
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
    host.register(bases);
    expect(counts()).toEqual([1, 1, 1]);
    await host.unregister("bases");
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("is on by default and switched off by features.bases.enabled", async () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toEqual(["bases"]);
    syncBuiltinFeatures(host, features, { "features.bases.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(counts()).toEqual([0, 0, 0]);
    expect(getService(BASES_VIEWS)).toBeUndefined();
  });

  it("a throwing contribution is contained: the failure is counted, the others stay", async () => {
    const failures: string[] = [];
    const h = createFeatureHost({ onError: () => {}, onFailure: (id) => failures.push(id) });
    h.register({
      id: "bases",
      contributes: { services: [{ id: BASES_VIEWS, service: basesViewsService }] },
      activate() {
        throw new Error("boom");
      },
    });
    await expect(h.activate("bases")).rejects.toThrow("boom");
    expect(failures).toEqual(["bases"]);
    expect(getService(BASES_VIEWS)).toBeUndefined(); // a failed activation removes its contributions
    expect(h.list()).toEqual(["bases"]);
    await h.unregister("bases");
  });
});

describe("the bases.views service", () => {
  it("is found while the feature is on, with the view registry and the formula call", () => {
    host.register(bases);
    const service = getService<BasesViewsService>(BASES_VIEWS)!;
    expect(service).toBe(basesViewsService);
    const unregister = service.registerView({
      type: "probe",
      name: "Probe",
      icon: "star",
      owner: "plugin-x",
      mount: () => ({ update() {}, destroy() {} }),
    });
    expect(unregister).toBeTypeOf("function");
    expect(service.registerView({ ...getBaseView("probe")! })).toBeNull(); // taken
    expect(service.unregisterOwned("plugin-x")).toBe(1);
    expect(service.canonicalPropertyKey("note.status")).toBe("status");
  });

  it("switching the feature off sweeps what plugins registered and keeps the built-ins", async () => {
    host.register(bases);
    registerBaseView({
      type: "probe2",
      name: "P",
      icon: "x",
      owner: "plugin-y",
      mount: () => ({ update() {}, destroy() {} }),
    });
    await host.unregister("bases");
    expect(getBaseView("probe2")).toBeUndefined();
  });
});

describe("switched off", () => {
  it("a .base opens as text instead of as a base tab; on again, as a table", () => {
    expect(isFeatureActive("bases")).toBe(true);
    expect(locationForPath("/v/a.base")).toEqual({ kind: "base", path: "/v/a.base" });
    expect(opensAsDocument("/v/a.base")).toBe(false);

    useSettingsStore.setState({ settings: { "features.bases.enabled": false } });
    expect(isFeatureActive("bases")).toBe(false);
    expect(locationForPath("/v/a.base")).toEqual({ kind: "file", path: "/v/a.base" });
    expect(opensAsDocument("/v/a.base")).toBe(true);
    expect(locationForPath("/v/a.md")).toEqual({ kind: "file", path: "/v/a.md" });

    useSettingsStore.setState({ settings: {} });
    expect(locationForPath("/v/a.base")).toEqual({ kind: "base", path: "/v/a.base" });
  });

  it("is also off for the session after repeated failures or in safe mode", () => {
    useFeatureHealth.setState({ sessionOff: { bases: true } });
    expect(isFeatureActive("bases")).toBe(false);
    useFeatureHealth.setState({ sessionOff: {}, safeMode: true });
    expect(isFeatureActive("bases")).toBe(false);
  });

  it("an open base tab shows the off page with Turn on and Open as text, and the view when on", async () => {
    const location = { kind: "base" as const, path: "/v/a.base" };
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    useSettingsStore.setState({
      settings: { "features.bases.enabled": false },
      setSetting: vi.fn(async () => {}),
    } as never);
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    expect(el.querySelector("[data-feature-off=bases]")?.textContent).toContain(
      "Bases is turned off",
    );
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Turn on", "Open as text"]);

    // on, with the feature registered: the slot renders instead of the off page
    host.register(bases);
    useSettingsStore.setState({ settings: {} });
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    expect(el.querySelector("[data-feature-off]")).toBeNull();
    await act(async () => root.unmount());
    el.remove();
  });

  it("Turn on writes the setting", async () => {
    const setSetting = vi.fn(async () => {});
    useSettingsStore.setState({
      settings: { "features.bases.enabled": false },
      setSetting,
    } as never);
    const location = { kind: "base" as const, path: "/v/a.base" };
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    await act(async () => el.querySelector("button")!.click());
    expect(setSetting).toHaveBeenCalledWith("features.bases.enabled", true);
    await act(async () => root.unmount());
    el.remove();
  });

  it("embeds are plain: the embed extension is registered only while the feature is on", async () => {
    host.register(bases);
    expect(editorExtensionContributions.list().map((c) => c.id)).toContain("bases.embeds");
    await host.unregister("bases");
    expect(editorExtensionContributions.list().map((c) => c.id)).not.toContain("bases.embeds");
  });
});

describe("manifest contract", () => {
  it("id equals the folder and the definition; every contributed id is prefixed", () => {
    expect(manifest.id).toBe("bases");
    expect(bases.id).toBe(manifest.id);
    const c = bases.contributes!;
    const ids = [...c.editorExtensions!, ...c.slots!, ...c.services!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("bases."))).toBe(true);
    expect(manifest.contributes.editorExtensions).toEqual(["bases.embeds"]);
    expect(manifest.contributes.slots).toEqual(["bases.base-tab"]);
    expect(manifest.provides).toEqual(c.services!.map((s) => s.id));
    expect(c.slots![0]!.slot).toBe("page-view:base");
  });

  it("has its kill switch in the shared settings schema, as the Rust contract test expects", () => {
    expect(schema.settings.find((e) => e.key === "features.bases.enabled")).toEqual({
      key: "features.bases.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });
});

describe("startup chunk", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("the feature's index reaches no view component, editor widget or heavy library", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))].map(rel);
    expect(reached.filter((f) => /features\/bases\/web\/view\//.test(f))).toEqual([]);
    expect(reached.filter((f) => /embed-decorations/.test(f))).toEqual([]);
    expect(reached.filter((f) => /react-virtual|@tanstack|yaml/.test(f))).toEqual([]);
    expect(reached.filter((f) => f.includes("lib/base-yaml"))).toEqual([]);
  });

  for (const entry of [
    "src/components/editor-area/editor-extensions.ts",
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
  ]) {
    it(`${entry} reaches no Bases module statically`, () => {
      const reached = [...staticGraph(resolve(import.meta.dirname, "../../..", entry))].map(rel);
      expect(reached.filter((f) => f.startsWith("features/bases/web/"))).toEqual([]);
    });
  }
});
