// Excalidraw loads its fonts from `window.EXCALIDRAW_ASSET_PATH` (`web/lib/excalidraw-lib.ts`
// points it at `/excalidraw-assets/`). This plugin serves them from the installed package in dev
// and copies them into the bundle on build, so a drawing never reaches the network (ADR
// 2026-11-18, point 1). The Xiaolai CJK font (12 MB) is left out: CJK text falls back to the
// system font.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

export const ASSET_URL_PREFIX = "/excalidraw-assets/";
const EXCLUDED_FAMILIES = new Set(["Xiaolai"]);

function fontsDir(): string {
  const entry = createRequire(import.meta.url).resolve("@excalidraw/excalidraw");
  // .../@excalidraw/excalidraw/dist/prod/index.js -> .../dist/prod/fonts
  return join(dirname(entry), "fonts");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every bundled font file as `fonts/<Family>/<file>`, without the excluded families. */
export function excalidrawFontFiles(root = fontsDir()): string[] {
  return walk(root)
    .map((full) => relative(dirname(root), full).split("\\").join("/"))
    .filter((rel) => !EXCLUDED_FAMILIES.has(rel.split("/")[1] ?? ""));
}

export function excalidrawAssets() {
  const root = fontsDir();
  return {
    name: "writer:excalidraw-assets",
    prefix: ASSET_URL_PREFIX,
    // Files are `fonts/<Family>/<file>`, relative to the folder above `fonts`.
    root: dirname(root),
    files: () => excalidrawFontFiles(root),
    contentType: () => "font/woff2",
  };
}
