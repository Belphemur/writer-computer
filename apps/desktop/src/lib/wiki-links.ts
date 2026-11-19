import { RENDERABLE_IMAGE_EXTENSIONS, isDocumentName } from "./attachments";
import { slugifyHeading } from "./heading-slug";
import { noteLabel } from "./note-title";
import { parsePdfAnchor } from "./pdf-anchor";
import { getFileName, getFileStem, getParentDir, isBasePath, normalizePath } from "./paths";
import type { SearchResult } from "@/types/fs";

export type WikiLinkTarget =
  | {
      kind: "internal";
      path: string;
      /** What to reveal once the file shows (`linkAnchor`): the heading slug for a note, the view
       *  name for a `.base` file, `page=N` for a PDF. Absent when the link has no usable fragment. */
      fragment?: string;
    }
  | { kind: "unresolved" };
export interface ParsedWikiLink {
  raw: string;
  target: string;
  path: string;
  fragment: string | null;
  alias: string | null;
  displayText: string;
}

function unescapeWikiText(text: string): string {
  return text.replace(/\\\|/g, "|").trim();
}

function splitAlias(raw: string): { target: string; alias: string | null } {
  const separator = raw.indexOf("|");
  if (separator === -1) {
    return { target: raw, alias: null };
  }

  const escapedSeparator = separator > 0 && raw[separator - 1] === "\\";
  const targetEnd = escapedSeparator ? separator - 1 : separator;

  return {
    target: raw.slice(0, targetEnd),
    alias: unescapeWikiText(raw.slice(separator + 1)),
  };
}

function splitFragment(target: string): { path: string; fragment: string | null } {
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) {
    return { path: target, fragment: null };
  }

  return {
    path: target.slice(0, hashIndex),
    fragment: target.slice(hashIndex + 1),
  };
}

export function parseWikiLink(raw: string): ParsedWikiLink {
  const { target, alias } = splitAlias(raw.trim());
  const normalizedTarget = unescapeWikiText(target);
  const { path, fragment } = splitFragment(normalizedTarget);
  const normalizedPath = normalizeWikiTarget(path);
  const fallbackDisplay = normalizedPath || (fragment ? `#${fragment}` : normalizedTarget);

  return {
    raw,
    target: normalizedTarget,
    path: normalizedPath,
    fragment,
    alias: alias || null,
    displayText: alias || fallbackDisplay,
  };
}

// -- The `[[...]]` grammar: the one place that knows its brackets --------------------------------

const WIKI_LINK_VALUE_RE = /^\[\[[^\]]+\]\]$/;

/** Whether `value` (trimmed) is exactly one `[[...]]` link: a property value, a cell. */
export function isWikiLink(value: string): boolean {
  return WIKI_LINK_VALUE_RE.test(value.trim());
}

/** The text between the brackets of a link value (`[[A|b]]` -> `A|b`); a value without brackets
 *  comes back trimmed. */
export function wikiLinkInner(value: string): string {
  return value.trim().replace(/^\[\[|\]\]$/g, "");
}

/** [`parseWikiLink`] of a bracketed value. */
export function parseWikiLinkValue(value: string): ParsedWikiLink {
  return parseWikiLink(wikiLinkInner(value));
}

/** Every `[[...]]` and `![[...]]` in a text (single line each): group 1 is the `!` of an embed,
 *  group 2 the inner text. A fresh global RegExp per call, so no `lastIndex` is shared. */
export function wikiLinkScanner(): RegExp {
  return /(!?)\[\[([^\]\n]+?)\]\]/g;
}

/** The link that starts `src` (a tokenizer's position), or null. */
export function matchWikiLinkAtStart(
  src: string,
): { raw: string; embed: boolean; inner: string } | null {
  const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(src);
  return m ? { raw: m[0], embed: m[1] === "!", inner: m[2]! } : null;
}

/** The `[[query` being typed right before the caret: group 1 is the query. The `[[` autocomplete
 *  of the editor and of the property inputs share it. */
export const WIKI_SUGGEST_TRIGGER = /\[\[([^\]#^|]*)$/;

/**
 * Normalize a raw wiki-link target string for resolution:
 * trim whitespace, normalize backslashes, strip .md/.markdown extension.
 */
export function normalizeWikiTarget(raw: string): string {
  let target = raw.trim().replace(/\\/g, "/");
  target = target.replace(/^\/+/, "");
  const lower = target.toLowerCase();
  if (lower.endsWith(".md")) {
    target = target.slice(0, -3);
  } else if (lower.endsWith(".markdown")) {
    target = target.slice(0, -9);
  }
  return target;
}

/**
 * The anchor of a PDF link's `#fragment`: the fragment as written when it carries `page=N` (and
 * `height=` for an embed), else none (the PDF opens at its first page). `lib/pdf-anchor.ts` reads it.
 */
function pdfFragmentAnchor(fragment: string): string | null {
  return parsePdfAnchor(fragment).page !== null ? fragment : null;
}

/**
 * The anchor a link's `#fragment` asks for in the file it opens: the view name of a `.base` file,
 * otherwise the slug of the heading (`#A#B` means the last segment, matched case-insensitively
 * like Obsidian; the slug is the one `findHeadingBySlug` indexes). `#^block` ids and empty
 * fragments have no anchor (the note opens at its top).
 */
export function linkAnchor(target: string, fragment: string | null): string | null {
  if (!fragment) return null;
  if (isBasePath(target)) return fragment;
  if (isDocumentName(getFileName(target))) return pdfFragmentAnchor(fragment);
  const last = fragment
    .split("#")
    .filter((segment) => segment.trim() !== "")
    .pop();
  if (!last || last.startsWith("^")) return null;
  return slugifyHeading(last) || null;
}

/**
 * Asks the backend (the vault index's file-name resolver, `index/resolve.rs`) for the
 * absolute path a link target written in `sourcePath` points to, or null.
 */
export type ResolveLinkTarget = (
  target: string,
  sourcePath: string | null,
) => Promise<string | null>;

/**
 * Resolve a wiki-link to an internal file path or unresolved.
 *
 * Resolution is by file name, never by a note's title (frontmatter `title`, first heading):
 * the backend resolver matches the name case-insensitively with the `.md` extension optional,
 * a partial path (`folder/Name`) as a path suffix, and non-Markdown files by full name; with
 * several matches the closest folder wins, then the shortest path, then alphabetical order.
 * The same resolver builds backlinks, `writer` link commands and Bases `link()`.
 * See SPECs/filename-links-and-rename-spec.md.
 */
export async function resolveWikiLink(
  raw: string,
  currentFilePath: string | null,
  resolveLink: ResolveLinkTarget,
): Promise<WikiLinkTarget> {
  const link = parseWikiLink(raw);
  const target = link.path;
  if (!target && link.fragment && currentFilePath) {
    const anchor = linkAnchor(currentFilePath, link.fragment);
    return { kind: "internal", path: currentFilePath, ...(anchor ? { fragment: anchor } : {}) };
  }
  if (!target) return { kind: "unresolved" };

  const path = await resolveLink(target, currentFilePath);
  if (!path) return { kind: "unresolved" };
  const anchor = linkAnchor(target, link.fragment);
  return { kind: "internal", path, ...(anchor ? { fragment: anchor } : {}) };
}

// Image formats supported by Obsidian-style embeds (`![[image.png]]`),
// per SPECs/obsidian-image-embed-spec.md: the renderable list of shared/attachments.json.

/**
 * Parse the inner text of a `![[...]]` embed. Returns the normalized image
 * path (slashes normalized, leading `/` stripped) when the target is an
 * image, or null for non-image embeds (note transclusions, PDFs, …).
 * Anything after an unescaped `|` (alias / size modifiers) is ignored —
 * v1 non-goals per the spec.
 */
export function parseWikiImageEmbedTarget(raw: string): string | null {
  const { target } = splitAlias(raw.trim());
  const path = unescapeWikiText(target).replace(/\\/g, "/").replace(/^\/+/, "");
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return RENDERABLE_IMAGE_EXTENSIONS.has(ext) ? path : null;
}

/**
 * Resolve a wiki image embed target to an absolute file path, or null.
 *
 * - Targets with `/` resolve workspace-relative first (Obsidian vault-path
 *   semantics), then relative to the current note's directory.
 * - Bare basenames probe next to the note and at the workspace root, then
 *   fall back to a case-insensitive basename search across the workspace
 *   (`findFileByName`) — Obsidian's default "shortest path" links reference
 *   attachments by bare filename wherever they live.
 * - Without a workspace (compact windows), only note-relative probing
 *   applies.
 */
export async function resolveWikiImage(
  target: string,
  workspaceRoot: string | null,
  currentFilePath: string | null,
  fileExists: (path: string) => Promise<boolean>,
  findFileByName: (root: string, fileName: string) => Promise<string | null>,
): Promise<string | null> {
  const noteDir = currentFilePath ? getParentDir(currentFilePath) : null;
  const root = workspaceRoot ? workspaceRoot.replace(/\/$/, "") : null;

  const candidates: string[] = [];
  const pushCandidate = (base: string | null) => {
    if (!base) return;
    const path = normalizePath(`${base}/${target}`);
    if (!candidates.includes(path)) candidates.push(path);
  };
  if (target.includes("/")) {
    pushCandidate(root);
    pushCandidate(noteDir);
  } else {
    pushCandidate(noteDir);
    pushCandidate(root);
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  if (root && !target.includes("/")) {
    return findFileByName(root, target);
  }
  return null;
}

/**
 * Compute the canonical insertion text for a selected file.
 * Uses the shortest unambiguous form: bare stem when unique,
 * workspace-relative path (without extension) when duplicate stems exist.
 */
export function canonicalWikiTarget(file: SearchResult, allFiles: SearchResult[]): string {
  const stem = getFileStem(file.filename);
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  const stemLower = key(stem);

  const hasDuplicate = allFiles.some(
    (f) => f.path !== file.path && key(getFileStem(f.filename)) === stemLower,
  );

  if (!hasDuplicate) return stem;

  return stripMdExtension(file.relative_path);
}

/**
 * What a `[[` suggestion shows: the note's title (its file name, or the frontmatter `title`
 * override) with the folder as detail; an override also names the file. Insertion is separate
 * ([`canonicalWikiTarget`]): a title is never a link target.
 */
export function wikiCompletionDisplay(file: SearchResult): {
  label: string;
  detail: string | undefined;
} {
  const shown = noteLabel(file.path, file.title);
  const relDir = file.relative_path.slice(0, file.relative_path.length - file.filename.length);
  const folder = relDir ? relDir.replace(/\/$/, "") : undefined;
  return {
    label: shown.text,
    detail: shown.isOverride ? [file.filename, folder].filter(Boolean).join(" · ") : folder,
  };
}

export interface WikiSuggestion {
  label: string;
  detail: string | undefined;
  /** What goes between `[[` and `]]`: the file name (path when ambiguous), never a title. */
  insertText: string;
}

/** The `[[` suggestions for `query`: the ranked fuzzy matches of the vault's notes, shared by the
 *  editor's autocomplete and the property inputs. */
export async function wikiSuggestions(
  query: string,
  search: (query: string, limit: number) => Promise<SearchResult[]>,
  limit = 20,
): Promise<WikiSuggestion[]> {
  const results = await search(query, limit);
  return results.map((r) => ({
    ...wikiCompletionDisplay(r),
    insertText: canonicalWikiTarget(r, results),
  }));
}

function stripMdExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return path.slice(0, -3);
  if (lower.endsWith(".markdown")) return path.slice(0, -9);
  return path;
}
