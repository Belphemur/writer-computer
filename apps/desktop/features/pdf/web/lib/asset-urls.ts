// Where pdf.js finds its data files: same origin, served by `features/pdf/vite-assets.ts` (dev)
// or copied into the bundle (build). The prefix is relative to the app's base.
export const PDFJS_ASSET_PREFIX = "/pdfjs-assets/";

const folder = (name: string) => `${PDFJS_ASSET_PREFIX}${name}/`;

export const PDFJS_DATA_URLS = {
  standardFontDataUrl: folder("standard_fonts"),
  cMapUrl: folder("cmaps"),
  cMapPacked: true,
  wasmUrl: folder("wasm"),
} as const;
