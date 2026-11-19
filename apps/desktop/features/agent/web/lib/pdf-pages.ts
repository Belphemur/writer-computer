// A PDF's page count for the composer (the chip shows it, and the API reads at most 100 pages).
// pdf.js is the PDF feature's: it is reached through the `pdf.info` service, found by a registry
// lookup and typed with `import type` only (no edge between the features). While that feature is
// off there is no service and no count: the chip shows the name alone and nothing is refused.
import { getService } from "@/lib/features/services";
import type { PdfInfo } from "@features/pdf/web/api";

const PDF_INFO = "pdf.info";

export const pdfInfo = (): PdfInfo | undefined => getService<PdfInfo>(PDF_INFO);

const absolute = (root: string, rel: string) => `${root.replace(/\/$/, "")}/${rel}`;

/** The counter `attachChatFiles` takes (`ChatFileIo.pdfPages`), or undefined while the PDF feature
 *  is off. `root` resolves a vault-relative path. */
export function pdfPagesIo(root: string | null) {
  const info = pdfInfo();
  if (!info) return undefined;
  return {
    ofBytes: (bytes: Uint8Array) => info.pageCountOfBytes(bytes),
    ofPath: (path: string, kind: "vault" | "path") =>
      info.pageCountOfPath(kind === "vault" && root ? absolute(root, path) : path),
  };
}

/** Pages per absolute path, counted once (a chip re-renders often). */
const counted = new Map<string, Promise<number | null>>();

/** The page count of the vault PDF at `rel`, or null without the service or a readable PDF. */
export function pageCountOf(root: string | null, rel: string): Promise<number | null> {
  const info = pdfInfo();
  if (!info || !root) return Promise.resolve(null);
  const path = absolute(root, rel);
  let p = counted.get(path);
  if (!p) {
    p = info.pageCountOfPath(path).catch(() => null);
    counted.set(path, p);
  }
  return p;
}
