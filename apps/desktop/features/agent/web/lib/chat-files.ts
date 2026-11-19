/**
 * Files in the agent chat composer, images and PDFs (spec `SPECs/native-agent-spec.md`, "Files in
 * the composer"; `SPECs/pdf-spec.md`, "Agent attachments"). Pure rules plus one attach routine
 * whose IO is injected, so it is testable without a window.
 *
 * - What is accepted: the formats the model reads as an image block or a PDF document block
 *   (`shared/agent-chat-files.json`, Rust twin `agent/files.rs`) up to the shared attachment cap
 *   (`shared/attachments.json`) and, for a PDF, the API's byte and page caps.
 * - Where it goes: pasted and dropped bytes or Finder files are saved by Rust into the chat
 *   folder's hidden `assets/` (`agent_save_chat_file`, `agent_import_chat_file`: the
 *   command names predate PDFs); a file dragged from the vault sidebar is referenced where it is,
 *   nothing is copied.
 * - What the draft keeps: a `{ kind: "image" | "document", path }` ref (vault-relative) per file,
 *   shown as a chip (thumbnail, or a PDF icon with its page count), sent as a native block plus a
 *   line in `<references>`.
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
  /** A Finder file (absolute path), copied into the chat's assets. */
  | { kind: "path"; path: string }
  /** A vault file (vault-relative path), referenced in place. */
  | { kind: "vault"; path: string };

export type ChatFileIo = {
  projectPath: string | null;
  saveImage(projectPath: string | null, name: string, dataBase64: string): Promise<ChatFile>;
  importImageFile(projectPath: string | null, sourcePath: string): Promise<ChatFile>;
  readBase64(file: File): Promise<string>;
  /** Counts a PDF's pages (the `pdf.info` service); absent while the PDF feature is off, then no
   *  page cap is checked and a PDF is sent as is. Throws for a file that is not a readable PDF. */
  pdfPages?: {
    ofBytes(bytes: Uint8Array): Promise<number>;
    /** `path` is vault-relative for a vault file, absolute for a Finder file. */
    ofPath(path: string, kind: "vault" | "path"): Promise<number>;
  };
};

export type AttachResult = { refs: ChatFileRef[]; notices: string[] };

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

/** Attaches every source it can; one that cannot (type, size, pages, a failed save) becomes a
 *  notice and never blocks the others. */
export async function attachChatFiles(
  sources: readonly ChatFileSource[],
  io: ChatFileIo,
  now: Date = new Date(),
): Promise<AttachResult> {
  const refs: ChatFileRef[] = [];
  const notices: string[] = [];
  for (const source of sources) {
    try {
      if (source.kind === "vault" || source.kind === "path") {
        const { kind, path } = source;
        const name = getFileName(path);
        const no =
          refusal(name, null) ??
          (await pagesRefusal(name, io.pdfPages ? () => io.pdfPages!.ofPath(path, kind) : null));
        if (no) notices.push(no);
        else if (kind === "vault") refs.push(chatFileRef(path));
        else refs.push(chatFileRef((await io.importImageFile(io.projectPath, path)).path));
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
        if (no) notices.push(no);
        else
          refs.push(
            chatFileRef((await io.saveImage(io.projectPath, name, await io.readBase64(file))).path),
          );
      }
    } catch (e) {
      notices.push(`Not attached: ${reason(e)}`);
    }
  }
  return { refs, notices };
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
