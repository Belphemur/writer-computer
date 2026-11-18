/**
 * The Markdown of a text selection inside the transcript. Every rendered message (`data-md-host`)
 * knows its source (`setMarkdownSource`) and stamps each top-level block with its range in it
 * (`renderAgentMarkdown`). A whole message gives its exact source; whole blocks give their source
 * slice; a partial block is aligned character by character between its rendered text and its
 * source, then widened to whole links, code spans and emphasis marks it cuts into. A code block
 * or table cut in the middle gives the selected text itself. There is no HTML to Markdown
 * converter: the source is always at hand.
 */
import { wikiLinkScanner } from "@/lib/wiki-links";
import { MD_RANGE_ATTR, parseMdRange } from "./markdown";

const HOST_ATTR = "data-md-host";
/** Never part of a copy (the code block's copy button). */
export const MD_SKIP_ATTR = "data-md-skip";
/** The source text a rendered element stands for (a pill shows a label, the text is its token). */
export const MD_RAW_ATTR = "data-md-raw";

const sources = new WeakMap<Element, string>();

/** Marks `host` as a rendered message whose Markdown is `source`. */
export function setMarkdownSource(host: Element, source: string): void {
  host.setAttribute(HOST_ATTR, "");
  sources.set(host, source);
}

/** The text a node contributes to the alignment: what is drawn, with pills as their token. */
function mdText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node instanceof Element) {
    if (node.hasAttribute(MD_SKIP_ATTR)) return "";
    const raw = node.getAttribute(MD_RAW_ATTR);
    if (raw !== null) return raw;
    if (node.tagName === "BR") return "\n";
  }
  return [...node.childNodes].map(mdText).join("");
}

/** The part of `range` inside `node`, or null when nothing of it is. */
function clip(range: Range, node: Node): Range | null {
  if (!range.intersectsNode(node)) return null;
  const inner = document.createRange();
  inner.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) {
    inner.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) {
    inner.setEnd(range.endContainer, range.endOffset);
  }
  return inner;
}

const isSpace = (c: string) => /\s/.test(c);
const same = (a: string, b: string) => a === b || (isSpace(a) && isSpace(b));

/** Source indexes `[a, b)` of the rendered characters `[from, to)`: each rendered character is the
 *  next equal character of the source (markup characters are skipped over). */
function align(rendered: string, from: number, to: number, src: string): [number, number] | null {
  let j = 0;
  let a = -1;
  for (let i = 0; i < to; i++) {
    while (j < src.length && !same(src[j]!, rendered[i]!)) j++;
    if (j >= src.length) return null;
    if (i === from) a = j;
    j++;
  }
  return a < 0 ? null : [a, j];
}

const LINK = /(?<!!)\[[^\]\n]*\]\([^)\n]*\)/g;
const CODE = /`[^`\n]+`/g;

/** Widens `[a, b)` over a link, wiki link or code span it ends inside of, and over emphasis marks
 *  that wrap it on both sides (`**bold**`). */
function widen(src: string, a: number, b: number, lo: number, hi: number): [number, number] {
  const text = src.slice(lo, hi);
  for (const re of [wikiLinkScanner(), LINK, CODE]) {
    for (const m of text.matchAll(re)) {
      const start = lo + m.index;
      const end = start + m[0].length;
      if (start < a && a < end) a = start;
      if (start < b && b < end) b = end;
    }
  }
  while (a > lo && b < hi && "*_~".includes(src[a - 1]!) && src[a - 1] === src[b]) {
    a--;
    b++;
  }
  // a mark opened inside the slice is closed just after it, or the reverse
  const odd = (mark: string) => (src.slice(a, b).split(mark).length - 1) % 2 === 1;
  const after = /^(\*{1,3}|_{1,3}|~{1,2})/.exec(src.slice(b, hi))?.[1];
  if (after && odd(after)) b += after.length;
  const before = /(\*{1,3}|_{1,3}|~{1,2})$/.exec(src.slice(lo, a))?.[1];
  if (before && odd(before)) a -= before.length;
  return [a, b];
}

type Piece = { a: number; b: number; whole: [number, number]; plain: string | null };

function blockPiece(block: Element, range: Range, source: string): Piece | null {
  const part = clip(range, block);
  if (!part) return null;
  const selected = mdText(part.cloneContents());
  if (!selected) return null;
  const [s, e] = parseMdRange(block.getAttribute(MD_RANGE_ATTR)!);
  const whole: [number, number] = [s, e];
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(part.startContainer, part.startOffset);
  const from = mdText(before.cloneContents()).length;
  const to = from + selected.length;
  const full = mdText(block).length;
  if (from === 0 && to >= full) return { a: s, b: e, whole, plain: null };
  if (block.tagName === "PRE" || block.tagName === "TABLE") {
    return { a: s, b: e, whole, plain: selected };
  }
  const found = align(mdText(block), from, to, source.slice(s, e));
  if (!found) return { a: s, b: e, whole, plain: selected };
  const [a, b] = widen(source, s + found[0], s + found[1], s, e);
  return { a: from === 0 ? s : a, b: to >= full ? e : b, whole, plain: null };
}

function hostMarkdown(host: Element, range: Range): string | null {
  const source = sources.get(host);
  if (source === undefined) return null;
  const part = clip(range, host);
  if (!part) return null;
  const all = document.createRange();
  all.selectNodeContents(host);
  if (
    range.compareBoundaryPoints(Range.START_TO_START, all) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, all) >= 0
  ) {
    return source;
  }
  const blocks = [...host.children].filter((c) => c.hasAttribute(MD_RANGE_ATTR));
  if (blocks.length === 0) return mdText(part.cloneContents()) || null;
  const pieces = blocks.flatMap((b) => blockPiece(b, range, source) ?? []);
  if (pieces.length === 0) return null;
  if (pieces.length === 1 && pieces[0]!.plain !== null) return pieces[0]!.plain;
  // across blocks a code block or table is taken whole
  const parts = pieces.map((p) => (p.plain === null ? p : { ...p, a: p.whole[0], b: p.whole[1] }));
  return source.slice(parts[0]!.a, parts[parts.length - 1]!.b);
}

const INTERACTIVE = "button, input, textarea, select, [contenteditable]";

/** The Markdown of the selection when it lies inside `root` (both ends, not in a button or an
 *  input), else null. Messages it crosses are joined by a blank line. */
export function selectionMarkdown(root: Element, selection: Selection | null): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  for (const node of [range.startContainer, range.endContainer]) {
    const el = node instanceof Element ? node : node.parentElement;
    if (!root.contains(node) || el?.closest(INTERACTIVE)) return null;
  }
  const parts = [...root.querySelectorAll(`[${HOST_ATTR}]`)].flatMap(
    (host) => hostMarkdown(host, range) ?? [],
  );
  return parts.length > 0 ? parts.join("\n\n") : null;
}
