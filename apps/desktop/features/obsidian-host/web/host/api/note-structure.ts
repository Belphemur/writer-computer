// Block structure of a note as Obsidian's metadata cache reports it: `sections` (one per
// top-level block: heading, paragraph, list, code, table, ...) and `listItems` (every bullet and
// task, with its parent line, task character and block id). Pure and line based: it is what
// plugins that build their own index from `metadataCache.getFileCache(file)` read (Dataview's
// importer takes tasks, lists and inline fields from these two arrays).
//
// Public shape only (obsidian.d.ts `SectionCache`, `ListItemCache`). Approximations are listed
// in README.md: no setext headings, no footnote definitions, lists inside block quotes are
// reported but their parent chain is per quote.
import type { Pos } from "./vault";

export interface SectionCache {
  id?: string;
  type: string;
  position: Pos;
}

export interface ListItemCache {
  id?: string;
  /** The character inside `[ ]` of a task (` ` when open), absent for a plain bullet. */
  task?: string;
  /** Line of the parent item, or the negated line where this item's list starts for a root item. */
  parent: number;
  position: Pos;
}

export interface NoteStructure {
  sections: SectionCache[];
  listItems: ListItemCache[];
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(\[(.)\](?:\s+|$))?/;
const FENCE = /^(\s*)(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>/;

function stripQuote(line: string): { text: string; cut: number } {
  let cut = 0;
  let text = line;
  for (;;) {
    const m = /^\s{0,3}>\s?/.exec(text);
    if (!m) return { text, cut };
    cut += m[0].length;
    text = text.slice(m[0].length);
  }
}

/**
 * `raw` is the whole file text; `bodyStartLine` is the first line after the frontmatter (the
 * frontmatter itself is reported as one `yaml` section when `yamlEndLine` is set).
 */
export function parseNoteStructure(
  raw: string,
  bodyStartLine: number,
  yamlEndLine: number | null,
): NoteStructure {
  const lines = raw.split("\n");
  const starts: number[] = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = off;
    off += lines[i].length + 1;
  }
  const pos = (startLine: number, endLine: number): Pos => ({
    start: { line: startLine, col: 0, offset: starts[startLine] },
    end: {
      line: endLine,
      col: lines[endLine].length,
      offset: starts[endLine] + lines[endLine].length,
    },
  });
  const sections: SectionCache[] = [];
  const listItems: ListItemCache[] = [];
  if (yamlEndLine !== null && yamlEndLine >= 0) {
    sections.push({ type: "yaml", position: pos(0, yamlEndLine) });
  }
  const blank = (i: number): boolean => lines[i].trim() === "";

  const addSection = (type: string, from: number, to: number): void => {
    const section: SectionCache = { type, position: pos(from, to) };
    const id = BLOCK_ID.exec(lines[to])?.[1];
    if (id && type !== "list") section.id = id;
    sections.push(section);
  };

  /** Items of the list (or quoted list) spanning `from..to`; `strip` removes quote markers. */
  const collectItems = (from: number, to: number, quoted: boolean): void => {
    const stack: { indent: number; line: number }[] = [];
    let listStart = -1;
    let i = from;
    while (i <= to) {
      const cut = quoted ? stripQuote(lines[i]).cut : 0;
      const text = lines[i].slice(cut);
      const m = LIST_ITEM.exec(text);
      if (!m) {
        i++;
        continue;
      }
      const indent = m[1].replace(/\t/g, "    ").length;
      if (listStart < 0 || (stack.length === 0 && blank(i - 1))) listStart = i;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].line : -listStart;
      // Continuation lines: deeper indent than the marker, not another item, not blank.
      let end = i;
      while (end + 1 <= to) {
        const next = lines[end + 1];
        const nextText = quoted ? stripQuote(next).text : next;
        if (nextText.trim() === "" || LIST_ITEM.test(nextText)) break;
        // Indented or lazy continuation of the item's text; a new block ends it.
        if (HEADING.test(nextText) || FENCE.test(nextText)) break;
        end++;
      }
      const item: ListItemCache = {
        parent,
        position: {
          start: { line: i, col: cut + m[1].length, offset: starts[i] + cut + m[1].length },
          end: {
            line: end,
            col: lines[end].length,
            offset: starts[end] + lines[end].length,
          },
        },
      };
      if (m[4] !== undefined) item.task = m[5];
      const id = BLOCK_ID.exec(lines[end])?.[1];
      if (id) item.id = id;
      listItems.push(item);
      stack.push({ indent, line: i });
      i++;
    }
  };

  let i = bodyStartLine;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(i)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      let j = i + 1;
      while (j < lines.length) {
        const close = FENCE.exec(lines[j]);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length) break;
        j++;
      }
      const to = Math.min(j, lines.length - 1);
      addSection("code", i, to);
      i = to + 1;
      continue;
    }
    if (HEADING.test(line)) {
      addSection("heading", i, i);
      i++;
      continue;
    }
    if (line.trim() === "$$" || /^\s*\$\$.+\$\$\s*$/.test(line)) {
      let j = i;
      if (line.trim() === "$$") {
        j = i + 1;
        while (j < lines.length - 1 && lines[j].trim() !== "$$") j++;
      }
      addSection("math", i, Math.min(j, lines.length - 1));
      i = Math.min(j, lines.length - 1) + 1;
      continue;
    }
    if (THEMATIC.test(line) && !LIST_ITEM.test(line.replace(/^\s+/, ""))) {
      addSection("thematicBreak", i, i);
      i++;
      continue;
    }
    if (line.trimStart().startsWith("<!--")) {
      let j = i;
      while (j < lines.length - 1 && !lines[j].includes("-->")) j++;
      addSection("comment", i, j);
      i = j + 1;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i;
      while (j + 1 < lines.length && !blank(j + 1)) {
        // Lazy continuation is allowed until a blank line or a new block start.
        if (!QUOTE.test(lines[j + 1]) && (HEADING.test(lines[j + 1]) || FENCE.test(lines[j + 1])))
          break;
        j++;
      }
      const callout = /^\s*\[![^\]]+\]/.test(stripQuote(line).text);
      addSection(callout ? "callout" : "blockquote", i, j);
      collectItems(i, j, true);
      i = j + 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      let j = i;
      while (j + 1 < lines.length) {
        const next = lines[j + 1];
        if (blank(j + 1)) {
          // A blank line ends the list unless the next non-blank line continues it.
          let k = j + 2;
          while (k < lines.length && blank(k)) k++;
          if (k < lines.length && (LIST_ITEM.test(lines[k]) || /^(\t| {2,})\S/.test(lines[k]))) {
            j = k - 1;
            continue;
          }
          break;
        }
        if (HEADING.test(next) || FENCE.test(next) || QUOTE.test(next)) break;
        j++;
      }
      addSection("list", i, j);
      collectItems(i, j, false);
      i = j + 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      let j = i + 1;
      while (j + 1 < lines.length && !blank(j + 1) && lines[j + 1].includes("|")) j++;
      addSection("table", i, j);
      i = j + 1;
      continue;
    }
    if (/^\s*<[A-Za-z!/]/.test(line)) {
      let j = i;
      while (j + 1 < lines.length && !blank(j + 1)) j++;
      addSection("html", i, j);
      i = j + 1;
      continue;
    }
    // Paragraph: until a blank line or a block that interrupts one.
    let j = i;
    while (j + 1 < lines.length && !blank(j + 1)) {
      const next = lines[j + 1];
      if (HEADING.test(next) || FENCE.test(next) || QUOTE.test(next) || LIST_ITEM.test(next)) break;
      j++;
    }
    addSection("paragraph", i, j);
    i = j + 1;
  }
  return { sections, listItems };
}
