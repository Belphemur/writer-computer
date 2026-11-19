/**
 * Files in the agent chat composer, images and PDFs (spec `SPECs/native-agent-spec.md`, "Files in
 * the composer"; `SPECs/pdf-spec.md`, "Agent attachments"). Pure rules plus one attach routine
 * whose IO is injected, so it is testable without a window.
 *
 * - What is accepted: a paste or browser drag of an image or PDF; from Finder any file (secret
 *   names and the shared cap are refused in Rust, `dropped.rs`); from the sidebar anything in the
 *   vault, a folder included. The formats the model reads as an image block or a PDF document block
 *   are `shared/agent-chat-files.json` (Rust twin `agent/files.rs`), with the shared attachment cap
 *   and, for a PDF, the API's byte and page caps.
 * - Where it goes: pasted bytes are saved, and a Finder file from outside the vault is copied, by
 *   Rust into the chat folder's hidden `assets/` (`agent_save_chat_file`, `agent_import_chat_file`);
 *   anything already in the vault (the sidebar, or a Finder drag of a vault file) is referenced
 *   where it is, nothing is copied.
 * - What the draft keeps: an image or PDF is a `{ kind: "image" | "document", path }` ref
 *   (vault-relative) shown as a chip (thumbnail, or a PDF icon with its page count) and sent as a
 *   native block plus a line in `<references>`; any other file or a folder is the `@` mention chip
 *   (`mentions.ts`, `mentionPatch`).
 */
import shared from "@shared/agent-chat-files.json";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  extensionForMime,
  isGenericClipboardName,
  pastedImageName,
} from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import type { ChatFile } from "./chat-history-client";
import type { ContextRef } from "./events";
import type { MentionTarget } from "./mentions";

const MEDIA_TYPES: Readonly<Record<string, string>> = shared.mediaTypes;
const DOCUMENT_TYPES: Readonly<Record<string, string>> = shared.documentMediaTypes;
const DOCUMENT_MAX_BYTES: number = shared.documentMaxBytes;
const DOCUMENT_MAX_MB = Math.round(DOCUMENT_MAX_BYTES / (1024 * 1024));
/** The API reads at most this many pages of a PDF per request. */
export const DOCUMENT_MAX_PAGES: number = shared.documentMaxPages;

/** Rough cost of one image in the context window (the API prices an image by its size, about
 *  `width * height / 750` tokens up to a cap of roughly 1,600). A fixed figure for the chip's
 *  tooltip; the context ring itself counts images once sent, from the CLI's own usage numbers. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

export type ChatImageRef = Extract<ContextRef, { kind: "image" }>;
export type ChatDocumentRef = Extract<ContextRef, { kind: "document" }>;
export type ChatFileRef = ChatImageRef | ChatDocumentRef;

export const isChatFileRef = (r: ContextRef): r is ChatFileRef =>
  r.kind === "image" || r.kind === "document";

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Does the model read this file name as an image? */
export const isChatImageName = (name: string): boolean => extensionOf(name) in MEDIA_TYPES;

/** Does the model read this file name as a document (a PDF)? */
export const isChatDocumentName = (name: string): boolean => extensionOf(name) in DOCUMENT_TYPES;

/** Does the model read this file name as an image or a PDF? */
export const isChatFileName = (name: string): boolean =>
  isChatImageName(name) || isChatDocumentName(name);

/** The draft ref of a file: a PDF is a `document`, anything else an `image`. */
export const chatFileRef = (path: string): ChatFileRef =>
  isChatDocumentName(path) ? { kind: "document", path } : { kind: "image", path };

/** The sentence for a file that cannot be attached, or null. `size` null: not known yet. */
export function refusal(name: string, size: number | null): string | null {
  if (!isChatFileName(name))
    return `Not attached: ${name || "this file"} is not an image or PDF Claude can read (png, jpg, gif, webp, pdf)`;
  if (isChatDocumentName(name)) {
    if (size !== null && size > DOCUMENT_MAX_BYTES)
      return `Not attached: ${name} is over the ${DOCUMENT_MAX_MB} MB PDF limit`;
    return null;
  }
  if (size !== null && size > MAX_ATTACHMENT_BYTES)
    return `Not attached: ${name} is over the ${MAX_ATTACHMENT_MB} MB limit`;
  return null;
}

/** The sentence for a PDF over the API's page cap, or null (`pages` null: not counted). */
export const pageRefusal = (name: string, pages: number | null): string | null =>
  pages !== null && pages > DOCUMENT_MAX_PAGES
    ? `Not attached: ${name} has ${pages} pages, Claude reads up to ${DOCUMENT_MAX_PAGES}`
    : null;

/** Where a file comes from. */
export type ChatFileSource =
  /** Bytes of a paste or a browser drag. */
  | { kind: "file"; file: File }
  /** A Finder file or folder (absolute path): copied into the chat's assets when it is outside the
   *  vault, referenced where it is when it is inside (decided in Rust, `agent_import_chat_file`). */
  | { kind: "path"; path: string }
  /** A vault file or folder (vault-relative path), referenced in place. */
  | { kind: "vault"; path: string; isDir?: boolean };

export type ChatFileIo = {
  projectPath: string | null;
  saveImage(projectPath: string | null, name: string, dataBase64: string): Promise<ChatFile>;
  /** A Finder item of any type: copied into the chat's assets, or, already in the vault, returned
   *  as is (`copied` false). Throws a terse sentence for a secret name, an oversize file or a
   *  folder from outside the vault. */
  importFile(projectPath: string | null, sourcePath: string): Promise<ChatFile>;
  readBase64(file: File): Promise<string>;
  /** Counts a PDF's pages (the `pdf.info` service); absent while the PDF feature is off, then no
   *  page cap is checked and a PDF is sent as is. Throws for a file that is not a readable PDF. */
  pdfPages?: {
    ofBytes(bytes: Uint8Array): Promise<number>;
    /** `path` is vault-relative for a vault file, absolute for a Finder file. */
    ofPath(path: string, kind: "vault" | "path"): Promise<number>;
  };
};

/** What a drop or paste becomes: image and document chips (`refs`, sent as blocks), files and
 *  folders to mention (`mentions`, the same chip as typing `@File`) and the refusals. */
export type AttachResult = {
  refs: ChatFileRef[];
  mentions: MentionTarget[];
  notices: string[];
};

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The page-cap sentence of a PDF source, or null (an image, an uncounted or unreadable PDF: the
 *  counter failing is not a reason to refuse, the size cap already ran). */
async function pagesRefusal(
  name: string,
  count: (() => Promise<number>) | null,
): Promise<string | null> {
  if (!count || !isChatDocumentName(name)) return null;
  try {
    return pageRefusal(name, await count());
  } catch {
    return null;
  }
}

/** The one rule for a vault file or folder that stays where it is: an image or a PDF is a block
 *  chip, anything else (any type, a folder) is an `@` mention. */
function place(out: AttachResult, path: string, isDir: boolean) {
  if (!isDir && isChatFileName(path)) out.refs.push(chatFileRef(path));
  else out.mentions.push({ path, isDir });
}

/** Attaches every source it can; one that cannot (size, pages, secret name, a failed copy) becomes
 *  a notice and never blocks the others. */
export async function attachChatFiles(
  sources: readonly ChatFileSource[],
  io: ChatFileIo,
  now: Date = new Date(),
): Promise<AttachResult> {
  const out: AttachResult = { refs: [], mentions: [], notices: [] };
  for (const source of sources) {
    try {
      if (source.kind === "vault") {
        const name = getFileName(source.path);
        const media = !source.isDir && isChatFileName(name);
        const no = media
          ? (refusal(name, null) ??
            (await pagesRefusal(
              name,
              io.pdfPages ? () => io.pdfPages!.ofPath(source.path, "vault") : null,
            )))
          : null;
        if (no) out.notices.push(no);
        else place(out, source.path, source.isDir === true);
      } else if (source.kind === "path") {
        const name = getFileName(source.path);
        // an image or PDF is checked before anything is copied
        const no = isChatFileName(name)
          ? (refusal(name, null) ??
            (await pagesRefusal(
              name,
              io.pdfPages ? () => io.pdfPages!.ofPath(source.path, "path") : null,
            )))
          : null;
        if (no) out.notices.push(no);
        else {
          const file = await io.importFile(io.projectPath, source.path);
          place(out, file.path, file.isDir);
        }
      } else {
        const { file } = source;
        const ext = extensionForMime(file.type);
        const name = pastedName(file, ext, now);
        const no =
          refusal(name, file.size) ??
          (await pagesRefusal(
            name,
            io.pdfPages
              ? async () => io.pdfPages!.ofBytes(new Uint8Array(await file.arrayBuffer()))
              : null,
          ));
        if (no) out.notices.push(no);
        else
          out.refs.push(
            chatFileRef((await io.saveImage(io.projectPath, name, await io.readBase64(file))).path),
          );
      }
    } catch (e) {
      const why = reason(e);
      out.notices.push(why.startsWith("Not attached") ? why : `Not attached: ${why}`);
    }
  }
  return out;
}

/** A file's own name, or a dated "Pasted image" name when it has none worth keeping (a clipboard
 *  blob is `image.png`) or its type says what it is. */
function pastedName(file: File, ext: string | null, now: Date): string {
  const own = file.name;
  if (!isGenericClipboardName(own) && extensionOf(own) !== "") return own;
  if (file.type === "application/pdf")
    return pastedImageName("pdf", now).replace("image", "document");
  return pastedImageName(ext ?? (extensionOf(own) || "png"), now);
}

/** Standard base64 of a file (the IPC carries a string; Rust decodes it). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The image and PDF files a paste or an HTML5 drop carries (files, then image items of the
 *  clipboard). */
export function chatFilesOfTransfer(data: DataTransfer): File[] {
  const isAttachable = (f: File) =>
    extensionForMime(f.type) !== null || isChatFileName(f.name) || f.type === "application/pdf";
  const files = Array.from(data.files).filter(isAttachable);
  if (files.length > 0) return files;
  const items: File[] = [];
  for (const item of data.items) {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) items.push(file);
  }
  return items;
}
