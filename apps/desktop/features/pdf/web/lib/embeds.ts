// What a PDF embedded in a note is: `![[paper.pdf]]`, `![[paper.pdf#page=3]]` or
// `![[paper.pdf#page=3&height=600]]` alone on a line (an alias after `|` is ignored). The editor
// widget (`../embed-decorations.ts`) finds the lines; this decides what they mean, so the grammar
// lives in one place. The fragment is `lib/pdf-anchor.ts` (Obsidian's syntax).
import { isDocumentName } from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import { parsePdfAnchor } from "@/lib/pdf-anchor";
import { isWikiLink, parseWikiLink, wikiLinkInner } from "@/lib/wiki-links";

/** The embed's default height in pixels. */
export const PDF_EMBED_DEFAULT_HEIGHT = 480;

export interface PdfEmbed {
  /** The link path as written (a name, or a vault path). */
  target: string;
  /** 1-based page to open at. */
  page: number;
  /** Height in pixels. */
  height: number;
}

export function parsePdfEmbedTarget(inner: string): PdfEmbed | null {
  const link = parseWikiLink(inner);
  if (!link.path || !isDocumentName(getFileName(link.path))) return null;
  const anchor = parsePdfAnchor(link.fragment);
  return {
    target: link.path,
    page: anchor.page ?? 1,
    height: anchor.height ?? PDF_EMBED_DEFAULT_HEIGHT,
  };
}

/** A whole line that is exactly one `![[...]]` embed of a PDF (surrounding blanks allowed). */
export function parsePdfEmbedLine(text: string): PdfEmbed | null {
  const line = text.trim();
  if (!line.startsWith("!") || !isWikiLink(line.slice(1))) return null;
  return parsePdfEmbedTarget(wikiLinkInner(line.slice(1)));
}
