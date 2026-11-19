// The `pdf.info` service (`../api.ts`): facts about a PDF for other features. Lazy: pdf.js loads on
// the first call, and the document is destroyed right after the answer.
import { readDocument } from "@/lib/tauri";
import { openDocument } from "./pdf-lib";

export async function pageCountOfBytes(bytes: Uint8Array): Promise<number> {
  const doc = await openDocument(bytes.slice());
  try {
    return doc.numPages;
  } finally {
    doc.destroy();
  }
}

export async function pageCountOfPath(path: string): Promise<number> {
  return pageCountOfBytes(await readDocument(path));
}
