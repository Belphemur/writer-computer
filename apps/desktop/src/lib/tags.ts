// The body `#tag` recogniser: the TypeScript twin of the index's `scan_tags`, `normalize_tag` and
// `is_tag_char` (`src-tauri/src/index/markdown.rs`), so the editor's pill and the properties
// panel's body tags are exactly what the index will store. `shared/tag-vectors.json` pins both
// sides (SPECs/tags-spec.md, "Inline tags in the UI"). Pure text: no CodeMirror, no React.
//
// A tag is `#` plus letters, digits, `_`, `-` or `/`, not all ASCII digits, preceded by the line
// start, whitespace or one of `([{,;:"'`. It is never found in a fenced code block, an inline code
// span, a wiki link, a markdown link destination or a URL; those are blanked with spaces first
// (offsets stay put), as the index does. Front matter is not part of the text given here (the
// store keeps it apart).

const TAG_CHAR = /^[\p{Alphabetic}\p{N}_\-/]$/u;
const TAG_PRECEDING = `([{,;:"'`;

export function isTagChar(c: string): boolean {
  return TAG_CHAR.test(c);
}

/** Lowercase and validate a raw tag (a leading `#` is optional): `null` if it is not a tag. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, "").replace(/\/+$/, "");
  if (t === "" || t.startsWith("/") || t.includes("//")) return null;
  const chars = [...t];
  if (!chars.every(isTagChar) || !chars.some((c) => c < "0" || c > "9")) return null;
  return t.toLowerCase();
}

/** One tag in a line: the `#` at `from`, the end of the tag text at `to` (a trailing `/` is not
 *  part of it), and its normalised name. */
export interface LineTag {
  from: number;
  to: number;
  tag: string;
}

type Range = readonly [number, number];

function maskRanges(line: string, ranges: readonly Range[]): string {
  let out = line;
  for (const [s, e] of ranges) {
    out = out.slice(0, s) + " ".repeat(Math.min(e, line.length) - s) + out.slice(e);
  }
  return out;
}

/** Inline code spans (same-line backtick runs of equal length) blanked with spaces. */
function maskCodeSpans(line: string): string {
  if (!line.includes("`")) return line;
  const ranges: Range[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const start = i;
    while (i < line.length && line[i] === "`") i++;
    const run = i - start;
    let j = i;
    let closed: number | null = null;
    while (j < line.length) {
      if (line[j] === "`") {
        const s = j;
        while (j < line.length && line[j] === "`") j++;
        if (j - s === run) {
          closed = j;
          break;
        }
      } else j++;
    }
    if (closed !== null) {
      ranges.push([start, closed]);
      i = closed;
    }
  }
  return maskRanges(line, ranges);
}

/** Bare URLs (from their scheme to the next whitespace) blanked, so `https://x#frag` has no tag. */
function maskUrls(line: string): string {
  const ranges: Range[] = [];
  let from = 0;
  for (;;) {
    const at = line.indexOf("://", from);
    if (at < 0) break;
    let start = at;
    while (start > 0 && /[A-Za-z0-9+.-]/.test(line[start - 1]!)) start--;
    const ws = line.slice(at).search(/\s/);
    const end = ws < 0 ? line.length : at + ws;
    ranges.push([start, end]);
    from = Math.max(end, at + 3);
  }
  return maskRanges(line, ranges);
}

function hasScheme(s: string): boolean {
  const colon = s.indexOf(":");
  if (colon < 0) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]+$/.test(s.slice(0, colon));
}

function findMatchingBracket(text: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return null;
}

/** `dest` or `<dest>` with an optional title, up to the closing `)`: the destination and the
 *  index after `)`, or `null` when this is not a link destination. */
function parseDestination(text: string, from: number): { dest: string; end: number } | null {
  let i = from;
  let dest: string;
  if (text[i] === "<") {
    const close = text.indexOf(">", i + 1);
    if (close < 0) return null;
    dest = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/[ \t\n\f\r]/.test(c)) break;
      i++;
    }
    if (i > text.length) return null;
    dest = text.slice(start, i);
  }
  const rest = text.slice(i);
  const close = rest.indexOf(")");
  if (close < 0) return null;
  const between = rest.slice(0, close).trim();
  const quote = between[0];
  const isTitle =
    between === "" ||
    ((quote === '"' || quote === "'") && between.length >= 2 && between.endsWith(quote));
  return isTitle ? { dest, end: i + close + 1 } : null;
}

/** A wiki link's inner text names something (`[[#]]` and `[[|x]]` do not). */
function wikiLinkNamesSomething(inner: string): boolean {
  const target = inner.replace(/\\\|/g, "|").split("|")[0]!;
  const hash = target.indexOf("#");
  const path = hash < 0 ? target : target.slice(0, hash);
  const sub = hash < 0 ? "" : target.slice(hash + 1);
  return path.trim() !== "" || sub.trim() !== "";
}

/** The spans a tag can never start in: wiki links and embeds, and the `(...)` of a markdown link
 *  to a note (the index's `scan_links`; a link with a URL scheme is a URL, `maskUrls` blanks it). */
function linkRanges(text: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "[") {
      i++;
      continue;
    }
    const embed = i > 0 && text[i - 1] === "!";
    const start = embed ? i - 1 : i;
    if (text[i + 1] === "[") {
      const rel = text.indexOf("]]", i + 2);
      if (rel >= 0) {
        const inner = text.slice(i + 2, rel);
        if (!inner.includes("[[")) {
          if (wikiLinkNamesSomething(inner)) out.push([start, rel + 2]);
          i = rel + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    const close = findMatchingBracket(text, i);
    if (close === null || text[close + 1] !== "(") {
      i++;
      continue;
    }
    if (text[i + 1] === "^") {
      i = close + 1;
      continue;
    }
    const parsed = parseDestination(text, close + 2);
    if (parsed) {
      const { dest, end } = parsed;
      if (dest !== "" && !hasScheme(dest) && !dest.startsWith("//")) out.push([close + 1, end]);
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** The tags of one line of body text, in order, with their offsets in the line. The line is
 *  scanned alone: whether it sits in a fenced block is the caller's to decide (`scanTags` tracks
 *  fences; the editor asks its syntax tree). */
export function scanLineTags(line: string): LineTag[] {
  if (!line.includes("#")) return [];
  const code = maskCodeSpans(line);
  const masked = maskUrls(maskRanges(code, linkRanges(code)));
  const out: LineTag[] = [];
  let prev: string | null = null;
  let i = 0;
  while (i < masked.length) {
    const c = masked[i]!;
    if (c === "#" && (prev === null || /\s/.test(prev) || TAG_PRECEDING.includes(prev))) {
      let len = 0;
      for (const ch of masked.slice(i + 1)) {
        if (!isTagChar(ch)) break;
        len += ch.length;
      }
      const body = masked.slice(i + 1, i + 1 + len);
      const tag = normalizeTag(body);
      if (tag) out.push({ from: i, to: i + 1 + body.replace(/\/+$/, "").length, tag });
      prev = body === "" ? "#" : [...body].pop()!;
      i += 1 + len;
      continue;
    }
    prev = c;
    i++;
  }
  return out;
}

function fenceOpen(line: string): { ch: string; len: number } | null {
  const t = line.trimStart();
  const ch = t[0];
  if (ch !== "`" && ch !== "~") return null;
  let len = 0;
  while (t[len] === ch) len++;
  if (len < 3) return null;
  if (ch === "`" && t.slice(len).includes("`")) return null; // a backtick fence's info has none
  return { ch, len };
}

function fenceCloses(line: string, ch: string, len: number): boolean {
  const t = line.trim();
  let run = 0;
  while (t[run] === ch) run++;
  return run >= len && t.slice(run).trim() === "";
}

/** The tags of a note body (front matter excluded), normalised, in order, duplicates kept: what
 *  the index's `scan_body` collects. */
export function scanTags(body: string): string[] {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      if (fenceCloses(line, fence.ch, fence.len)) fence = null;
      continue;
    }
    fence = fenceOpen(line);
    if (fence) continue;
    for (const t of scanLineTags(line)) out.push(t.tag);
  }
  return out;
}

/** `tags` without those in `written` (the front matter's, in any spelling) and without repeats,
 *  in order of first use. */
export function tagsNotIn(tags: readonly string[], written: readonly string[]): string[] {
  const skip = new Set(written.map((t) => normalizeTag(t)));
  const out: string[] = [];
  for (const tag of tags) {
    if (skip.has(tag)) continue;
    skip.add(tag);
    out.push(tag);
  }
  return out;
}
