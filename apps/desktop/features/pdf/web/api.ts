// The public entry of the PDF feature: what another feature may name. The agent composer counts a
// PDF's pages (the API reads at most 100 per request, and the chip shows the count) through the
// service `pdf.info` (`getService`, `@/lib/features/services`) and takes the TYPE from here with
// `import type` (erased: no runtime edge between the features). Nothing else of this folder is a
// contract.

/** The service id, one of the manifest's `provides`. */
export const PDF_INFO = "pdf.info";

/** Facts about a PDF, read with pdf.js (loaded on the first call). Each throws for bytes that are
 *  not a readable PDF. */
export interface PdfInfo {
  /** Pages of the PDF file at the absolute `path`. */
  pageCountOfPath(path: string): Promise<number>;
  /** Pages of a PDF held in memory (a paste). */
  pageCountOfBytes(bytes: Uint8Array): Promise<number>;
}
