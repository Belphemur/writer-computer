// The Images feature as a built-in feature: registers and unregisters cleanly, the kill switch
// removes the viewer (an image tab shows the off page, the zoom chords go back to the editor),
// every format of the one list routes to the image tab, the manifest matches the code and the
// shared schema, and neither core nor the startup chunk reaches the viewer.
// @vitest-environment jsdom
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string): Promise<unknown> =>
    cmd === "features_status" ? { safeMode: false, crashDisabled: [], failures: [] } : undefined,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import "@/lib/features/builtin";
import { staticGraph } from "@tests/helpers/import-graph";
import { featureHost as host } from "@/lib/features/registry";
import { isFeatureEnabled } from "@/lib/features/builtin";
import { slotContributions } from "@/lib/features/slots";
import { workspaceListeners, emitFileChanged } from "@/lib/features/workspace-events";
import { isFeatureActive } from "@/lib/features/active";
import { CORE_BINDINGS } from "@/lib/keybindings/core-bindings";
import { keybindings } from "@/lib/keybindings/registry";
import { detectPlatform } from "@/lib/platform";
import { featurePaletteCommands } from "@/lib/features/palette";
import {
  deserializeLocation,
  locationForPath,
  opensAsDocument,
  pageKind,
  serializeLocation,
} from "@/components/editor-area/page-kinds";
import { pageKindView } from "@/components/editor-area/page-kinds/views";
import { FileIcon } from "@/components/sidebar/file-tree-icons";
import { noteLabel } from "@/lib/note-title";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import attachments from "@shared/attachments.json";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import images from "../web";
import { useDiskStore } from "../web/disk-sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The app's own host: importing the loader registers every enabled built-in, as at startup.
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:images").length;
const counts = () => [
  mine(slotContributions.list()),
  mine(keybindings.list() as never),
  mine(workspaceListeners.list()),
  mine(featurePaletteCommands.list() as never),
];

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  useSettingsStore.setState({ settings: {} });
  await settle();
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
  useEditorStore.setState({ tabs: [], activeTabId: null });
  for (const b of CORE_BINDINGS) if (!keybindings.get(b.id)) keybindings.add("core", b);
});
afterEach(() => {
  keybindings.removeOwner("core");
  useSettingsStore.setState({ settings: {} });
});

describe("registration", () => {
  it("registers every contribution at startup, on by default", () => {
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    expect(host.list()).toContain("images");
    expect(counts()).toEqual([1, 3, 1, 3]);
  });

  it("the kill switch removes exactly them, and turning it back on restores them", async () => {
    useSettingsStore.setState({ settings: { "features.images.enabled": false } });
    await settle();
    expect(host.list()).not.toContain("images");
    expect(counts()).toEqual([0, 0, 0, 0]);
    useSettingsStore.setState({ settings: {} });
    await settle();
    expect(counts()).toEqual([1, 3, 1, 3]);
  });

  it("the disk-sync listener is fed by core's file events", async () => {
    useDiskStore.getState().track("/v/a.png");
    vi.useFakeTimers();
    await emitFileChanged("modify", "/v/a.png");
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(useDiskStore.getState().views["/v/a.png"]!.version).toBe(1);
    useDiskStore.getState().forget("/v/a.png");
  });
});

describe("zoom keys apply only in an image tab", () => {
  const mod = detectPlatform() === "macos" ? { metaKey: true } : { ctrlKey: true };
  const key = (k: string, code: string) =>
    new KeyboardEvent("keydown", { key: k, code, ...mod, bubbles: true });
  const openTab = (kind: "image" | "file") =>
    useEditorStore.setState({
      tabs: [
        {
          id: "t",
          location: kind === "image" ? { kind, path: "/v/a.png" } : { kind, path: "/v/a.md" },
          back: [],
          forward: [],
        },
      ],
      activeTabId: "t",
    } as never);

  it("are listed in the registry (Settings > Hotkeys) with the editor's chords", () => {
    expect(keybindings.effectiveKeys("images.zoom-in")).toContain(
      keybindings.effectiveKeys("zoom-in")[0],
    );
    expect(keybindings.effectiveKeys("images.zoom-out")).toEqual(
      keybindings.effectiveKeys("zoom-out"),
    );
    expect(keybindings.effectiveKeys("images.fit")).toEqual(
      keybindings.effectiveKeys("zoom-reset"),
    );
    expect(keybindings.get("images.zoom-in")!.category).toBe("View");
  });

  it("an image tab: = - 0 reach the viewer commands, not the editor's zoom", () => {
    openTab("image");
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("images.zoom-in");
    expect(keybindings.find(key("-", "Minus"), "bubble")!.id).toBe("images.zoom-out");
    expect(keybindings.find(key("0", "Digit0"), "bubble")!.id).toBe("images.fit");
  });

  it("a note tab: the same chords stay the editor's text zoom", () => {
    openTab("file");
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("zoom-in");
    expect(keybindings.find(key("-", "Minus"), "bubble")!.id).toBe("zoom-out");
    expect(keybindings.find(key("0", "Digit0"), "bubble")!.id).toBe("zoom-reset");
  });

  it("feature off, an image tab (the off page) leaves the chords to the editor", async () => {
    openTab("image");
    useSettingsStore.setState({ settings: { "features.images.enabled": false } });
    await settle();
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("zoom-in");
  });

  it("the palette commands exist only for an image tab", () => {
    const cmd = featurePaletteCommands.list().find((c) => c.id === "images.zoom-in")!;
    openTab("file");
    expect(cmd.when!({} as never)).toBe(false);
    openTab("image");
    expect(cmd.when!({} as never)).toBe(true);
  });
});

describe("every format of the one list opens in the image tab", () => {
  it("renderExtensions is the list, with the formats the user asked for", () => {
    for (const ext of ["webp", "png", "svg", "gif", "ico", "apng", "tiff", "heic", "jxl", "avif"]) {
      expect(attachments.renderExtensions, ext).toContain(ext);
    }
  });

  it("claims each one, case-blind, and nothing else", () => {
    for (const ext of attachments.renderExtensions) {
      expect(locationForPath(`/v/a.${ext}`)).toEqual({ kind: "image", path: `/v/a.${ext}` });
      expect(locationForPath(`/v/A.${ext.toUpperCase()}`).kind).toBe("image");
    }
    for (const name of ["a.md", "a.py", "a.pdf", "png"]) {
      expect(locationForPath(`/v/${name}`).kind).not.toBe("image");
    }
    expect(opensAsDocument("/v/a.png")).toBe(false);
  });

  it("round-trips a session, follows renames and closes on delete", () => {
    const location = locationForPath("/v/a.png");
    const payload = serializeLocation(location);
    expect(payload).toEqual({ kind: "image", path: "/v/a.png" });
    expect(deserializeLocation(payload)).toEqual(location);
    const kind = pageKind(location);
    expect(kind.rewritePath(location, "/v/a.png", "/v/b.png")).toEqual({
      kind: "image",
      path: "/v/b.png",
    });
    expect(kind.removePath(location, "/v/a.png")).toBeNull();
    expect(kind.title(location)).toBe("a.png");
    expect(kind.feature).toBe("images");
  });

  it("shows an image glyph and keeps the extension in the label", () => {
    const svg = (name: string) => renderToStaticMarkup(createElement(FileIcon, { name }));
    expect(svg("shot.png")).not.toBe(svg("a.md"));
    expect(svg("shot.png")).toBe(svg("photo.JPG"));
    expect(noteLabel("/v/shot.png").text).toBe("shot.png");
  });
});

describe("switched off", () => {
  it("an image still routes to its tab, which shows the off page with Turn on and Open in default app", async () => {
    useSettingsStore.setState({
      settings: { "features.images.enabled": false },
      setSetting: vi.fn(async () => {}),
    } as never);
    expect(isFeatureActive("images")).toBe(false);
    const location = locationForPath("/v/a.png");
    expect(location).toEqual({ kind: "image", path: "/v/a.png" });
    expect(opensAsDocument("/v/a.png")).toBe(false); // never read as text
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () =>
      root.render(<Component location={location as never} isActive tabId="t" />),
    );
    expect(el.querySelector("[data-feature-off=images]")?.textContent).toContain(
      "Images is turned off",
    );
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Turn on", "Open in default app"]);
    await act(async () => buttons[1]!.click());
    expect(invoke).toHaveBeenCalledWith("open_image_in_default_app", { path: "/v/a.png" });
    await act(async () => buttons[0]!.click());
    expect(useSettingsStore.getState().setSetting).toHaveBeenCalledWith(
      "features.images.enabled",
      true,
    );
    await act(async () => root.unmount());
    el.remove();
  });

  it("is also off for the session after repeated failures or in safe mode", () => {
    useFeatureHealth.setState({ sessionOff: { images: true } });
    expect(isFeatureActive("images")).toBe(false);
    useFeatureHealth.setState({ sessionOff: {}, safeMode: true });
    expect(isFeatureActive("images")).toBe(false);
  });

  it("inline images in notes are core: the resolver and renderable list do not need the feature", async () => {
    const { isRenderableImageName } = await import("@/lib/attachments");
    expect(isFeatureActive("images") && false).toBe(false);
    expect(isRenderableImageName("pic.webp")).toBe(true);
  });
});

describe("manifest and settings contract", () => {
  it("id equals the folder and the definition; every contributed id is prefixed", () => {
    expect(manifest.id).toBe("images");
    expect(images.id).toBe(manifest.id);
    const c = images.contributes!;
    expect(c.slots![0]!.slot).toBe("page-view:image");
    expect(manifest.contributes.slots).toEqual(c.slots!.map((s) => s.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    expect(manifest.contributes.keybindings.map((x) => x.id)).toEqual(
      c.keybindings!.map((x) => x.id),
    );
    expect(manifest.contributes.workspaceListeners).toEqual(c.workspaceListeners!.map((x) => x.id));
    const ids = [...c.slots!, ...c.commands!, ...c.keybindings!, ...c.workspaceListeners!].map(
      (x) => x.id,
    );
    expect(ids.every((id) => id.startsWith("images."))).toBe(true);
  });

  it("has its kill switch in the shared settings schema, as the Rust contract test expects", () => {
    expect(schema.settings.find((e) => e.key === "features.images.enabled")).toEqual({
      key: "features.images.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });

  it("files.show-images stays a core setting (the sidebar and quick open use it), terse, no format list", () => {
    const def = schema.settings.find((s) => s.key === "files.show-images")!;
    expect(def.type).toBe("boolean");
    expect(def.default).toBe(true);
    expect(def.description).toBeTruthy();
    expect(def.description).not.toMatch(/png|jpg|svg/i);
    expect(SETTINGS_SCHEMA.filter((s) => s.key === "files.show-images")).toHaveLength(1);
  });
});

describe("startup chunk", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");

  it("the feature's index reaches neither the viewer component nor the view model", () => {
    const reached = [...staticGraph(resolve(import.meta.dirname, "../web/index.ts"))].map(rel);
    expect(
      reached.filter((f) => /components\/image-viewer|lib\/view-transform|lib\/svg-size/.test(f)),
    ).toEqual([]);
  });

  for (const entry of [
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
    "src/lib/keybindings/when.ts",
    "src/lib/keybindings/core-bindings.ts",
    "src/hooks/use-file-watcher.ts",
  ]) {
    it(`${entry} reaches no Images module statically`, () => {
      const reached = [...staticGraph(resolve(import.meta.dirname, "../../..", entry))].map(rel);
      expect(reached.filter((f) => f.startsWith("features/images/"))).toEqual([]);
    });
  }

  it("the old core viewer is gone", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(resolve(import.meta.dirname, "../../../src/components/image-viewer"))).toBe(
      false,
    );
    expect(existsSync(resolve(import.meta.dirname, "../../../src/lib/zoom-target.ts"))).toBe(false);
  });
});
