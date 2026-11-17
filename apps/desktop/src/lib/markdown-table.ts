// Pure GFM pipe-table model: find a table around a line, parse it into cells with alignment,
// format it back with aligned pipes, and edit it (rows, columns, sort, align, transpose).
// No CodeMirror and no DOM here (except `rowsFromHtmlTable`); the editor extension in
// `components/editor-area/table-editing.ts` turns these results into transactions.
//
// Cell text is kept as raw markdown source, trimmed, with `\|` escapes intact, so a
// parse -> format round trip never changes what a cell means. Only unescaped pipes split cells
// (GFM rule: a pipe inside inline code or a wiki link also splits unless it is written `\|`).

export type Align = "left" | "center" | "right" | null;

export interface MarkdownTable {
  header: string[];
  align: Align[];
  rows: string[][];
  /** Prefix of the first line (list marker or quote markers kept as written). */
  firstPrefix: string;
  /** Prefix of every other line (indent and quote markers). */
  prefix: string;
}

/** `row` is -1 for the header, `DELIMITER_ROW` for the `| --- |` line, else a body row index. */
export const HEADER_ROW = -1;
export const DELIMITER_ROW = -2;

export interface TableCursor {
  row: number;
  col: number;
}

export interface CellSpan {
  /** Trimmed content range within the scanned string (an empty cell gets a collapsed range). */
  from: number;
  to: number;
  text: string;
}

export const MIN_COLUMN_WIDTH = 3;

// ---------------------------------------------------------------------------
// Display width
// ---------------------------------------------------------------------------

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function isWideCodePoint(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK_ONLY = new RegExp("^(?:\\p{M}|[\\u200b-\\u200d]|\\ufe0e|\\ufe0f)+$", "u");
const REGIONAL_INDICATOR = /^[\u{1f1e6}-\u{1f1ff}]/u;

function graphemeWidth(g: string): number {
  if (MARK_ONLY.test(g)) return 0;
  if (REGIONAL_INDICATOR.test(g)) return 2;
  if (PICTOGRAPHIC.test(g) && (EMOJI_PRESENTATION.test(g) || g.includes("️"))) return 2;
  const cp = g.codePointAt(0) ?? 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

// `Intl.Segmenter` is missing from the project's TS lib; it exists in every supported webview.
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
const SegmenterCtor = (
  Intl as unknown as {
    Segmenter?: new (locale?: string, o?: { granularity: "grapheme" }) => GraphemeSegmenter;
  }
).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : null;

/** Columns a string occupies in a monospace font: CJK and emoji count 2, combining marks 0. */
export function displayWidth(text: string): number {
  // Fast path: printable ASCII.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  } else {
    for (const ch of text) width += graphemeWidth(ch);
  }
  return width;
}

// ---------------------------------------------------------------------------
// Scanning lines
// ---------------------------------------------------------------------------

const PREFIX_PLAIN = /^(?:[ \t]*>)*[ \t]*/;
const PREFIX_LIST = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;

/** Indent and quote markers (and, if `allowMarker`, one list marker) that precede a row. */
export function splitPrefix(line: string, allowMarker = false): string {
  return (allowMarker ? PREFIX_LIST : PREFIX_PLAIN).exec(line)?.[0] ?? "";
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * Splits a row (already without its prefix) into cells, with offsets into `s`. Leading and
 * trailing pipes are optional; only unescaped pipes separate cells.
 */
export function scanRow(s: string): CellSpan[] {
  let start = 0;
  while (start < s.length && (s[start] === " " || s[start] === "\t")) start++;
  let end = s.length;
  while (end > start && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
  if (s[start] === "|") start++;
  if (end > start && s[end - 1] === "|" && !isEscapedAt(s, end - 1)) end--;

  const cells: CellSpan[] = [];
  let segStart = start;
  const push = (segEnd: number) => {
    let from = segStart;
    let to = segEnd;
    while (from < to && (s[from] === " " || s[from] === "\t")) from++;
    while (to > from && (s[to - 1] === " " || s[to - 1] === "\t")) to--;
    if (from === to) {
      // An empty cell: park the caret one space in, or in the middle of a wider gap.
      const mid = segStart + Math.min(1, segEnd - segStart);
      from = mid;
      to = mid;
    }
    cells.push({ from, to, text: s.slice(from, to) });
  };
  for (let i = start; i < end; i++) {
    if (s[i] === "|" && !isEscapedAt(s, i)) {
      push(i);
      segStart = i + 1;
    }
  }
  push(end);
  return cells;
}

const DELIMITER_CELL = /^:?-+:?$/;

function delimiterCells(s: string): CellSpan[] | null {
  if (!s.includes("-") || !/^[\s|:-]+$/.test(s)) return null;
  const cells = scanRow(s);
  return cells.every((c) => DELIMITER_CELL.test(c.text)) ? cells : null;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

// ---------------------------------------------------------------------------
// Finding a table
// ---------------------------------------------------------------------------

export interface TableBounds {
  /** Inclusive line indexes. */
  startLine: number;
  endLine: number;
}

function hasPipe(line: string, prefixLen: number): boolean {
  const body = line.slice(prefixLen);
  return body.trim() !== "" && body.includes("|");
}

/**
 * The table that contains line `line`, as line indexes, or null. A table is a header row, a
 * delimiter row with the same number of cells, and the contiguous pipe lines after it.
 */
export function findTableBounds(
  lineAt: (index: number) => string,
  lineCount: number,
  line: number,
): TableBounds | null {
  const rowLike = (i: number) => hasPipe(lineAt(i), splitPrefix(lineAt(i)).length);
  if (line < 0 || line >= lineCount || !rowLike(line)) return null;
  let a = line;
  while (a > 0 && rowLike(a - 1)) a--;
  let b = line;
  while (b + 1 < lineCount && rowLike(b + 1)) b++;

  for (let d = a + 1; d <= b; d++) {
    const delimText = lineAt(d).slice(splitPrefix(lineAt(d)).length);
    const delim = delimiterCells(delimText);
    if (!delim) continue;
    const headerLine = lineAt(d - 1);
    const counts = new Set([
      scanRow(headerLine.slice(splitPrefix(headerLine).length)).length,
      scanRow(headerLine.slice(splitPrefix(headerLine, true).length)).length,
    ]);
    if (!counts.has(delim.length)) continue;
    // The first valid header + delimiter pair opens the table; a caret above it is not in it.
    return line >= d - 1 ? { startLine: d - 1, endLine: b } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse / format
// ---------------------------------------------------------------------------

function padRow(cells: string[], n: number): string[] {
  const out = cells.slice();
  while (out.length < n) out.push("");
  return out;
}

/** Parses the lines of one table (header, delimiter, rows) or returns null. */
export function parseTable(lines: readonly string[]): MarkdownTable | null {
  if (lines.length < 2) return null;
  const prefix = splitPrefix(lines[1]);
  let firstPrefix = splitPrefix(lines[0], true);
  if (firstPrefix.length !== prefix.length) firstPrefix = splitPrefix(lines[0]);

  const delim = delimiterCells(lines[1].slice(prefix.length));
  if (!delim) return null;
  const header = scanRow(lines[0].slice(firstPrefix.length)).map((c) => c.text);
  if (header.length !== delim.length) return null;

  const body = lines
    .slice(2)
    .map((l) => scanRow(l.slice(splitPrefix(l).length)).map((c) => c.text));
  const n = Math.max(header.length, ...body.map((r) => r.length));
  return {
    header: padRow(header, n),
    align: padRow(
      delim.map((c) => alignOf(c.text) as string),
      n,
    ).map((a) => (a === "" ? null : (a as Align))),
    rows: body.map((r) => padRow(r, n)),
    firstPrefix,
    prefix,
  };
}

/**
 * Turns plain pipe lines with no delimiter row into a table (the first line becomes the header).
 * Returns null for fewer than one line or when any line has no pipe.
 */
export function parseLooseTable(lines: readonly string[]): MarkdownTable | null {
  const real = lines.filter((l) => l.trim() !== "");
  if (real.length === 0 || real.some((l) => !l.includes("|"))) return null;
  const prefix = splitPrefix(real[0]);
  const rows = real.map((l) => scanRow(l.slice(splitPrefix(l).length)).map((c) => c.text));
  const n = Math.max(...rows.map((r) => r.length));
  return {
    header: padRow(rows[0], n),
    align: Array.from<Align>({ length: n }).fill(null),
    rows: rows.slice(1).map((r) => padRow(r, n)),
    firstPrefix: prefix,
    prefix,
  };
}

export function columnCount(t: MarkdownTable): number {
  return t.header.length;
}

export function columnWidths(t: MarkdownTable): number[] {
  return t.header.map((h, c) => {
    let w = Math.max(MIN_COLUMN_WIDTH, displayWidth(h));
    for (const r of t.rows) w = Math.max(w, displayWidth(r[c] ?? ""));
    return w;
  });
}

function padCell(text: string, width: number, align: Align): { left: number; right: number } {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === "right") return { left: gap, right: 0 };
  if (align === "center") return { left: Math.floor(gap / 2), right: gap - Math.floor(gap / 2) };
  return { left: 0, right: gap };
}

function delimiterText(width: number, align: Align): string {
  if (align === "left") return `:${"-".repeat(width - 1)}`;
  if (align === "right") return `${"-".repeat(width - 1)}:`;
  if (align === "center") return `:${"-".repeat(width - 2)}:`;
  return "-".repeat(width);
}

export interface TableLayout {
  lines: string[];
  /** Range of a cell's content in `lines.join("\n")`. `row` as in `TableCursor`. */
  cellRange(row: number, col: number): { from: number; to: number };
}

/** Formats a table into aligned lines and exposes where each cell's content sits. */
export function layoutTable(t: MarkdownTable): TableLayout {
  const widths = columnWidths(t);
  const lines: string[] = [];
  const contentStarts: number[][] = []; // per line, per col: offset in that line

  const renderRow = (cells: string[], prefix: string): string => {
    const starts: number[] = [];
    let out = `${prefix}|`;
    for (let c = 0; c < widths.length; c++) {
      const text = cells[c] ?? "";
      const { left, right } = padCell(text, widths[c], t.align[c]);
      out += " ";
      starts.push(out.length + left);
      out += `${" ".repeat(left)}${text}${" ".repeat(right)} |`;
    }
    contentStarts.push(starts);
    return out;
  };

  lines.push(renderRow(t.header, t.firstPrefix));
  const delim = widths.map((w, c) => delimiterText(w, t.align[c]));
  lines.push(`${t.prefix}| ${delim.join(" | ")} |`);
  contentStarts.push(delim.map(() => 0));
  for (const r of t.rows) lines.push(renderRow(r, t.prefix));

  const lineOffsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineOffsets.push(acc);
    acc += l.length + 1;
  }
  return {
    lines,
    cellRange(row, col) {
      const lineIndex = row === HEADER_ROW ? 0 : row === DELIMITER_ROW ? 1 : row + 2;
      const text = row === HEADER_ROW ? t.header[col] : (t.rows[row]?.[col] ?? "");
      const start = lineOffsets[lineIndex] + (contentStarts[lineIndex]?.[col] ?? 0);
      return { from: start, to: start + (row === DELIMITER_ROW ? 0 : text.length) };
    },
  };
}

export function formatTable(t: MarkdownTable): string[] {
  return layoutTable(t).lines;
}

// ---------------------------------------------------------------------------
// Cells and cursors
// ---------------------------------------------------------------------------

/** Escapes text for use inside a cell: unescaped pipes become `\|`, newlines become `<br>`. */
export function escapeCell(text: string): string {
  let out = "";
  const source = text.replace(/\r\n?|\n/g, "<br>").trim();
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    out += ch === "|" && !isEscapedAt(source, i) ? "\\|" : ch;
  }
  return out;
}

/**
 * Which cell a column offset in a line belongs to. `offset` is relative to the start of the line
 * text (prefix included). Returns the column and the caret offset inside the cell's content.
 */
export function cellAtOffset(
  lineText: string,
  prefixLength: number,
  offset: number,
): { col: number; offsetInCell: number } {
  const s = lineText.slice(prefixLength);
  const rel = offset - prefixLength;
  const cells = scanRow(s);
  // Cell boundaries are the unescaped pipes; a caret on a pipe belongs to the cell on its left.
  let col = 0;
  for (let i = 0; i < Math.min(rel, s.length); i++) {
    if (s[i] === "|" && !isEscapedAt(s, i)) {
      // A leading pipe opens the first cell instead of closing one.
      if (s.slice(0, i).trim() === "") continue;
      if (i < rel) col++;
    }
  }
  col = Math.min(col, cells.length - 1);
  const cell = cells[col];
  const inCell = Math.min(Math.max(rel - cell.from, 0), cell.text.length);
  return { col, offsetInCell: inCell };
}

// ---------------------------------------------------------------------------
// Operations (immutable: each returns a new table)
// ---------------------------------------------------------------------------

function clone(t: MarkdownTable): MarkdownTable {
  return {
    ...t,
    header: t.header.slice(),
    align: t.align.slice(),
    rows: t.rows.map((r) => r.slice()),
  };
}

function emptyRow(t: MarkdownTable): string[] {
  return Array.from<string>({ length: columnCount(t) }).fill("");
}

/** Inserts an empty body row at body index `at` (0..rows.length). */
export function insertRow(t: MarkdownTable, at: number): MarkdownTable {
  const out = clone(t);
  out.rows.splice(Math.max(0, Math.min(at, out.rows.length)), 0, emptyRow(t));
  return out;
}

/** Deletes a body row. The header cannot be deleted (returns null). */
export function deleteRow(t: MarkdownTable, row: number): MarkdownTable | null {
  if (row < 0 || row >= t.rows.length) return null;
  const out = clone(t);
  out.rows.splice(row, 1);
  return out;
}

export function duplicateRow(t: MarkdownTable, row: number): MarkdownTable | null {
  if (row < 0 || row >= t.rows.length) return null;
  const out = clone(t);
  out.rows.splice(row + 1, 0, t.rows[row].slice());
  return out;
}

/** Moves a body row by `delta` (-1 up, +1 down). Null at an edge or for the header. */
export function moveRow(t: MarkdownTable, row: number, delta: -1 | 1): MarkdownTable | null {
  const target = row + delta;
  if (row < 0 || row >= t.rows.length || target < 0 || target >= t.rows.length) return null;
  const out = clone(t);
  [out.rows[row], out.rows[target]] = [out.rows[target], out.rows[row]];
  return out;
}

/** Inserts an empty column at index `at` (0..columnCount). */
export function insertColumn(t: MarkdownTable, at: number): MarkdownTable {
  const out = clone(t);
  const i = Math.max(0, Math.min(at, columnCount(t)));
  out.header.splice(i, 0, "");
  out.align.splice(i, 0, null);
  for (const r of out.rows) r.splice(i, 0, "");
  return out;
}

/** Deletes a column. The last remaining column cannot be deleted (returns null). */
export function deleteColumn(t: MarkdownTable, col: number): MarkdownTable | null {
  if (columnCount(t) <= 1 || col < 0 || col >= columnCount(t)) return null;
  const out = clone(t);
  out.header.splice(col, 1);
  out.align.splice(col, 1);
  for (const r of out.rows) r.splice(col, 1);
  return out;
}

export function moveColumn(t: MarkdownTable, col: number, delta: -1 | 1): MarkdownTable | null {
  const target = col + delta;
  const n = columnCount(t);
  if (col < 0 || col >= n || target < 0 || target >= n) return null;
  const out = clone(t);
  const swap = <T>(arr: T[]) => ([arr[col], arr[target]] = [arr[target], arr[col]]);
  swap(out.header);
  swap(out.align);
  out.rows.forEach(swap);
  return out;
}

export function setAlignment(t: MarkdownTable, col: number, align: Align): MarkdownTable | null {
  if (col < 0 || col >= columnCount(t)) return null;
  const out = clone(t);
  out.align[col] = align;
  return out;
}

export function setCell(t: MarkdownTable, row: number, col: number, text: string): MarkdownTable {
  const out = clone(t);
  if (row === HEADER_ROW) out.header[col] = text;
  else if (row >= 0 && row < out.rows.length) out.rows[row][col] = text;
  return out;
}

/** Cell text reduced to what a reader sees, for sorting: links, emphasis and code unwrapped. */
export function plainCellText(cell: string): string {
  return cell
    .replace(
      /!?\[\[([^\]|\\]*)(?:\\?\|([^\]]*))?\]\]/g,
      (_m, target: string, alias?: string) => alias ?? target,
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\\([|\\])/g, "$1")
    .trim();
}

function numericValue(text: string): number | null {
  const cleaned = text.replace(/[\s,$€£¥%]/g, "");
  if (cleaned === "" || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  return Number(cleaned);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sorts body rows by a column (stable). Numbers sort numerically, other text with a natural,
 * case-insensitive order, empty cells always last. The header stays on top.
 */
export function sortRows(t: MarkdownTable, col: number, dir: "asc" | "desc"): MarkdownTable | null {
  if (col < 0 || col >= columnCount(t) || t.rows.length < 2) return null;
  const sign = dir === "asc" ? 1 : -1;
  const keyed = t.rows.map((row, i) => ({ row, i, text: plainCellText(row[col] ?? "") }));
  keyed.sort((a, b) => {
    if (a.text === "" || b.text === "") {
      if (a.text === b.text) return a.i - b.i;
      return a.text === "" ? 1 : -1;
    }
    const na = numericValue(a.text);
    const nb = numericValue(b.text);
    const cmp = na !== null && nb !== null ? na - nb : collator.compare(a.text, b.text);
    return cmp === 0 ? a.i - b.i : sign * cmp;
  });
  const out = clone(t);
  out.rows = keyed.map((k) => k.row.slice());
  return out;
}

/** Rows become columns. Alignments reset; the old first column becomes the header. */
export function transpose(t: MarkdownTable): MarkdownTable {
  const matrix = [t.header, ...t.rows];
  const cols = columnCount(t);
  const flipped: string[][] = [];
  for (let c = 0; c < cols; c++) flipped.push(matrix.map((r) => r[c] ?? ""));
  return {
    header: flipped[0],
    align: Array.from<Align>({ length: flipped[0].length }).fill(null),
    rows: flipped.slice(1),
    firstPrefix: t.firstPrefix,
    prefix: t.prefix,
  };
}

// ---------------------------------------------------------------------------
// Building tables from other data
// ---------------------------------------------------------------------------

export function emptyTable(columns: number, bodyRows: number, prefix = ""): MarkdownTable {
  const n = Math.max(1, columns);
  return {
    header: Array.from<string>({ length: n }).fill(""),
    align: Array.from<Align>({ length: n }).fill(null),
    rows: Array.from({ length: bodyRows }, () => Array.from<string>({ length: n }).fill("")),
    firstPrefix: prefix,
    prefix,
  };
}

/** A table from a grid of plain strings (escaped for use in cells). First row is the header. */
export function tableFromGrid(grid: readonly (readonly string[])[], prefix = ""): MarkdownTable {
  const n = Math.max(1, ...grid.map((r) => r.length));
  const rows = grid.map((r) => padRow(r.map(escapeCell), n));
  return {
    header: rows[0] ?? Array.from<string>({ length: n }).fill(""),
    align: Array.from<Align>({ length: n }).fill(null),
    rows: rows.slice(1),
    firstPrefix: prefix,
    prefix,
  };
}

/** RFC 4180-style parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Guesses the delimiter of pasted tabular text: a tab, or a comma/semicolon that yields the same
 * (>1) column count on every non-empty line. Null when the text does not look tabular.
 */
export function detectDelimiter(text: string): string | null {
  if (text.trim() === "") return null;
  if (text.includes("\t")) return "\t";
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  if (lineCount < 2) return null;
  for (const d of [",", ";"]) {
    const rows = parseDelimited(text, d).filter((r) => !(r.length === 1 && r[0].trim() === ""));
    if (rows.length >= 2 && rows[0].length > 1 && rows.every((r) => r.length === rows[0].length)) {
      return d;
    }
  }
  return null;
}

/** A table from CSV/TSV text, or null when no delimiter fits. */
export function tableFromDelimited(text: string, prefix = ""): MarkdownTable | null {
  const delimiter = detectDelimiter(text);
  if (delimiter === null) return null;
  const rows = parseDelimited(text, delimiter).filter(
    (r) => !(r.length === 1 && r[0].trim() === ""),
  );
  return rows.length === 0 ? null : tableFromGrid(rows, prefix);
}

/** Cells of the first `<table>` in clipboard HTML (needs a DOM), or null. */
export function rowsFromHtmlTable(html: string): string[][] | null {
  if (typeof DOMParser === "undefined" || !/<table[\s>]/i.test(html)) return null;
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!table) return null;
  const grid: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
    if (cells.length === 0) continue;
    grid.push(
      cells.map((cell) => {
        const clone = cell.cloneNode(true) as Element;
        for (const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
        return (clone.textContent ?? "").replace(/[ \t\r\f\v ]+/g, " ").replace(/ ?\n ?/g, "\n");
      }),
    );
  }
  return grid.length > 0 ? grid : null;
}
