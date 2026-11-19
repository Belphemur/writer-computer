import shared from "@shared/attachments.json";
import { getFileName, getRelativePath } from "@/lib/paths";

/**
 * Rules for images dropped or pasted into a note (spec: SPECs/image-insertion-spec.md). The Rust
 * twin is `src-tauri/src/attachments.rs`: it decides the folder, collisions and the final checks;
 * this module owns the names pasted images get and the link text inserted into the note. Shared
 * data (size cap, extensions) is `shared/attachments.json`.
 */

export const MAX_ATTACHMENT_BYTES: number = shared.maxBytes;
export const MAX_ATTACHMENT_MB = Math.round(shared.maxBytes / (1024 * 1024));

/** Image types the webview shows inline as `![[name.ext]]`. */
export const RENDERABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(shared.renderExtensions);

/** Does this file name open in the image viewer (a renderable image, whatever the sidebar setting)? */
export function isRenderableImageName(name: string): boolean {
  return RENDERABLE_IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** Document types (`documentExtensions`, PDFs): listed by `files.show-pdfs`, opened by the PDF
 *  reader, attached in the agent composer. */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(shared.documentExtensions);

/** Does this file name open in the PDF reader (a document type, whatever the sidebar setting)? */
export function isDocumentName(name: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(name));
}

const IMPORT_EXTENSIONS: ReadonlySet<string> = new Set(shared.importExtensions);

const MIME_EXTENSIONS: Readonly<Record<string, string>> = shared.mimeExtensions;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImportableImageName(name: string): boolean {
  return IMPORT_EXTENSIONS.has(extensionOf(name));
}

/** Extension for a clipboard/drag MIME type, or null when it is not an importable image. */
export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? null;
}

/** Browsers name a screenshot or a "copy image" blob `image.png`: that is not a name worth keeping. */
export function isGenericClipboardName(name: string): boolean {
  return name === "" || /^image\.[a-z0-9]+$/i.test(name);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Obsidian's convention: `Pasted image YYYYMMDDHHmmss.png`, in local time. */
export function pastedImageStem(now: Date = new Date()): string {
  const stamp =
    `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}`;
}

export function pastedImageName(ext: string, now: Date = new Date()): string {
  return `${pastedImageStem(now)}.${ext}`;
}

/**
 * The wikilink target for a vault file embedded from a note: the bare file name when the resolver
 * finds it by probing (next to the note or at the vault root), else the vault-relative path
 * (probed workspace-relative, so the image renders before the index has seen the file).
 * `fileRel` and `noteDirRel` are both relative to the vault (`""` is the root). Without a vault
 * (standalone window) pass `noteDirRel` null and a note-relative `fileRel`: it is used as is.
 */
export function attachmentLinkTarget(fileRel: string, noteDirRel: string | null): string {
  if (noteDirRel === null) return fileRel;
  const dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : "";
  return dir === "" || dir === noteDirRel ? getFileName(fileRel) : fileRel;
}

/** `![[target]]`: the wikilink embed of one image. */
export function embedText(targets: readonly string[]): string {
  return targets.map((target) => `![[${target}]]`).join("\n");
}

/** Characters that end or split a wikilink (`]]`, `|` alias, `#` heading, `^` block): a target
 *  holding one cannot be written as `![[...]]`. */
const WIKILINK_BREAKERS = /[[\]|#^]/;

/** `toFile` as a path relative to the folder `fromDir` (both vault-relative, `""` is the root). */
export function relativeVaultPath(fromDir: string, toFile: string): string {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = toFile.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

/** `![](destination)` with the characters a markdown destination cannot hold percent-encoded. */
export function markdownImage(destination: string): string {
  const encoded = destination.replace(
    /[\s()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `![](${encoded})`;
}

/**
 * The text that embeds the vault image `fileRel` in a note: `![[target]]`, or, when the name
 * holds `[ ] | # ^` (a wikilink cannot carry them), a markdown image with the note-relative path
 * percent-encoded per segment (the editor decodes it when it resolves the image). Without a
 * vault (`noteDirRel` null) the path is already note-relative.
 */
export function embedLine(fileRel: string, noteDirRel: string | null): string {
  const target = attachmentLinkTarget(fileRel, noteDirRel);
  if (!WIKILINK_BREAKERS.test(target)) return embedText([target]);
  const relative = noteDirRel === null ? fileRel : relativeVaultPath(noteDirRel, fileRel);
  return markdownImage(relative.split("/").map(encodeURIComponent).join("/"));
}

/** The `http(s)` image URLs a drag or paste carries without any file: `<img src>` of a drag or
 *  of a copied image (only when the HTML holds no text of its own, so a copied page excerpt
 *  still pastes as text), or a `text/uri-list` link whose path ends in an image extension. */
export function imageUrlsFromTransfer(html: string, uriList: string): string[] {
  const urls: string[] = [];
  const add = (raw: string) => {
    try {
      const url = new URL(raw.trim());
      if (/^https?:$/.test(url.protocol) && !urls.includes(url.href)) urls.push(url.href);
    } catch {
      // not a URL: ignore
    }
  };
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  if (text === "") {
    for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      add((match[1] ?? match[2] ?? "").replace(/&amp;/g, "&"));
    }
  }
  for (const line of uriList.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    try {
      if (isImportableImageName(new URL(line.trim()).pathname)) add(line);
    } catch {
      // not a URL: ignore
    }
  }
  return urls;
}

/** `abs` relative to the vault `root` (`""` for the root itself). */
export function vaultRelative(abs: string, root: string): string {
  const normalized = abs.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized === normalizedRoot ? "" : getRelativePath(normalized, normalizedRoot);
}
