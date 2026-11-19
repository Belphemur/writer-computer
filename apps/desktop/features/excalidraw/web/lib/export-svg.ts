// Drawing to SVG (ADR 2026-11-18, point 6): Excalidraw's own `exportToSvg`, from the file's text,
// so the tab's button, the auto-export after a save or an outside change, and `writer
// excalidraw:export` all produce the same SVG from what is on disk. Rendered off-screen: nothing
// here needs a tab.
import { useSettingsStore } from "@/stores/settings-store";
import * as tauri from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { loadDrawingText } from "./drawing-file";
import { flushLiveView } from "./live-views";
import { loadExcalidraw } from "./excalidraw-lib";

/** `Dir/Arch.excalidraw.md` and `Dir/Arch.excalidraw` both export to `Dir/Arch.svg`. */
export function svgPathOf(drawingPath: string): string {
  return drawingPath.replace(/\.excalidraw(\.md)?$/i, "") + ".svg";
}

const CACHE_LIMIT = 40;
const cache = new Map<string, string>();

/** FNV-1a of the text: a cache key, not a security measure. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

/** The SVG markup of a drawing's text. Cached by content hash, so an embed that shows an
 *  unchanged drawing again costs nothing. `dark` is the export's dark mode. */
export async function renderSvg(path: string, text: string, dark = false): Promise<string> {
  const key = `${contentHash(text)}:${dark ? "d" : "l"}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const [lib, loaded] = await Promise.all([loadExcalidraw(), loadDrawingText(path, text)]);
  const scene = loaded.parsed.scene;
  const svg = await lib.exportToSvg({
    elements: scene.elements.filter((e) => e.isDeleted !== true),
    appState: {
      exportBackground: true,
      exportWithDarkMode: dark,
      viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff",
    },
    files: loaded.files,
    exportPadding: 12,
  });
  const markup = new XMLSerializer().serializeToString(svg);
  cache.set(key, markup);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return markup;
}

/** Write `<name>.svg` next to the drawing from what the file holds now (an open tab saves first).
 *  Returns the SVG's absolute path. */
export async function exportSvgFile(path: string): Promise<string> {
  await flushLiveView(path);
  const text = (await tauri.readFile(path)).content;
  const svg = svgPathOf(path);
  await tauri.writeFile(svg, await renderSvg(path, text));
  return svg;
}

// ---- keeping the SVG current (setting `excalidraw.auto-export-svg`) ----------------------------

const AUTO_DEBOUNCE_MS = 400;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function autoExportEnabled(): boolean {
  return useSettingsStore.getState().settings["excalidraw.auto-export-svg"] === true;
}

/** After a save or a change from outside: re-export once the writes settle, when the setting is
 *  on. A failure is logged (never the path) and never stops the next one. */
export function scheduleAutoExport(
  path: string,
  run: (p: string) => Promise<unknown> = exportSvgFile,
) {
  if (!autoExportEnabled()) return;
  const wait = pending.get(path);
  if (wait) clearTimeout(wait);
  pending.set(
    path,
    setTimeout(() => {
      pending.delete(path);
      run(path).catch((e: unknown) =>
        logger.warn("excalidraw", `automatic SVG export failed: ${String(e)}`),
      );
    }, AUTO_DEBOUNCE_MS),
  );
}

export const __testExport = { cache, pending };
