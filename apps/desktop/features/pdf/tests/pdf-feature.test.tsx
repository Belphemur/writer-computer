// The PDF feature as a built-in: registers and unregisters cleanly, the kill switch removes the
// reader (a PDF tab shows the off page, the zoom chords go back to the editor), `.pdf` routes to
// the pdf page kind, the keys apply only in a PDF tab, the manifest matches the code and the
// shared schema, pdf.js stays out of the startup chunk and out of every file but one, and the
// `pdf.info` service answers page counts.
// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === "features_status") return { safeMode: false, crashDisabled: [], failures: [] };
    if (cmd === "read_document") return new ArrayBuffer(8);
    return undefined;
  }),
);
const pdf = vi.hoisted(() => ({ pages: 7, destroyed: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../web/lib/pdf-lib", () => ({
  openDocument: vi.fn(async () => ({
    numPages: pdf.pages,
    destroy: () => void pdf.destroyed++,
  })),
}));

import "@/lib/features/builtin";
import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { featureHost as host } from "@/lib/features/registry";
import { isFeatureEnabled } from "@/lib/features/builtin";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { getService } from "@/lib/features/services";
import { serviceContributions } from "@/lib/features/services";
import { slotContributions } from "@/lib/features/slots";
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
import { isDocumentName } from "@/lib/attachments";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import attachments from "@shared/attachments.json";
import schema from "@shared/settings.schema.json";
import manifest from "../feature.json";
import pdfFeature from "../web";
import { PDFJS_DATA_URLS } from "../web/lib/asset-urls";
import { pdfjsAssetFiles } from "../vite-assets";
import { PDF_INFO, type PdfInfo } from "../web/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:pdf").length;
const counts = () => [
  mine(slotContributions.list()),
  mine(keybindings.list() as never),
  mine(editorExtensionContributions.list()),
  mine(serviceContributions.list()),
  mine(featurePaletteCommands.list() as never),
];
const ON = [1, 4, 1, 1, 4];
const OFF = [0, 0, 0, 0, 0];

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
    expect(host.list()).toContain("pdf");
    expect(counts()).toEqual(ON);
  });

  it("the kill switch removes exactly them, and turning it back on restores them", async () => {
    useSettingsStore.setState({ settings: { "features.pdf.enabled": false } });
    await settle();
    expect(host.list()).not.toContain("pdf");
    expect(counts()).toEqual(OFF);
    expect(getService(PDF_INFO)).toBeUndefined();
    useSettingsStore.setState({ settings: {} });
    await settle();
    expect(counts()).toEqual(ON);
  });
});

describe("keys apply only in a PDF tab", () => {
  const mod = detectPlatform() === "macos" ? { metaKey: true } : { ctrlKey: true };
  const key = (k: string, code: string) =>
    new KeyboardEvent("keydown", { key: k, code, ...mod, bubbles: true });
  const openTab = (kind: "pdf" | "image" | "file") =>
    useEditorStore.setState({
      tabs: [
        {
          id: "t",
          location: {
            kind,
            path: `/v/a.${kind === "file" ? "md" : kind === "pdf" ? "pdf" : "png"}`,
          },
          back: [],
          forward: [],
        },
      ],
      activeTabId: "t",
    } as never);

  it("are listed in the registry (Settings > Hotkeys) with the editor's chords", () => {
    expect(keybindings.effectiveKeys("pdf.zoom-in")).toContain(
      keybindings.effectiveKeys("zoom-in")[0],
    );
    expect(keybindings.effectiveKeys("pdf.zoom-out")).toEqual(
      keybindings.effectiveKeys("zoom-out"),
    );
    expect(keybindings.effectiveKeys("pdf.fit")).toEqual(keybindings.effectiveKeys("zoom-reset"));
    expect(keybindings.get("pdf.zoom-in")!.category).toBe("View");
    expect(keybindings.effectiveKeys("pdf.find")).toEqual(["Mod+F"]);
  });

  it("a PDF tab: = - 0 F reach the reader's commands, not the editor's zoom", () => {
    openTab("pdf");
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("pdf.zoom-in");
    expect(keybindings.find(key("-", "Minus"), "bubble")!.id).toBe("pdf.zoom-out");
    expect(keybindings.find(key("0", "Digit0"), "bubble")!.id).toBe("pdf.fit");
    expect(keybindings.find(key("f", "KeyF"), "bubble")!.id).toBe("pdf.find");
  });

  it("an image tab keeps the image viewer's chords, a note tab the editor's text zoom", () => {
    openTab("image");
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("images.zoom-in");
    expect(keybindings.find(key("f", "KeyF"), "bubble")).toBeUndefined();
    openTab("file");
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("zoom-in");
    expect(keybindings.find(key("-", "Minus"), "bubble")!.id).toBe("zoom-out");
    expect(keybindings.find(key("0", "Digit0"), "bubble")!.id).toBe("zoom-reset");
    expect(keybindings.find(key("f", "KeyF"), "bubble")).toBeUndefined(); // the editor's own find
  });

  it("feature off, a PDF tab (the off page) leaves the chords to the editor", async () => {
    openTab("pdf");
    useSettingsStore.setState({ settings: { "features.pdf.enabled": false } });
    await settle();
    expect(keybindings.find(key("=", "Equal"), "bubble")!.id).toBe("zoom-in");
  });

  it("the palette commands exist only for a PDF tab", () => {
    for (const id of ["pdf.zoom-in", "pdf.zoom-out", "pdf.fit", "pdf.find"]) {
      const cmd = featurePaletteCommands.list().find((c) => c.id === id)!;
      openTab("file");
      expect(cmd.when!({} as never), id).toBe(false);
      openTab("pdf");
      expect(cmd.when!({} as never), id).toBe(true);
    }
  });
});

describe("a .pdf opens in the pdf tab", () => {
  it("documentExtensions is the one list", () => {
    expect(attachments.documentExtensions).toEqual(["pdf"]);
    expect(isDocumentName("a.pdf") && isDocumentName("A.PDF")).toBe(true);
    expect(isDocumentName("a.png") || isDocumentName("pdf")).toBe(false);
  });

  it("claims it case-blind, never as a text document, and nothing else", () => {
    expect(locationForPath("/v/a.pdf")).toEqual({ kind: "pdf", path: "/v/a.pdf" });
    expect(locationForPath("/v/A.PDF").kind).toBe("pdf");
    expect(opensAsDocument("/v/a.pdf")).toBe(false);
    for (const name of ["a.md", "a.png", "a.py", "pdf", "a.pdf.txt"]) {
      expect(locationForPath(`/v/${name}`).kind).not.toBe("pdf");
    }
  });

  it("round-trips a session, follows renames and closes on delete", () => {
    const location = locationForPath("/v/a.pdf");
    const payload = serializeLocation(location);
    expect(payload).toEqual({ kind: "pdf", path: "/v/a.pdf" });
    expect(deserializeLocation(payload)).toEqual(location);
    const kind = pageKind(location);
    expect(kind.rewritePath(location, "/v/a.pdf", "/v/b.pdf")).toEqual({
      kind: "pdf",
      path: "/v/b.pdf",
    });
    expect(kind.removePath(location, "/v/a.pdf")).toBeNull();
    expect(kind.title(location)).toBe("a.pdf");
    expect(kind.feature).toBe("pdf");
    expect(kind.claimsWhenOff).toBe(true);
  });

  it("shows a PDF glyph and keeps the extension in the label", () => {
    const svg = (name: string) => renderToStaticMarkup(createElement(FileIcon, { name }));
    expect(svg("paper.pdf")).not.toBe(svg("a.md"));
    expect(svg("paper.pdf")).not.toBe(svg("a.png"));
    expect(svg("paper.pdf")).toBe(svg("Paper.PDF"));
    expect(noteLabel("/v/paper.pdf").text).toBe("paper.pdf");
  });
});

describe("switched off", () => {
  it("a PDF still routes to its tab, which shows the off page with Turn on and Open in default app", async () => {
    useSettingsStore.setState({
      settings: { "features.pdf.enabled": false },
      setSetting: vi.fn(async () => {}),
    } as never);
    expect(isFeatureActive("pdf")).toBe(false);
    const location = locationForPath("/v/a.pdf");
    expect(location).toEqual({ kind: "pdf", path: "/v/a.pdf" });
    expect(opensAsDocument("/v/a.pdf")).toBe(false); // never read as text
    const { Component } = pageKindView(location);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () =>
      root.render(<Component location={location as never} isActive tabId="t" />),
    );
    expect(el.querySelector("[data-feature-off=pdf]")?.textContent).toContain("PDF is turned off");
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Turn on", "Open in default app"]);
    await act(async () => buttons[1]!.click());
    expect(invoke).toHaveBeenCalledWith("open_attachment_in_default_app", { path: "/v/a.pdf" });
    await act(async () => buttons[0]!.click());
    expect(useSettingsStore.getState().setSetting).toHaveBeenCalledWith(
      "features.pdf.enabled",
      true,
    );
    await act(async () => root.unmount());
    el.remove();
  });

  it("is also off for the session after repeated failures or in safe mode", () => {
    useFeatureHealth.setState({ sessionOff: { pdf: true } });
    expect(isFeatureActive("pdf")).toBe(false);
    useFeatureHealth.setState({ sessionOff: {}, safeMode: true });
    expect(isFeatureActive("pdf")).toBe(false);
  });
});

describe("the pdf.info service", () => {
  it("counts the pages of bytes and of a path, then lets the document go", async () => {
    const info = getService<PdfInfo>(PDF_INFO)!;
    expect(info).toBeDefined();
    expect(await info.pageCountOfBytes(new Uint8Array([1, 2, 3]))).toBe(7);
    expect(pdf.destroyed).toBe(1);
    pdf.pages = 12;
    expect(await info.pageCountOfPath("/v/a.pdf")).toBe(12);
    expect(invoke).toHaveBeenCalledWith("read_document", { path: "/v/a.pdf" });
    expect(pdf.destroyed).toBe(2);
  });
});

describe("manifest and settings contract", () => {
  it("id equals the folder and the definition; every contributed id is prefixed", () => {
    expect(manifest.id).toBe("pdf");
    expect(pdfFeature.id).toBe(manifest.id);
    const c = pdfFeature.contributes!;
    expect(c.slots![0]!.slot).toBe("page-view:pdf");
    expect(manifest.contributes.slots).toEqual(c.slots!.map((s) => s.id));
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    expect(manifest.contributes.keybindings.map((x) => x.id)).toEqual(
      c.keybindings!.map((x) => x.id),
    );
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((x) => x.id));
    expect(manifest.contributes.services).toEqual(c.services!.map((x) => x.id));
    expect(manifest.provides).toEqual(c.services!.map((x) => x.id));
    const ids = [
      ...c.slots!,
      ...c.commands!,
      ...c.keybindings!,
      ...c.editorExtensions!,
      ...c.services!,
    ].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("pdf."))).toBe(true);
    expect(PDF_INFO).toBe("pdf.info");
  });

  it("has its kill switch in the shared settings schema, as the Rust contract test expects", () => {
    expect(schema.settings.find((e) => e.key === "features.pdf.enabled")).toEqual({
      key: "features.pdf.enabled",
      label: manifest.name,
      description: `Turns the ${manifest.name} feature on or off.`,
      category: "Features",
      type: "boolean",
      default: true,
      scope: "global",
    });
  });

  it("files.show-pdfs is a core setting beside show-images: terse, on by default", () => {
    const def = schema.settings.find((s) => s.key === "files.show-pdfs")!;
    expect(def.label).toBe("Show PDFs");
    expect(def.type).toBe("boolean");
    expect(def.default).toBe(true);
    expect(def.category).toBe("Files");
    expect(SETTINGS_SCHEMA.filter((s) => s.key === "files.show-pdfs")).toHaveLength(1);
    expect(schema.settings.some((s) => s.key === "pdf.show-pdfs")).toBe(false);
  });
});

describe("startup chunk", () => {
  const rel = (f: string) => f.replace(/.*\/apps\/desktop\//, "");
  const LIB = /^pdfjs-dist(\/|$)/;
  const staticSpecs = (entry: string) =>
    [...staticGraph(entry)].flatMap((f) =>
      importsOf(f)
        .filter((i) => !i.dynamic && !i.typeOnly)
        .map((i) => i.spec),
    );

  it("the feature's index reaches neither pdf.js nor the reader", () => {
    const entry = resolve(import.meta.dirname, "../web/index.ts");
    expect(staticSpecs(entry).filter((s) => LIB.test(s))).toEqual([]);
    expect(
      [...staticGraph(entry)]
        .map(rel)
        .filter((f) =>
          /features\/pdf\/web\/(lib\/(pdf-lib|use-|page-layout|find)|components\/|embed-decorations)/.test(
            f,
          ),
        ),
    ).toEqual([]);
  });

  for (const entry of [
    "src/main.tsx",
    "src/components/editor-area/page-kinds/views.tsx",
    "src/components/editor-area/page-kinds/index.ts",
    "src/lib/keybindings/when.ts",
    "src/lib/keybindings/core-bindings.ts",
  ]) {
    it(`${entry} reaches no pdf.js and no PDF module beyond the light index`, () => {
      expect(staticSpecs(resolve(DESKTOP, entry)).filter((s) => LIB.test(s))).toEqual([]);
      const reached = [...staticGraph(resolve(DESKTOP, entry))].map(rel);
      expect(
        reached.filter(
          (f) =>
            f.startsWith("features/pdf/") &&
            !/features\/pdf\/web\/(index|api)\.ts$|features\/pdf\/web\/lib\/viewer-controller\.ts$/.test(
              f,
            ),
        ),
      ).toEqual([]);
    });
  }

  it("only the feature's pdf-lib.ts imports the package", () => {
    const offenders: string[] = [];
    for (const root of ["src", "features"]) {
      for (const f of sourceFiles(resolve(DESKTOP, root))) {
        if (importsOf(f).some((i) => LIB.test(i.spec))) offenders.push(rel(f));
      }
    }
    expect(offenders.filter((f) => !f.startsWith("features/pdf/tests/"))).toEqual([
      "features/pdf/web/lib/pdf-lib.ts",
    ]);
  });

  it("pins the dependency exactly in the workspace catalog and loads the worker from the bundle", () => {
    const text = readFileSync(resolve(DESKTOP, "../../pnpm-workspace.yaml"), "utf8");
    expect(text).toMatch(/["']?pdfjs-dist["']?: 6\.5\.438\s*$/m);
    const lib = readFileSync(resolve(DESKTOP, "features/pdf/web/lib/pdf-lib.ts"), "utf8");
    expect(lib).toMatch(/pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url/);
    expect(lib).not.toMatch(/https?:\/\//); // no CDN
  });

  it("pdf.js reads fonts, CMaps and wasm from same-origin folders that exist in the package", () => {
    expect(PDFJS_DATA_URLS).toEqual({
      standardFontDataUrl: "/pdfjs-assets/standard_fonts/",
      cMapUrl: "/pdfjs-assets/cmaps/",
      cMapPacked: true,
      wasmUrl: "/pdfjs-assets/wasm/",
    });
    for (const url of [
      PDFJS_DATA_URLS.standardFontDataUrl,
      PDFJS_DATA_URLS.cMapUrl,
      PDFJS_DATA_URLS.wasmUrl,
    ]) {
      expect(url).toMatch(/^\/[^/]/); // same origin, no scheme
      expect(pdfjsAssetFiles().some((f) => url.endsWith(`/${f.split("/")[0]}/`))).toBe(true);
    }
    const files = pdfjsAssetFiles();
    expect(files).toContain("standard_fonts/FoxitFixed.pfb");
    expect(files).toContain("wasm/openjpeg.wasm");
    expect(files.some((f) => f.startsWith("cmaps/") && f.endsWith(".bcmap"))).toBe(true);
    expect(files.some((f) => f.endsWith(".js") || f.includes("LICENSE"))).toBe(false);
    const lib = readFileSync(resolve(DESKTOP, "features/pdf/web/lib/pdf-lib.ts"), "utf8");
    expect(lib).toContain("...PDFJS_DATA_URLS");
  });

  it("the app bundle keeps pdf.js out of the entry chunk and emits its worker as an asset", () => {
    const out = mkdtempSync(join(tmpdir(), "pdf-build-"));
    try {
      execFileSync("pnpm", ["exec", "vp", "build", "--outDir", out], {
        cwd: DESKTOP,
        stdio: "pipe",
        timeout: 170_000,
      });
      const assets = readdirSync(join(out, "assets"));
      const entry = assets.filter((f) => /^index-.*\.js$/.test(f));
      expect(entry.length).toBeGreaterThan(0);
      for (const f of entry) {
        const code = readFileSync(join(out, "assets", f), "utf8");
        expect(code).not.toMatch(/GlobalWorkerOptions|PDFWorker|pdfjs-dist|TextLayer\b/);
      }
      expect(assets.some((f) => /^pdf\.worker\.min-.*\.mjs$/.test(f))).toBe(true);
      expect(existsSync(join(out, "index.html"))).toBe(true);
      expect(readFileSync(join(out, "index.html"), "utf8")).not.toMatch(/pdf\.worker/);
      // The data files are copied next to the chunks and every wired URL resolves to a folder of them.
      const files = pdfjsAssetFiles();
      for (const rel of files) expect(existsSync(join(out, "pdfjs-assets", rel)), rel).toBe(true);
      for (const key of ["standardFontDataUrl", "cMapUrl", "wasmUrl"] as const) {
        const dir = PDFJS_DATA_URLS[key].slice(1); // relative to the bundle root
        expect(existsSync(join(out, dir)), key).toBe(true);
        expect(readdirSync(join(out, dir)).length, key).toBeGreaterThan(0);
      }
      // Nothing loads them at startup: the entry chunk never names the folder.
      for (const f of entry) {
        expect(readFileSync(join(out, "assets", f), "utf8")).not.toContain("pdfjs-assets");
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 200_000);
});
