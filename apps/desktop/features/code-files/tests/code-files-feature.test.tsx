// The Code files feature as a built-in feature: registers and unregisters cleanly, the kill switch
// removes everything (code files open as text, a restored code tab shows the off page, the rules
// service is gone so nothing counts as code, nothing is routed to the code kind), the manifest
// matches the code and the settings fragment, and neither core nor the startup chunk reaches the
// editor or the language data. Rust twin: `code_files_tests::feature_off`.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));

import { staticGraph } from "@tests/helpers/import-graph";
import { createFeatureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { getService, serviceContributions } from "@/lib/features/services";
import { slotContributions } from "@/lib/features/slots";
import { isFeatureActive } from "@/lib/features/active";
import { CODE_FILES_RULES, isCodePath, type CodeFilesRules } from "@/lib/code-files";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { locationForPath, opensAsDocument } from "@/components/editor-area/page-kinds";
import { pageKindView } from "@/components/editor-area/page-kinds/views";
import { FileIcon } from "@/components/sidebar/file-tree-icons";
import { noteLabel } from "@/lib/note-title";
import { useSettingsStore } from "@/stores/settings-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import fragment from "../settings.schema.json";
import codeFiles from "../web";
import { codeFilesRules } from "../web/rules";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = createFeatureHost({ onError: () => {} });
const features = [{ manifest, definition: codeFiles }];
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:code-files").length;
const counts = () => [mine(slotContributions.list()), mine(serviceContributions.list())];

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("registration", () => {
  it("registers every contribution and removes exactly them on unregister", async () => {
    host.register(codeFiles);
    expect(counts()).toEqual([1, 1]);
    await host.unregister("code-files");
    expect(counts()).toEqual([0, 0]);
  });

  it("is on by default and switched off by features.code-files.enabled", async () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toEqual(["code-files"]);
    syncBuiltinFeatures(host, features, { "features.code-files.enabled": false });
    await vi.waitFor(() => expect(host.list()).toEqual([]));
    expect(counts()).toEqual([0, 0]);
    expect(getService(CODE_FILES_RULES)).toBeUndefined();
  });

  it("a throwing activation is contained and removes the contributions", async () => {
    const failures: string[] = [];
    const h = createFeatureHost({ onError: () => {}, onFailure: (id) => failures.push(id) });
    h.register({
      id: "code-files",
      contributes: { services: [{ id: CODE_FILES_RULES, service: codeFilesRules }] },
      activate() {
        throw new Error("boom");
      },
    });
    await expect(h.activate("code-files")).rejects.toThrow("boom");
    expect(failures).toEqual(["code-files"]);
    expect(getService(CODE_FILES_RULES)).toBeUndefined();
    await h.unregister("code-files");
  });
});

describe("the code-files.rules service", () => {
  it("is what core asks: on, a code path counts; the secret and notes rules hold", () => {
    host.register(codeFiles);
    const service = getService<CodeFilesRules>(CODE_FILES_RULES)!;
    expect(service).toBe(codeFilesRules);
    expect(service.isCodeName("run.py")).toBe(true);
    expect(isCodePath("/v/Dockerfile")).toBe(true);
    expect(isCodePath("/v/.env")).toBe(false);
    expect(isCodePath("/v/a.md")).toBe(false);
  });

  it("reads the extension list from the settings and falls back to the default for a non-list", () => {
    host.register(codeFiles);
    useSettingsStore.setState({ settings: { "code-files.extensions": ["zzz"] } });
    expect(isCodePath("/v/a.zzz")).toBe(true);
    expect(isCodePath("/v/a.py")).toBe(false);
    useSettingsStore.setState({ settings: { "code-files.extensions": "nope" } });
    expect(isCodePath("/v/a.py")).toBe(true);
  });
});

describe("switched off", () => {
  it("nothing counts as code without the service, and a code file opens as text", () => {
    // unregistered: the feature was never added (off, safe mode, a third failure)
    expect(isCodePath("/v/a.py")).toBe(false);
    expect(noteLabel("/v/a.py").text).toBe("a"); // a note-like label: the extension is dropped
    useSettingsStore.setState({ settings: { "features.code-files.enabled": false } });
    expect(isFeatureActive("code-files")).toBe(false);
    expect(locationForPath("/v/a.py")).toEqual({ kind: "file", path: "/v/a.py" });
    expect(opensAsDocument("/v/a.py")).toBe(true);
    expect(locationForPath("/v/a.md")).toEqual({ kind: "file", path: "/v/a.md" });
  });

  it("on again, a code file routes to the code kind", () => {
    host.register(codeFiles);
    expect(isFeatureActive("code-files")).toBe(true);
    expect(locationForPath("/v/a.py")).toEqual({ kind: "code", path: "/v/a.py" });
  });

  it("the tree shows the generic glyph, not a code one, for a code name while off", () => {
    const off = renderToStaticMarkup(createElement(FileIcon, { name: "run.py" }));
    host.register(codeFiles);
    const on = renderToStaticMarkup(createElement(FileIcon, { name: "run.py" }));
    expect(on).not.toBe(off);
  });

  it("is also off for the session after repeated failures or in safe mode", () => {
    useFeatureHealth.setState({ sessionOff: { "code-files": true } });
    expect(isFeatureActive("code-files")).toBe(false);
    useFeatureHealth.setState({ sessionOff: {}, safeMode: true });
    expect(isFeatureActive("code-files")).toBe(false);
  });

  it("an open code tab shows the off page with Turn on and Open as text, and the editor slot when on", async () => {
    const location = { kind: "code" as const, path: "/v/a.py" };
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    useSettingsStore.setState({
      settings: { "features.code-files.enabled": false },
      setSetting: vi.fn(async () => {}),
    } as never);
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    expect(el.querySelector("[data-feature-off=code-files]")?.textContent).toContain(
      "Code files is turned off",
    );
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Turn on",
      "Open as text",
    ]);
    host.register(codeFiles);
    useSettingsStore.setState({ settings: {} });
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    expect(el.querySelector("[data-feature-off]")).toBeNull();
    await act(async () => root.unmount());
    el.remove();
  });

  it("Turn on writes the setting", async () => {
    const setSetting = vi.fn(async () => {});
    useSettingsStore.setState({
      settings: { "features.code-files.enabled": false },
      setSetting,
    } as never);
    const location = { kind: "code" as const, path: "/v/a.py" };
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<Component location={location} isActive tabId="t" />));
    await act(async () => el.querySelector("button")!.click());
    expect(setSetting).toHaveBeenCalledWith("features.code-files.enabled", true);
    await act(async () => root.unmount());
    el.remove();
  });
});

describe("manifest and settings contract", () => {
  it("id equals the folder and the definition; every contributed id is prefixed", () => {
    expect(manifest.id).toBe("code-files");
    expect(codeFiles.id).toBe(manifest.id);
    const c = codeFiles.contributes!;
    const ids = [...c.slots!, ...c.services!].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("code-files."))).toBe(true);
    expect(manifest.contributes.slots).toEqual(c.slots!.map((s) => s.id));
    expect(manifest.provides).toEqual(c.services!.map((s) => s.id));
    expect(c.slots![0]!.slot).toBe("page-view:code");
    expect(c.services![0]!.id).toBe(CODE_FILES_RULES);
  });

  it("has its kill switch in the shared settings schema, as the Rust contract test expects", () => {
    expect(schema.settings.find((e) => e.key === "features.code-files.enabled")).toEqual({
      key: "features.code-files.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });

  it("owns the four code settings in its fragment, none left in the shared file", () => {
    const keys = fragment.settings.map((s) => s.key);
    expect(keys).toEqual([
      "code-files.extensions",
      "code-files.ignored-folders",
      "code-files.show-agent-folders",
      "code-files.word-wrap",
    ]);
    const shared = new Set(schema.settings.map((s) => s.key));
    expect(keys.filter((k) => shared.has(k))).toEqual([]);
    for (const old of [
      "files.code-extensions",
      "files.ignored-folders",
      "files.show-agent-folders",
      "editor.code-word-wrap",
    ]) {
      expect(shared.has(old), old).toBe(false);
    }
    // Images are core: their setting stays in the shared file.
    expect(shared.has("files.show-images")).toBe(true);
    // The merged schema (what Settings and `useSetting` read) has every key once.
    const merged = SETTINGS_SCHEMA.map((s) => s.key);
    for (const k of keys) expect(merged.filter((m) => m === k)).toHaveLength(1);
  });
});

describe("startup chunk", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("the feature's index reaches no editor, language data or CodeMirror", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))].map(rel);
    expect(reached.filter((f) => /components\/code-editor|lib\/code-language/.test(f))).toEqual([]);
    expect(reached.filter((f) => /@codemirror|language-data/.test(f))).toEqual([]);
  });

  for (const entry of [
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
    "src/lib/code-files.ts",
  ]) {
    it(`${entry} reaches no Code files module statically`, () => {
      const reached = [...staticGraph(resolve(import.meta.dirname, "../../..", entry))].map(rel);
      expect(reached.filter((f) => f.startsWith("features/code-files/"))).toEqual([]);
    });
  }
});
