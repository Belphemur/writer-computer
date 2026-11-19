// What a drawing embedded in a note is: `![[Arch.excalidraw.md]]` or `![[Arch.excalidraw]]` alone
// on a line (an alias after `|` is ignored). The editor widget (`../embed-decorations.ts`) finds
// the lines; this decides what they mean, so the grammar lives in one place.
import { isDrawingPath } from "@/lib/paths";
import { isWikiLink, parseWikiLink, wikiLinkInner } from "@/lib/wiki-links";

export interface DrawingEmbed {
  /** The link path as written (a name, or a vault path). */
  target: string;
}

export function parseDrawingEmbedTarget(inner: string): DrawingEmbed | null {
  const link = parseWikiLink(inner);
  return link.path && isDrawingPath(link.path) ? { target: link.path } : null;
}

/** A whole line that is exactly one `![[...]]` embed of a drawing (surrounding blanks allowed). */
export function parseDrawingEmbedLine(text: string): DrawingEmbed | null {
  const line = text.trim();
  if (!line.startsWith("!") || !isWikiLink(line.slice(1))) return null;
  return parseDrawingEmbedTarget(wikiLinkInner(line.slice(1)));
}
