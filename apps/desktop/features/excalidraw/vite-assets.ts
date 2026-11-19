// Excalidraw loads its fonts from `window.EXCALIDRAW_ASSET_PATH` (`web/lib/excalidraw-lib.ts`
// points it at `/excalidraw-assets/`). This plugin serves them from the installed package in dev
// and copies them into the bundle on build, so a drawing never reaches the network (ADR
// 2026-11-18, point 1). The Xiaolai CJK font (12 MB) is left out: CJK text falls back to the
// system font.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

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

export function excalidrawAssets(): Plugin {
  const root = fontsDir();
  return {
    name: "writer:excalidraw-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(ASSET_URL_PREFIX)) return next();
        const file = resolve(dirname(root), decodeURIComponent(url.slice(ASSET_URL_PREFIX.length)));
        if (
          !file.startsWith(root) ||
          !excalidrawFontFiles(root).includes(relative(dirname(root), file).split("\\").join("/"))
        ) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const rel of excalidrawFontFiles(root)) {
        this.emitFile({
          type: "asset",
          fileName: `${ASSET_URL_PREFIX.slice(1)}${rel}`,
          source: readFileSync(join(dirname(root), rel)),
        });
      }
    },
  };
}
