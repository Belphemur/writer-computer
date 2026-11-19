// What the `#fragment` of a link to a PDF asks for, Obsidian's syntax: `#page=3`, `#height=600`
// (an embed's height in pixels), joined by `&`: `#page=3&height=600`. Unknown keys (`selection`,
// `color`) are ignored. One parser for link activation (`lib/wiki-links.ts`), the PDF tab and the
// PDF embed, so the grammar lives once.

export interface PdfAnchor {
  /** 1-based page, or null. */
  page: number | null;
  /** An embed's height in pixels, or null for the default. */
  height: number | null;
}

export const PDF_EMBED_MIN_HEIGHT = 120;
export const PDF_EMBED_MAX_HEIGHT = 2000;

const positiveInt = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

export function parsePdfAnchor(fragment: string | null | undefined): PdfAnchor {
  const out: PdfAnchor = { page: null, height: null };
  if (!fragment) return out;
  for (const part of fragment.replace(/^#/, "").split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === "page") out.page = positiveInt(value);
    else if (key === "height") {
      const h = positiveInt(value);
      out.height =
        h === null ? null : Math.min(PDF_EMBED_MAX_HEIGHT, Math.max(PDF_EMBED_MIN_HEIGHT, h));
    }
  }
  return out;
}
