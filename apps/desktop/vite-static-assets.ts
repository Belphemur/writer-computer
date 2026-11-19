// One Vite plugin shape for "serve these files of an installed package at a same-origin prefix in
// dev, emit them into the bundle on build". Excalidraw's fonts and pdf.js's fonts, CMaps and wasm
// use it, so a feature never reaches the network for its data files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export interface StaticAssets {
  name: string;
  /** URL prefix with both slashes, e.g. `/pdfjs-assets/`. */
  prefix: string;
  /** The directory the file names are relative to. */
  root: string;
  /** Every served file, `/`-separated and relative to `root`. */
  files: () => string[];
  contentType: (file: string) => string;
}

export function staticAssets(spec: StaticAssets): Plugin {
  return {
    name: spec.name,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(spec.prefix)) return next();
        const rel = decodeURIComponent(url.slice(spec.prefix.length));
        if (!spec.files().includes(rel)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", spec.contentType(rel));
        res.end(readFileSync(join(spec.root, rel)));
      });
    },
    generateBundle() {
      for (const rel of spec.files()) {
        this.emitFile({
          type: "asset",
          fileName: `${spec.prefix.slice(1)}${rel}`,
          source: readFileSync(join(spec.root, rel)),
        });
      }
    },
  };
}
