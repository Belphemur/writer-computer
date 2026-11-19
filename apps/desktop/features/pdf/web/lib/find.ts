// Find in a PDF, pure (no DOM, no pdf.js): the text of a page as a string with a map back to its
// text items, matches of a query in that string, and which characters of which item each match
// covers (so the text layer can mark them). Spec: SPECs/pdf-spec.md ("Find").

/** What pdf.js's `getTextContent` gives per run of text: its string and whether a line ends there. */
export interface TextItem {
  str: string;
  hasEOL: boolean;
}

export interface PageText {
  /** The items' text joined, with a space where a line ends. */
  text: string;
  /** For each character of `text`: the index of its item, or -1 for an inserted space. */
  owner: number[];
  /** For each character of `text`: its offset inside its item. */
  offset: number[];
}

export function pageText(items: readonly TextItem[]): PageText {
  let text = "";
  const owner: number[] = [];
  const offset: number[] = [];
  items.forEach((item, i) => {
    for (let k = 0; k < item.str.length; k++) {
      owner.push(i);
      offset.push(k);
    }
    text += item.str;
    if (item.hasEOL && !/\s$/.test(item.str)) {
      text += " ";
      owner.push(-1);
      offset.push(0);
    }
  });
  return { text, owner, offset };
}

export interface Match {
  /** 1-based page. */
  page: number;
  /** The characters it covers, per text item of that page. */
  spans: { item: number; from: number; to: number }[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regular expression of `query`: case-blind, any run of white space in the query matches any
 *  run of white space (a line break included) in the text. Null for a blank query. */
export function queryPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "giu");
}

/** Every match of `pattern` in a page, in reading order. */
export function matchesInPage(page: number, text: PageText, pattern: RegExp): Match[] {
  const out: Match[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text.text); m; m = pattern.exec(text.text)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const spans: Match["spans"] = [];
    for (let c = m.index; c < m.index + m[0].length; c++) {
      const item = text.owner[c]!;
      if (item < 0) continue;
      const at = text.offset[c]!;
      const last = spans[spans.length - 1];
      if (last && last.item === item && last.to === at) last.to = at + 1;
      else spans.push({ item, from: at, to: at + 1 });
    }
    if (spans.length > 0) out.push({ page, spans });
  }
  return out;
}

/** The next index in a ring of `count` (`direction` 1 forward, -1 back); -1 when there is none. */
export function stepIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
