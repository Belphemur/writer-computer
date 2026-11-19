// Reading and writing a drawing file from the editor: the TypeScript codec (`excalidraw-md.ts`)
// is the one write path; this adds what needs the app around it. Images that belong to a
// `.excalidraw.md` are vault files named in `## Embedded Files`: reading turns them into the
// data URLs the canvas needs, and writing saves a newly pasted one to the attachments folder
// (core's `save_attachment`, the path pasted note images take) and references it there. A plain
// `.excalidraw` keeps its images inline, as the standard says.
import { convertFileSrc } from "@tauri-apps/api/core";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentLinkTarget,
  extensionForMime,
  pastedImageName,
  vaultRelative,
} from "@/lib/attachments";
import { resolveVaultLink } from "@/lib/link-activation";
import { getParentDir } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import {
  drawingFormatOf,
  parseDrawing,
  serializeDrawing,
  type ParsedDrawing,
  type SceneElement,
  type SceneFile,
} from "./excalidraw-md";

export interface Loaded {
  parsed: ParsedDrawing;
  /** Every image of the drawing as the canvas wants it: the inline ones and the vault files. */
  files: Record<string, SceneFile>;
}

export interface ImageSource {
  /** The bytes of a vault image as a data URL, or null when the file is missing. */
  dataUrl(
    target: string,
    drawingPath: string,
  ): Promise<{ dataURL: string; mimeType: string } | null>;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

/** The app's image source: resolve the link like a wiki link, read through the asset protocol. */
export const vaultImages: ImageSource = {
  async dataUrl(target, drawingPath) {
    const resolved = await resolveVaultLink(target, drawingPath);
    if (resolved.kind !== "internal") return null;
    const response = await fetch(convertFileSrc(resolved.path));
    if (!response.ok) return null;
    const blob = await response.blob();
    return { dataURL: await blobToDataUrl(blob), mimeType: blob.type || "image/png" };
  },
};

export async function loadDrawingText(
  path: string,
  text: string,
  images: ImageSource = vaultImages,
): Promise<Loaded> {
  const format = drawingFormatOf(path);
  if (!format) throw new Error("not a drawing file");
  const parsed = parseDrawing(text, format);
  const files: Record<string, SceneFile> = { ...parsed.scene.files };
  for (const [id, target] of Object.entries(parsed.embedded)) {
    const image = await images.dataUrl(target, path);
    if (image) files[id] = { id, mimeType: image.mimeType, dataURL: image.dataURL, created: 0 };
  }
  return { parsed, files };
}

export async function loadDrawing(path: string, images?: ImageSource): Promise<Loaded> {
  return loadDrawingText(path, (await tauri.readFile(path)).content, images);
}

function dataUrlBytes(dataURL: string): Uint8Array {
  const comma = dataURL.indexOf(",");
  const binary = atob(dataURL.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What the canvas hands a save. */
export interface Snapshot {
  elements: readonly SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, SceneFile>;
}

export interface Saved {
  /** The drawing as written: the baseline for the next save and the next reload. */
  parsed: ParsedDrawing;
  wrote: boolean;
}

/** Image files a markdown drawing uses that are neither inline nor in `## Embedded Files` yet. */
export function newImageIds(baseline: ParsedDrawing, snapshot: Snapshot): string[] {
  if (baseline.format !== "md") return [];
  const known = new Set([...Object.keys(baseline.embedded), ...Object.keys(baseline.scene.files)]);
  const used = new Set(
    snapshot.elements
      .filter((e) => e.type === "image" && e.isDeleted !== true && typeof e.fileId === "string")
      .map((e) => e.fileId as string),
  );
  return [...used].filter((id) => !known.has(id) && snapshot.files[id]);
}

async function saveNewImage(path: string, id: string, file: SceneFile): Promise<string> {
  const bytes = dataUrlBytes(file.dataURL);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("the image is too large to save");
  const ext = extensionForMime(file.mimeType) ?? "png";
  const saved = await tauri.saveAttachment(path, pastedImageName(ext), bytes);
  const root = getWorkspaceRoot();
  const dirRel = root ? vaultRelative(getParentDir(path), root) : null;
  void id;
  return attachmentLinkTarget(saved.relative_path, dirRel);
}

/** Write the canvas to the file: new images to the attachments folder first, then the text
 *  through the codec, and nothing at all when the file would not change. */
export async function saveDrawing(
  path: string,
  baseline: ParsedDrawing,
  snapshot: Snapshot,
): Promise<Saved> {
  const refs: Record<string, string> = {};
  for (const id of newImageIds(baseline, snapshot)) {
    refs[id] = await saveNewImage(path, id, snapshot.files[id]!);
  }
  const text = serializeDrawing(baseline, {
    scene: {
      ...baseline.scene,
      elements: [...snapshot.elements],
      appState: snapshot.appState,
      files: snapshot.files,
    },
    embedded: { ...baseline.embedded, ...refs },
  });
  if (text === baseline.text) return { parsed: baseline, wrote: false };
  await tauri.writeFile(path, text);
  return { parsed: parseDrawing(text, baseline.format), wrote: true };
}
