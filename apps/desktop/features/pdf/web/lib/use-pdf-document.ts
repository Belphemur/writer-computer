import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import { readDocument } from "@/lib/tauri";
import type { PdfDocument } from "./pdf-lib";

export type PdfSource =
  | { status: "loading" }
  | { status: "ready"; doc: PdfDocument }
  | { status: "error"; reason: "password" | "unreadable" };

/**
 * Loads the PDF at the absolute `path` for a view: the bytes from the Rust command, then pdf.js
 * (a dynamic import, so nothing of it loads until a PDF is shown). The document is destroyed when
 * the path changes or the view goes away. `version` reloads (the file changed on disk). Nothing
 * about the file is logged: not its path, not its text.
 */
export function usePdfDocument(path: string, version = 0): PdfSource {
  const [source, setSource] = useState<PdfSource>({ status: "loading" });
  useEffect(() => {
    let live = true;
    let opened: PdfDocument | null = null;
    setSource({ status: "loading" });
    (async () => {
      const [bytes, lib] = await Promise.all([readDocument(path), import("./pdf-lib")]);
      const doc = await lib.openDocument(bytes);
      if (!live) return doc.destroy();
      opened = doc;
      setSource({ status: "ready", doc });
    })().catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "Error";
      logger.warn("pdf", `a PDF could not be opened (${name})`);
      if (live) {
        setSource({
          status: "error",
          reason: name === "PasswordException" ? "password" : "unreadable",
        });
      }
    });
    return () => {
      live = false;
      opened?.destroy();
    };
  }, [path, version]);
  return source;
}
