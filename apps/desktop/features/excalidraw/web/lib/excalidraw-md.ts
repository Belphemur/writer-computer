// The codec of drawing files (ADR 2026-11-18 "draw natively with a built-in Excalidraw feature",
// spec `SPECs/excalidraw-spec.md` "Files"): `*.excalidraw.md` in the shape the Obsidian Excalidraw
// plugin writes (front matter, `# Excalidraw Data`, `## Text Elements`, `## Embedded Files`, the
// drawing in a `%%`-fenced `## Drawing` block as `compressed-json` or `json`) and plain
// `*.excalidraw` JSON. Implemented from the observable shape of those files, pinned by
// `shared/excalidraw-fixtures/`; the Rust twin is `src-tauri/src/excalidraw_codec.rs` and both
// pass the same fixtures.
//
// This is the editor's one write path for drawing files. Pure: no DOM, no Excalidraw import, so
// the embed, the exporter and the tests use it without the canvas chunk.
//
// Writing keeps everything it does not own byte for byte (front matter, text before the data,
// unknown sections, the fence tag, the line ending) and regenerates only `## Text Elements`, the
// drawing block and, when images were added, `## Embedded Files`.
import LZString from "lz-string";
import { describeError } from "@/lib/logger";
import { isWikiLink, parseWikiLink, wikiLinkInner } from "@/lib/wiki-links";

export type Encoding = "compressed-json" | "json";
export type DrawingFormat = "md" | "plain";

/** The lines of the compressed block (the plugin wraps its base64 at this width). */
export const COMPRESSED_LINE_WIDTH = 256;

export interface SceneFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  [key: string]: unknown;
}

export interface SceneElement {
  id: string;
  type: string;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  text?: string;
  originalText?: string;
  fileId?: string | null;
  [key: string]: unknown;
}

export interface Scene {
  type: "excalidraw";
  version: number;
  source: string;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, SceneFile>;
}

export interface ParsedDrawing {
  format: DrawingFormat;
  /** `json` for a plain `.excalidraw`. */
  encoding: Encoding;
  scene: Scene;
  /** `## Embedded Files` image references: file id to the link target (`attachments/pic.png`). */
  embedded: Record<string, string>;
  /** The file as read; an unchanged scene is written back as exactly this. */
  text: string;
}

/** The part of the drawing a save carries: what the canvas holds, plus the image references. */
export interface DrawingState {
  scene: Scene;
  embedded: Record<string, string>;
}

const MD_SUFFIX = ".excalidraw.md";
const PLAIN_SUFFIX = ".excalidraw";

export function drawingFormatOf(path: string): DrawingFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(MD_SUFFIX)) return "md";
  if (lower.endsWith(PLAIN_SUFFIX)) return "plain";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------------------------

export function emptyScene(source = "https://excalidraw.com"): Scene {
  return {
    type: "excalidraw",
    version: 2,
    source,
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function asScene(value: unknown): Scene {
  if (!value || typeof value !== "object") throw new Error("the drawing data is not an object");
  const v = value as Partial<Scene>;
  if (!Array.isArray(v.elements)) throw new Error("the drawing data has no elements list");
  return {
    type: "excalidraw",
    version: typeof v.version === "number" ? v.version : 2,
    source: typeof v.source === "string" ? v.source : "https://excalidraw.com",
    elements: v.elements as SceneElement[],
    appState: v.appState && typeof v.appState === "object" ? v.appState : {},
    files: v.files && typeof v.files === "object" ? (v.files as Scene["files"]) : {},
  };
}

/** What a drawing file keeps of the canvas's app state: the background and the grid. */
export function persistedAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.gridSize = "gridSize" in appState ? (appState.gridSize ?? null) : null;
  if (typeof appState.viewBackgroundColor === "string") {
    out.viewBackgroundColor = appState.viewBackgroundColor;
  }
  return out;
}

const live = (elements: readonly SceneElement[]) => elements.filter((e) => e.isDeleted !== true);

/** The length of a text element's id in `## Text Elements` (`text ^id`): the plugin finds the
 *  entries by `^` plus exactly eight characters, so a longer id (Excalidraw makes 21) is cut. */
export const TEXT_ID_LENGTH = 8;

/**
 * Text elements whose id is longer than [`TEXT_ID_LENGTH`] get a short one, and every reference
 * to the old id (container, bound elements, arrow bindings) follows. The new id is the old
 * id's first eight characters, so the same drawing always maps the same way and the canvas and
 * the file can be compared after a save; a clash takes the next free variant in id order.
 */
export function shortenTextIds<T extends SceneElement>(elements: readonly T[]): T[] {
  const taken = new Set(elements.map((e) => e.id));
  const renames = new Map<string, string>();
  const longText = elements
    .filter((e) => e.type === "text" && e.id.length > TEXT_ID_LENGTH)
    .map((e) => e.id)
    .sort();
  for (const id of longText) {
    let candidate = id.slice(0, TEXT_ID_LENGTH);
    for (let n = 0; taken.has(candidate); n++) {
      candidate = id.slice(0, TEXT_ID_LENGTH - 1) + (n % 36).toString(36);
      if (n > 36 * 36) throw new Error("no free text id");
    }
    taken.add(candidate);
    renames.set(id, candidate);
  }
  if (renames.size === 0) return elements as T[];
  const rename = (id: string) => renames.get(id) ?? id;
  return elements.map((el) => {
    const next: Record<string, unknown> = { ...el, id: rename(el.id) };
    if (typeof el.containerId === "string") next.containerId = rename(el.containerId);
    if (Array.isArray(el.boundElements)) {
      next.boundElements = el.boundElements.map((b: { id: string }) => ({
        ...b,
        id: rename(b.id),
      }));
    }
    for (const key of ["startBinding", "endBinding"]) {
      const binding = el[key] as { elementId?: string } | null | undefined;
      if (binding && typeof binding.elementId === "string") {
        next[key] = { ...binding, elementId: rename(binding.elementId) };
      }
    }
    return next as T;
  });
}

// ---------------------------------------------------------------------------------------------
// The markdown layout
// ---------------------------------------------------------------------------------------------

interface Layout {
  eol: string;
  lines: string[];
  /** `## Drawing`. */
  drawing: number;
  fenceOpen: number;
  fenceClose: number;
  encoding: Encoding;
  /** `## Text Elements` and `## Embedded Files`, or -1. */
  textHeading: number;
  embeddedHeading: number;
}

const trimEol = (l: string) => l.replace(/\r$/, "");
const FENCE_OPEN = /^```(compressed-json|json)\s*$/;

/** The index one past the last line of the section whose heading is at `heading`: the next
 *  heading, or the `%%` that opens the drawing block. */
function sectionEnd(lines: readonly string[], heading: number, limit: number): number {
  for (let i = heading + 1; i < limit; i++) {
    const l = trimEol(lines[i]!);
    if (l === "%%" || l.startsWith("## ") || l.startsWith("# ")) return i;
  }
  return limit;
}

function locate(text: string): Layout {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  let drawing = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (trimEol(lines[i]!) === "## Drawing" && FENCE_OPEN.test(trimEol(lines[i + 1]!))) {
      drawing = i;
      break;
    }
  }
  if (drawing < 0) throw new Error("no ## Drawing block found");
  const fenceOpen = drawing + 1;
  const encoding = FENCE_OPEN.exec(trimEol(lines[fenceOpen]!))![1] as Encoding;
  let fenceClose = -1;
  for (let i = fenceOpen + 1; i < lines.length; i++) {
    if (trimEol(lines[i]!).trim() === "```") {
      fenceClose = i;
      break;
    }
  }
  if (fenceClose < 0) throw new Error("the ## Drawing block is not closed");
  const heading = (name: string) => {
    for (let i = 0; i < drawing; i++) if (trimEol(lines[i]!) === name) return i;
    return -1;
  };
  return {
    eol,
    lines,
    drawing,
    fenceOpen,
    fenceClose,
    encoding,
    textHeading: heading("## Text Elements"),
    embeddedHeading: heading("## Embedded Files"),
  };
}

const EMBEDDED_ID = /^[A-Za-z0-9_-]+$/;

/** `id: [[target]]`, with an optional leading `!` and the colour map the plugin appends after the
 *  link (` {...}`). Anything else (a formula, a web link) is not an image reference: it stays in
 *  the file untouched and is not listed. */
function embeddedEntry(line: string): [string, string] | null {
  const at = line.indexOf(": ");
  if (at < 1 || !EMBEDDED_ID.test(line.slice(0, at))) return null;
  let value = line.slice(at + 2).trimEnd();
  if (value.startsWith("!")) value = value.slice(1);
  const map = value.indexOf(" {");
  const link = map < 0 ? value : value.slice(0, map);
  if (!isWikiLink(link)) return null;
  const target = parseWikiLink(wikiLinkInner(link)).path;
  return target ? [line.slice(0, at), target] : null;
}

function parseEmbedded(layout: Layout): Record<string, string> {
  const out: Record<string, string> = {};
  if (layout.embeddedHeading < 0) return out;
  const end = sectionEnd(layout.lines, layout.embeddedHeading, layout.drawing);
  for (let i = layout.embeddedHeading + 1; i < end; i++) {
    const entry = embeddedEntry(trimEol(layout.lines[i]!));
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

/** `## Text Elements` as id to text. A drawing whose elements lost their text (a tool that
 *  strips it) still reads: the section is the second source. */
function parseTextElements(layout: Layout): Map<string, string> {
  const out = new Map<string, string>();
  if (layout.textHeading < 0) return out;
  const end = sectionEnd(layout.lines, layout.textHeading, layout.drawing);
  let pending: string[] = [];
  for (let i = layout.textHeading + 1; i < end; i++) {
    const line = trimEol(layout.lines[i]!);
    const m = /^(.*) \^([A-Za-z0-9_-]+)$/s.exec(line);
    if (m) {
      out.set(m[2]!, [...pending, m[1]!].join("\n"));
      pending = [];
    } else if (line === "" && pending.length === 0) {
      continue;
    } else {
      pending.push(line);
    }
  }
  return out;
}

function decodeBody(body: string, encoding: Encoding): Scene {
  let json: string | null;
  if (encoding === "compressed-json") {
    json = LZString.decompressFromBase64(body.replace(/\s+/g, ""));
    if (!json) throw new Error("the compressed drawing could not be read");
  } else {
    json = body;
  }
  try {
    return asScene(JSON.parse(json));
  } catch (e) {
    throw new Error(`the drawing data is not valid: ${describeError(e).message}`);
  }
}

export function parseDrawing(text: string, format: DrawingFormat): ParsedDrawing {
  if (format === "plain") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new Error(`not a drawing: ${describeError(e).message}`);
    }
    return { format, encoding: "json", scene: asScene(value), embedded: {}, text };
  }
  const layout = locate(text);
  const body = layout.lines.slice(layout.fenceOpen + 1, layout.fenceClose).join("\n");
  const scene = decodeBody(body, layout.encoding);
  const texts = parseTextElements(layout);
  for (const el of scene.elements) {
    if (el.type === "text" && !el.text && texts.has(el.id)) {
      const t = texts.get(el.id)!;
      el.text = t;
      el.originalText = t;
    }
  }
  return { format, encoding: layout.encoding, scene, embedded: parseEmbedded(layout), text };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** The scene as a file keeps it. In a markdown drawing only the images that were inline stay in
 *  `files`; every other image is a vault file named in `## Embedded Files`. */
function persisted(
  parsed: ParsedDrawing,
  next: DrawingState,
): { scene: Scene; embedded: Record<string, string> } {
  const elements =
    parsed.format === "md" ? shortenTextIds(live(next.scene.elements)) : live(next.scene.elements);
  const used = new Set(
    elements.filter((e) => e.type === "image" && e.fileId).map((e) => e.fileId as string),
  );
  const inline = new Set(Object.keys(parsed.scene.files));
  const files: Record<string, SceneFile> = {};
  for (const [id, file] of Object.entries(next.scene.files)) {
    if (parsed.format === "plain" || inline.has(id)) files[id] = file;
    else if (used.has(id) && !(id in next.embedded)) {
      throw new Error(`image ${id} is not saved as a vault file yet`);
    }
  }
  const embedded = { ...parsed.embedded, ...next.embedded };
  return {
    scene: {
      type: "excalidraw",
      version: next.scene.version,
      source: next.scene.source,
      elements,
      appState: persistedAppState(next.scene.appState),
      files,
    },
    embedded,
  };
}

function textElementLines(elements: readonly SceneElement[]): string[] {
  const out: string[] = [];
  for (const el of elements) {
    if (el.type !== "text") continue;
    const text = el.originalText ?? el.text ?? "";
    out.push(...`${text} ^${el.id}`.split("\n"), "");
  }
  return out;
}

/** The plugin writes the scene tab-indented, and compresses that text; the compressed form is
 *  rows of 256 characters, each followed by a blank line. */
function encodeBody(scene: Scene, encoding: Encoding): string[] {
  const json = JSON.stringify(scene, null, "\t");
  if (encoding === "json") return json.split("\n");
  const base64 = LZString.compressToBase64(json);
  const rows: string[] = [];
  for (let i = 0; i < base64.length; i += COMPRESSED_LINE_WIDTH) {
    if (i > 0) rows.push("");
    rows.push(base64.slice(i, i + COMPRESSED_LINE_WIDTH));
  }
  return rows;
}

/** Where a new section goes: before `## Embedded Files` when given, else before the `%%` that
 *  opens the drawing block (or the heading itself when there is none). */
function sectionInsertAt(layout: Layout, beforeEmbedded: boolean): number {
  if (beforeEmbedded && layout.embeddedHeading >= 0) return layout.embeddedHeading;
  const prev = layout.drawing - 1;
  return prev >= 0 && trimEol(layout.lines[prev]!) === "%%" ? prev : layout.drawing;
}

function sameDrawing(a: { scene: Scene; embedded: Record<string, string> }, b: typeof a): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The file text for `next`. An unchanged drawing returns the text that was read, byte for byte;
 * a changed one keeps the file's encoding and every part it does not own.
 */
export function serializeDrawing(parsed: ParsedDrawing, next: DrawingState): string {
  const want = persisted(parsed, next);
  if (sameDrawing(persisted(parsed, { scene: parsed.scene, embedded: parsed.embedded }), want)) {
    return parsed.text;
  }
  if (parsed.format === "plain") {
    const text = JSON.stringify(want.scene, null, 2);
    return parsed.text.endsWith("\n") ? `${text}\n` : text;
  }
  const layout = locate(parsed.text);
  const lines = layout.lines.slice();

  // Bottom to top, so an earlier edit never shifts the index of a later one.
  lines.splice(
    layout.fenceOpen + 1,
    layout.fenceClose - layout.fenceOpen - 1,
    ...encodeBody(want.scene, layout.encoding),
  );

  const added = Object.entries(want.embedded).filter(([id]) => !(id in parsed.embedded));
  const addedLines = added.flatMap(([id, target]) => [`${id}: [[${target}]]`, ""]);
  if (addedLines.length > 0) {
    if (layout.embeddedHeading >= 0) {
      const end = sectionEnd(layout.lines, layout.embeddedHeading, layout.drawing);
      // after the last entry's blank line: every entry is followed by one
      const entries = layout.lines.slice(layout.embeddedHeading + 1, end);
      const tail = entries.length > 0 && entries[entries.length - 1]!.trim() === "" ? 0 : 1;
      lines.splice(end, 0, ...(tail ? [""] : []), ...addedLines);
    } else {
      lines.splice(sectionInsertAt(layout, false), 0, "## Embedded Files", ...addedLines);
    }
  }

  const texts = textElementLines(want.scene.elements);
  if (layout.textHeading >= 0) {
    const end = sectionEnd(layout.lines, layout.textHeading, layout.drawing);
    lines.splice(layout.textHeading + 1, end - layout.textHeading - 1, ...texts);
  } else if (texts.length > 0) {
    lines.splice(sectionInsertAt(layout, true), 0, "## Text Elements", ...texts);
  }
  return lines.join(layout.eol);
}

// ---------------------------------------------------------------------------------------------
// New drawings
// ---------------------------------------------------------------------------------------------

const NEW_FRONT_MATTER = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";
const BANNER =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'\n\n\n";

/** The text of a new, empty `.excalidraw.md` drawing (compressed, the plugin's default). */
export function newDrawingText(format: DrawingFormat = "md"): string {
  const scene = emptyScene();
  if (format === "plain") return `${JSON.stringify(scene, null, 2)}\n`;
  const body = encodeBody(scene, "compressed-json").join("\n");
  return `${NEW_FRONT_MATTER}${BANNER}# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n\`\`\`compressed-json\n${body}\n\`\`\`\n%%\n`;
}
