// pdf.js reads standard fonts (PDFs that do not embed theirs), packed CMaps (CJK and other legacy
// encodings) and its wasm decoders (JPEG 2000, JBIG2, colour) from URLs. This plugin serves them
// from the installed package in dev and copies them into the bundle on build, so a PDF never
// reaches the network; the files are only fetched when a PDF needs them. The `*_nowasm_fallback.js`
// scripts and licence files are left out.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PDFJS_ASSET_PREFIX } from "./web/lib/asset-urls";

/** Each folder served, with the extensions that belong to it. */
const FOLDERS: Record<string, string[]> = {
  standard_fonts: [".pfb", ".ttf"],
  cmaps: [".bcmap"],
  wasm: [".wasm"],
};

function packageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
}

/** Every bundled data file as `<folder>/<file>`. */
export function pdfjsAssetFiles(root = packageRoot()): string[] {
  return Object.entries(FOLDERS).flatMap(([folder, exts]) =>
    readdirSync(join(root, folder))
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .map((f) => `${folder}/${f}`),
  );
}

export function pdfjsAssets() {
  const root = packageRoot();
  return {
    name: "writer:pdfjs-assets",
    prefix: PDFJS_ASSET_PREFIX,
    root,
    files: () => pdfjsAssetFiles(root),
    contentType: () => "application/octet-stream",
  };
}
