// @vitest-environment jsdom
// The small pieces around the canvas: the embed grammar, SVG paths and auto-export, the socket
// handler, new-drawing names, the one-time plugin takeover and the live-view registry.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const confirmAction = vi.hoisted(() => vi.fn(async () => true));
const readFile = vi.hoisted(() => vi.fn(async (_p: string) => ({ content: "TEXT" })));
const writeFile = vi.hoisted(() => vi.fn(async (_p: string, _c: string) => ({})));
vi.mock("@/lib/tauri", () => ({
  confirmAction,
  readFile,
  writeFile,
  fileExists: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const renderLib = vi.hoisted(() => ({
  exportToSvg: vi.fn(async () => document.createElementNS("http://www.w3.org/2000/svg", "svg")),
  exportToBlob: vi.fn(
    async (_: unknown) =>
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
  ),
}));
vi.mock("../web/lib/excalidraw-lib", () => ({ loadExcalidraw: async () => renderLib }));
vi.mock("../web/lib/drawing-file", () => ({
  loadDrawingText: async () => ({
    parsed: { scene: { elements: [{ id: "a", isDeleted: false }], appState: {} } },
    files: {},
  }),
}));

import { setRunningCommunityPlugins, setCommunityPluginControl } from "@/lib/community-plugins";
import { useSettingsStore } from "@/stores/settings-store";
import { parseDrawingEmbedLine, parseDrawingEmbedTarget } from "../web/lib/embeds";
import { flushLiveView, registerLiveView } from "../web/lib/live-views";
import { freeDrawingPath } from "../web/lib/new-drawing";
import { PLUGIN_ID, offerTakeover, __testTakeover } from "../web/lib/takeover";
import {
  __testExport,
  contentHash,
  exportSvgFile,
  renderSvg,
  scheduleAutoExport,
  svgPathOf,
} from "../web/lib/export-svg";
import { handleRender } from "../web/render";

describe("embeds", () => {
  it("reads a drawing embed alone on a line, with or without alias and folders", () => {
    // the wiki-link grammar drops a trailing .md; the vault resolves the name to either format
    expect(parseDrawingEmbedLine("![[Arch.excalidraw.md]]")).toEqual({ target: "Arch.excalidraw" });
    expect(parseDrawingEmbedLine("  ![[Dir/Arch.excalidraw|alias]]  ")).toEqual({
      target: "Dir/Arch.excalidraw",
    });
    expect(parseDrawingEmbedTarget("Arch.excalidraw.md#^block")).toEqual({
      target: "Arch.excalidraw",
    });
  });
  it("leaves every other line alone", () => {
    for (const line of [
      "![[photo.png]]",
      "[[Arch.excalidraw.md]]",
      "text ![[Arch.excalidraw.md]]",
      "![[note]]",
      "![[Arch.excalidraw.md]] after",
    ]) {
      expect(parseDrawingEmbedLine(line)).toBeNull();
    }
  });
});

describe("export", () => {
  beforeEach(() => {
    __testExport.cache.clear();
    __testExport.pending.clear();
    readFile.mockClear();
    writeFile.mockClear();
    renderLib.exportToSvg.mockClear();
  });

  it("names the svg next to the drawing for both formats", () => {
    expect(svgPathOf("Dir/Arch.excalidraw.md")).toBe("Dir/Arch.svg");
    expect(svgPathOf("Arch.excalidraw")).toBe("Arch.svg");
  });

  it("hashes by content", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("renders once per content and theme, and exports without deleted elements", async () => {
    await renderSvg("a.excalidraw", "T");
    await renderSvg("a.excalidraw", "T");
    expect(renderLib.exportToSvg).toHaveBeenCalledTimes(1);
    await renderSvg("a.excalidraw", "T", true);
    expect(renderLib.exportToSvg).toHaveBeenCalledTimes(2);
  });

  it("saves the open tab first, then writes <name>.svg from the file", async () => {
    const order: string[] = [];
    registerLiveView("D/a.excalidraw.md", { flush: async () => void order.push("flush") });
    readFile.mockImplementationOnce(async () => {
      order.push("read");
      return { content: "T" };
    });
    expect(await exportSvgFile("D/a.excalidraw.md")).toBe("D/a.svg");
    expect(order).toEqual(["flush", "read"]);
    expect(writeFile.mock.calls[0]![0]).toBe("D/a.svg");
    expect(writeFile.mock.calls[0]![1]).toContain("<svg");
  });

  it("the socket handler answers the SVG markup, and refuses a missing path or format", async () => {
    const svg = await handleRender({ path: "a.excalidraw", format: "svg" });
    expect(svg.format).toBe("svg");
    expect(svg.data).toContain("<svg");
    await expect(handleRender({ format: "svg" })).rejects.toThrow("no drawing path");
    await expect(handleRender(null)).rejects.toThrow("no drawing path");
    await expect(handleRender({ path: "a.excalidraw", format: "gif" })).rejects.toThrow("format");
  });

  it("the PNG render goes through exportToBlob at the scale and answers base64", async () => {
    const out = await handleRender({ path: "a.excalidraw", format: "png", scale: 2 });
    expect(out).toEqual({ format: "png", data: "iVBORw==" });
    const call = renderLib.exportToBlob.mock.calls.at(-1)![0] as {
      mimeType: string;
      getDimensions: (w: number, h: number) => unknown;
      appState: { exportWithDarkMode: boolean };
    };
    expect(call.mimeType).toBe("image/png");
    expect(call.appState.exportWithDarkMode).toBe(false);
    expect(call.getDimensions(100, 50)).toEqual({ width: 200, height: 100, scale: 2 });
    await handleRender({ path: "a.excalidraw", format: "png" });
    const dflt = renderLib.exportToBlob.mock.calls.at(-1)![0] as {
      getDimensions: (w: number, h: number) => unknown;
    };
    expect(dflt.getDimensions(100, 50)).toEqual({ width: 100, height: 50, scale: 1 });
  });

  it("auto-export runs once after the writes settle, only when the setting is on", () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({}));
    useSettingsStore.setState({ settings: {} });
    scheduleAutoExport("a.excalidraw", run);
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
    useSettingsStore.setState({ settings: { "excalidraw.auto-export-svg": true } });
    scheduleAutoExport("a.excalidraw", run);
    scheduleAutoExport("a.excalidraw", run);
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("live views", () => {
  it("flushes the registered view and forgets it when unregistered", async () => {
    const flush = vi.fn(async () => {});
    const off = registerLiveView("x", { flush });
    await flushLiveView("x");
    expect(flush).toHaveBeenCalledTimes(1);
    off();
    await flushLiveView("x");
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("new drawing", () => {
  it("takes the first free name", async () => {
    const taken = new Set(["D/Drawing.excalidraw", "D/Drawing 1.excalidraw"]);
    expect(await freeDrawingPath("D", async (p) => taken.has(p))).toBe("D/Drawing 2.excalidraw");
    expect(await freeDrawingPath("E", async () => false)).toBe("E/Drawing.excalidraw");
  });
});

describe("plugin takeover", () => {
  const setEnabled = vi.fn(async () => {});
  beforeEach(() => {
    localStorage.clear();
    confirmAction.mockClear();
    setEnabled.mockClear();
    setRunningCommunityPlugins([PLUGIN_ID]);
    setCommunityPluginControl({ setEnabled });
  });

  it("asks once and turns the plugin off in Writer on yes", async () => {
    expect(await offerTakeover()).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(PLUGIN_ID, false);
    expect(await offerTakeover()).toBe(false);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(__testTakeover.ASKED_KEY)).toBe("1");
  });

  it("remembers a no and never asks again", async () => {
    confirmAction.mockResolvedValueOnce(false);
    expect(await offerTakeover()).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await offerTakeover()).toBe(false);
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the plugin is not running", async () => {
    setRunningCommunityPlugins([]);
    expect(await offerTakeover()).toBe(false);
    expect(confirmAction).not.toHaveBeenCalled();
  });
});
