/**
 * Images in the agent chat composer (spec `SPECs/native-agent-spec.md`, "Images in the composer").
 * Pure rules plus one attach routine whose IO is injected, so it is testable without a window.
 *
 * - What is accepted: the formats the model reads as an image block (`shared/agent-chat-images.json`,
 *   Rust twin `agent/images.rs`) up to the shared attachment cap (`shared/attachments.json`).
 * - Where it goes: pasted and dropped bytes or Finder files are saved by Rust into the chat
 *   folder's hidden `assets/` (`agent_save_chat_image`, `agent_import_chat_image_file`); an image
 *   dragged from the vault sidebar is referenced where it is, nothing is copied.
 * - What the draft keeps: a `{ kind: "image", path }` ref (vault-relative) per image, shown as a
 *   chip with a thumbnail, sent as a native image block plus a line in `<references>`.
 */
import shared from "@shared/agent-chat-images.json";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  extensionForMime,
  isGenericClipboardName,
  pastedImageName,
} from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import type { ChatImage } from "./chat-history-client";
import type { ContextRef } from "./events";

const MEDIA_TYPES: Readonly<Record<string, string>> = shared.mediaTypes;

/** Rough cost of one image in the context window (the API prices an image by its size, about
 *  `width * height / 750` tokens up to a cap of roughly 1,600). A fixed figure for the chip's
 *  tooltip; the context ring itself counts images once sent, from the CLI's own usage numbers. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

export type ChatImageRef = Extract<ContextRef, { kind: "image" }>;

export const isChatImageRef = (r: ContextRef): r is ChatImageRef => r.kind === "image";

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Does the model read this file name as an image? */
export const isChatImageName = (name: string): boolean => extensionOf(name) in MEDIA_TYPES;

export const imageRef = (path: string): ChatImageRef => ({ kind: "image", path });

/** The sentence for an image that cannot be attached, or null. `size` null: not known yet. */
export function refusal(name: string, size: number | null): string | null {
  if (!isChatImageName(name))
    return `Not attached: ${name || "this file"} is not an image Claude can read (png, jpg, gif, webp)`;
  if (size !== null && size > MAX_ATTACHMENT_BYTES)
    return `Not attached: ${name} is over the ${MAX_ATTACHMENT_MB} MB limit`;
  return null;
}

/** Where an image comes from. */
export type ChatImageSource =
  /** Bytes of a paste or a browser drag. */
  | { kind: "file"; file: File }
  /** A Finder file (absolute path), copied into the chat's assets. */
  | { kind: "path"; path: string }
  /** A vault file (vault-relative path), referenced in place. */
  | { kind: "vault"; path: string };

export type ChatImageIo = {
  projectPath: string | null;
  saveImage(projectPath: string | null, name: string, dataBase64: string): Promise<ChatImage>;
  importImageFile(projectPath: string | null, sourcePath: string): Promise<ChatImage>;
  readBase64(file: File): Promise<string>;
};

export type AttachResult = { refs: ChatImageRef[]; notices: string[] };

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Attaches every source it can; one that cannot (type, size, a failed save) becomes a notice and
 *  never blocks the others. */
export async function attachChatImages(
  sources: readonly ChatImageSource[],
  io: ChatImageIo,
  now: Date = new Date(),
): Promise<AttachResult> {
  const refs: ChatImageRef[] = [];
  const notices: string[] = [];
  for (const source of sources) {
    try {
      if (source.kind === "vault") {
        const no = refusal(getFileName(source.path), null);
        if (no) notices.push(no);
        else refs.push(imageRef(source.path));
      } else if (source.kind === "path") {
        const no = refusal(getFileName(source.path), null);
        if (no) notices.push(no);
        else refs.push(imageRef((await io.importImageFile(io.projectPath, source.path)).path));
      } else {
        const { file } = source;
        const ext = extensionForMime(file.type);
        const name = pastedName(file, ext, now);
        const no = refusal(name, file.size);
        if (no) notices.push(no);
        else
          refs.push(
            imageRef((await io.saveImage(io.projectPath, name, await io.readBase64(file))).path),
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

/** The image files a paste or an HTML5 drop carries (files, then image items of the clipboard). */
export function imageFilesOfTransfer(data: DataTransfer): File[] {
  const isImage = (f: File) => extensionForMime(f.type) !== null || isChatImageName(f.name);
  const files = Array.from(data.files).filter(isImage);
  if (files.length > 0) return files;
  const items: File[] = [];
  for (const item of data.items) {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) items.push(file);
  }
  return items;
}
