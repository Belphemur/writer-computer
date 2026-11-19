// Reading and writing a drawing from the editor: a markdown drawing's images are vault files
// (read into data URLs, a newly pasted one saved to the attachments folder and referenced from
// `## Embedded Files`), a plain `.excalidraw` keeps the standard inline `files`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const saveAttachment = vi.hoisted(() =>
  vi.fn(async (_note: string, name: string, _bytes: Uint8Array) => ({
    relative_path: `attachments/${name}`,
  })),
);
const writeFile = vi.hoisted(() => vi.fn(async (_p: string, _c: string) => ({})));
vi.mock("@/lib/tauri", () => ({ saveAttachment, writeFile, readFile: vi.fn() }));
vi.mock("@/hooks/workspace-api", () => ({ getWorkspaceRoot: () => "/v" }));
vi.mock("@/lib/link-activation", () => ({ resolveVaultLink: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

import {
  loadDrawingText,
  newImageIds,
  saveDrawing,
  type ImageSource,
  type Snapshot,
} from "../web/lib/drawing-file";
import { parseDrawing } from "../web/lib/excalidraw-md";

const DIR = resolve(import.meta.dirname, "../../../shared/excalidraw-fixtures");
const read = (name: string) => readFileSync(resolve(DIR, name), "utf8");
const PNG = "data:image/png;base64,iVBORw0KGgo=";

const images: ImageSource = {
  dataUrl: vi.fn(async (target: string) =>
    target === "attachments/pic.png" ? { dataURL: PNG, mimeType: "image/png" } : null,
  ),
};

const imageElement = (fileId: string) => ({
  id: `img-${fileId}`,
  type: "image",
  fileId,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
});

beforeEach(() => {
  saveAttachment.mockClear();
  writeFile.mockClear();
  vi.mocked(images.dataUrl).mockClear();
});

describe("loading", () => {
  it("turns the vault images named in ## Embedded Files into the canvas's files", async () => {
    const loaded = await loadDrawingText(
      "/v/a.excalidraw.md",
      read("compressed.excalidraw.md"),
      images,
    );
    expect(loaded.files["f1e2d3c4b5a6978877665544"]).toMatchObject({
      dataURL: PNG,
      mimeType: "image/png",
    });
    expect(images.dataUrl).toHaveBeenCalledWith("attachments/pic.png", "/v/a.excalidraw.md");
  });

  it("a missing image is not an error: the canvas shows its own placeholder", async () => {
    const text = read("compressed.excalidraw.md").replace("attachments/pic.png", "gone.png");
    const loaded = await loadDrawingText("/v/a.excalidraw.md", text, images);
    expect(loaded.files).toEqual({});
  });

  it("a plain .excalidraw brings its inline images as they are", async () => {
    const loaded = await loadDrawingText("/v/a.excalidraw", read("scene.excalidraw"), images);
    expect(Object.keys(loaded.files)).toEqual(["f1e2d3c4b5a6978877665544"]);
    expect(images.dataUrl).not.toHaveBeenCalled();
  });

  it("refuses a path that is not a drawing", async () => {
    await expect(loadDrawingText("/v/a.md", "x", images)).rejects.toThrow("not a drawing");
  });
});

describe("saving a pasted image", () => {
  const snapshotWith = (parsed: ReturnType<typeof parseDrawing>, fileId: string): Snapshot => ({
    elements: [...parsed.scene.elements, imageElement(fileId)],
    appState: parsed.scene.appState,
    files: { [fileId]: { id: fileId, mimeType: "image/png", dataURL: PNG } },
  });

  it("in a .excalidraw.md it lands in attachments and is listed under ## Embedded Files", async () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const saved = await saveDrawing(
      "/v/Notes/a.excalidraw.md",
      parsed,
      snapshotWith(parsed, "newFile1"),
    );
    expect(saveAttachment).toHaveBeenCalledTimes(1);
    const [note, name, bytes] = saveAttachment.mock.calls[0]!;
    expect(note).toBe("/v/Notes/a.excalidraw.md");
    expect(name).toMatch(/\.png$/);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = writeFile.mock.calls[0]![1];
    expect(text).toContain(`newFile1: [[attachments/${name}]]`);
    expect(text).toContain("f1e2d3c4b5a6978877665544: [[attachments/pic.png]]");
    expect(saved.parsed.embedded.newFile1).toBe(`attachments/${name}`);
    // the image's bytes are the vault file, not inline in the drawing
    expect(saved.parsed.scene.files).toEqual({});
    expect(text).not.toContain(PNG);
  });

  it("is saved once: the next save of the same drawing adds no second file", async () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const first = await saveDrawing("/v/a.excalidraw.md", parsed, snapshotWith(parsed, "newFile1"));
    saveAttachment.mockClear();
    await saveDrawing("/v/a.excalidraw.md", first.parsed, snapshotWith(first.parsed, "newFile1"));
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("in a plain .excalidraw it stays inline, as the standard says, and no file is created", async () => {
    const parsed = parseDrawing(read("scene.excalidraw"), "plain");
    const snap = snapshotWith(parsed, "newFile1");
    snap.files = { ...parsed.scene.files, ...snap.files };
    const saved = await saveDrawing("/v/a.excalidraw", parsed, snap);
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(Object.keys(saved.parsed.scene.files).sort()).toEqual([
      "f1e2d3c4b5a6978877665544",
      "newFile1",
    ]);
    expect(writeFile.mock.calls[0]![1]).toContain("data:image/png");
  });

  it("an unchanged drawing writes nothing", async () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const saved = await saveDrawing("/v/a.excalidraw.md", parsed, {
      elements: parsed.scene.elements,
      appState: parsed.scene.appState,
      files: {},
    });
    expect(saved.wrote).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("finds only the images that have no home yet", () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const snap = snapshotWith(parsed, "newFile1");
    snap.files.f1e2d3c4b5a6978877665544 = {
      id: "f1e2d3c4b5a6978877665544",
      mimeType: "image/png",
      dataURL: PNG,
    };
    expect(newImageIds(parsed, snap)).toEqual(["newFile1"]);
    expect(newImageIds(parseDrawing(read("scene.excalidraw"), "plain"), snap)).toEqual([]);
  });
});
