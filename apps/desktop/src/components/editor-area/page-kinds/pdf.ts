import { isDocumentName } from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * A PDF file in the read-only PDF reader. Claimed by `forPath` for the document extensions
 * (`shared/attachments.json`), whatever `files.show-pdfs` says: that setting only decides whether
 * the sidebar lists PDFs. The path is not a text document (`loadsDocument: false`): the view reads
 * the bytes itself (`read_document`). The view is the `pdf` feature's (`page-view:pdf`); off, a PDF
 * tab (opened or restored) shows the "turned off" page with Open in default app. A `#page=N` link
 * parks `page=N` as the path's pending anchor (`lib/pending-anchor.ts`).
 */
export type PdfLocation = { kind: "pdf"; path: string };

export const pdfKind = definePageKind<"pdf", PdfLocation>({
  kind: "pdf",
  title: (l) => getFileName(l.path),
  description: "PDF",
  keepAlive: true,
  supportsFileContextMenu: true,
  loadsDocument: false,
  feature: "pdf",
  claimsWhenOff: true, // not text: off, the tab shows the off page rather than a text read
  forPath: (path) => (isDocumentName(getFileName(path)) ? { kind: "pdf", path } : null),
  fromPayload: (data) => (typeof data.path === "string" ? { kind: "pdf", path: data.path } : null),
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
