// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";

const saveAttachment = vi.fn();
const importAttachmentFile = vi.fn();
const importAttachmentUrl = vi.fn();
vi.mock("../src/lib/tauri", () => ({
  importAttachmentUrl: (...args: unknown[]) => importAttachmentUrl(...args),
  saveAttachment: (...args: unknown[]) => saveAttachment(...args),
  importAttachmentFile: (...args: unknown[]) => importAttachmentFile(...args),
}));
vi.mock("../src/hooks/workspace-api", () => ({ getWorkspaceRoot: () => "/vault" }));
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { editorClipboardExtension } from "../src/components/editor-area/editor-clipboard";
import {
  dropImagesAt,
  imageFilesOf,
  imageInsertExtension,
  insertImages,
  vaultImageSources,
} from "../src/components/editor-area/editor-image-insert";
import { createOsImageDropHandler } from "../src/components/editor-area/use-os-image-drop";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { flushPromises } from "@tests/helpers/events";

const NOTE = "/vault/notes/a.md";
const views: EditorView[] = [];

function makeView(doc: string, caret = doc.length, disposed = () => false) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        history(),
        editorClipboardExtension(() => NOTE),
        imageInsertExtension(() => NOTE, disposed),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function png(name = "image.png", bytes = [1, 2, 3], type = "image/png") {
  const file = new File([new Uint8Array(bytes)], name, { type });
  // jsdom's Blob predates arrayBuffer() in some versions.
  if (!file.arrayBuffer) {
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.resolve(new Uint8Array(bytes).buffer),
    });
  }
  return file;
}

function fire(view: EditorView, type: "paste" | "drop", data: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, data);
  view.contentDOM.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  saveAttachment.mockReset();
  importAttachmentFile.mockReset();
  importAttachmentUrl.mockReset();
  useEditorNoticeStore.getState().dismissNotice();
});

afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe("paste", () => {
  test("a screenshot is saved as a Pasted image and embedded at the caret", async () => {
    saveAttachment.mockResolvedValue({ relative_path: "attachments/Pasted image 1.png" });
    const view = makeView("hello world", 5);
    const event = fire(view, "paste", {
      clipboardData: { files: [png()], items: [], getData: () => "" },
    });
    expect(event.defaultPrevented).toBe(true);
    await flushPromises();

    expect(saveAttachment).toHaveBeenCalledTimes(1);
    const [note, name, bytes] = saveAttachment.mock.calls[0];
    expect(note).toBe(NOTE);
    expect(name).toMatch(/^Pasted image \d{14}\.png$/);
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
    // The note is in `notes/`, the image in `attachments/`: the vault path is the link.
    expect(view.state.doc.toString()).toBe("hello![[attachments/Pasted image 1.png]] world");
    expect(view.state.selection.main.head).toBe(5 + "![[attachments/Pasted image 1.png]]".length);
  });

  test("a copied image file keeps its name and a sibling resolves by bare name", async () => {
    saveAttachment.mockResolvedValue({ relative_path: "notes/Holiday.JPG" });
    const view = makeView("");
    fire(view, "paste", {
      clipboardData: {
        files: [png("Holiday.JPG", [9], "image/jpeg")],
        items: [],
        getData: () => "",
      },
    });
    await flushPromises();
    expect(saveAttachment.mock.calls[0][1]).toBe("Holiday.JPG");
    expect(view.state.doc.toString()).toBe("![[Holiday.JPG]]");
  });

  test("plain text on the clipboard saves nothing", () => {
    const view = makeView("x");
    fire(view, "paste", { clipboardData: { files: [], items: [], getData: () => "just text" } });
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(importAttachmentFile).not.toHaveBeenCalled();
  });

  test("a screenshot offered only as a clipboard item is found too", async () => {
    saveAttachment.mockResolvedValue({ relative_path: "attachments/s.png" });
    const view = makeView("");
    const file = png();
    fire(view, "paste", {
      clipboardData: {
        files: [],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "",
      },
    });
    await flushPromises();
    expect(view.state.doc.toString()).toBe("![[attachments/s.png]]");
  });

  test("several images insert one per line, as one undo step", async () => {
    saveAttachment
      .mockResolvedValueOnce({ relative_path: "attachments/a.png" })
      .mockResolvedValueOnce({ relative_path: "attachments/b.png" });
    const view = makeView("start");
    fire(view, "paste", {
      clipboardData: { files: [png("a.png"), png("b.png")], items: [], getData: () => "" },
    });
    await flushPromises();
    expect(view.state.doc.toString()).toBe("start![[attachments/a.png]]\n![[attachments/b.png]]");
    undo(view);
    expect(view.state.doc.toString()).toBe("start");
  });

  test("an image over the size cap is refused with a notice and nothing is saved", async () => {
    const view = makeView("x");
    const big = png("big.png");
    Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });
    fire(view, "paste", { clipboardData: { files: [big], items: [], getData: () => "" } });
    await flushPromises();
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("x");
    expect(useEditorNoticeStore.getState().message).toMatch(/60\.0 MB is over the 50 MB limit/);
  });

  test("a failing save reports the Rust message and still inserts the others", async () => {
    saveAttachment
      .mockRejectedValueOnce("Image not saved: 60.0 MB is over the 50 MB limit")
      .mockResolvedValueOnce({ relative_path: "attachments/ok.png" });
    const view = makeView("");
    fire(view, "paste", {
      clipboardData: { files: [png("big.png"), png("ok.png")], items: [], getData: () => "" },
    });
    await flushPromises();
    expect(view.state.doc.toString()).toBe("![[attachments/ok.png]]");
    expect(useEditorNoticeStore.getState().message).toBe(
      "Image not saved: 60.0 MB is over the 50 MB limit",
    );
  });

  test("the insertion point follows edits made while the image saves", async () => {
    let finish!: (v: unknown) => void;
    saveAttachment.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = makeView("ab", 1);
    fire(view, "paste", { clipboardData: { files: [png()], items: [], getData: () => "" } });
    await flushPromises();
    view.dispatch({ changes: { from: 0, insert: "XYZ" } }); // typed before the point
    finish({ relative_path: "attachments/p.png" });
    await flushPromises();
    expect(view.state.doc.toString()).toBe("XYZa![[attachments/p.png]]b");
  });

  test("a slow save shows Saving image… after 200 ms and clears it when done", async () => {
    saveAttachment.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ relative_path: "a/s.png" }), 350)),
    );
    const view = makeView("");
    const done = insertImages(view, [{ kind: "file", file: png() }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(useEditorNoticeStore.getState().message).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(useEditorNoticeStore.getState().message).toBe("Saving image…");
    await done;
    expect(useEditorNoticeStore.getState().message).toBeNull();
    expect(view.state.doc.toString()).toBe("![[a/s.png]]");
  });

  test("nothing is inserted into a view that was disposed meanwhile", async () => {
    let disposed = false;
    saveAttachment.mockResolvedValue({ relative_path: "attachments/p.png" });
    const view = makeView("a", 1, () => disposed);
    fire(view, "paste", { clipboardData: { files: [png()], items: [], getData: () => "" } });
    disposed = true;
    await flushPromises();
    expect(view.state.doc.toString()).toBe("a");
  });
});

function transfer(html: string, uriList = "") {
  return {
    files: [],
    items: [],
    getData: (type: string) =>
      type === "text/html" ? html : type === "text/uri-list" ? uriList : "",
  };
}

describe("remote images (a drag or paste that carries only a link)", () => {
  test("an <img> drag is downloaded in Rust and embedded like a saved image", async () => {
    importAttachmentUrl.mockResolvedValue({ relative_path: "attachments/cat.png" });
    const view = makeView("x", 1);
    const event = fire(view, "drop", {
      dataTransfer: transfer('<img src="https://example.com/cat.png">'),
      clientX: 0,
      clientY: 0,
    });
    expect(event.defaultPrevented).toBe(true);
    await flushPromises();
    expect(importAttachmentUrl).toHaveBeenCalledWith(
      NOTE,
      "https://example.com/cat.png",
      expect.stringMatching(/^Pasted image \d{14}$/),
    );
    expect(view.state.doc.toString()).toContain("![[attachments/cat.png]]");
  });

  test("a refused or failed download inserts a plain markdown image and says why", async () => {
    importAttachmentUrl.mockRejectedValue("Image not downloaded: the server answered 404");
    const view = makeView("");
    fire(view, "paste", {
      clipboardData: transfer("", "https://example.com/a (1).png"),
    });
    await flushPromises();
    expect(view.state.doc.toString()).toBe("![](https://example.com/a%20%281%29.png)");
    expect(useEditorNoticeStore.getState().message).toBe(
      "Image not downloaded: the server answered 404. Inserted a link to the address instead.",
    );
  });

  test("pasted text that merely mentions an image URL is left to the editor", () => {
    const view = makeView("");
    fire(view, "paste", {
      clipboardData: transfer("<p>see this</p>", "https://example.com/page"),
    });
    expect(importAttachmentUrl).not.toHaveBeenCalled();
  });
});

describe("a vault image whose name a wikilink cannot carry", () => {
  test("is inserted as a markdown image with the encoded note-relative path", async () => {
    const view = makeView("");
    const done = insertImages(view, [{ kind: "vault", path: "/vault/assets/a [1] #x.png" }]);
    await done;
    expect(view.state.doc.toString()).toBe("![](../assets/a%20%5B1%5D%20%23x.png)");
  });
});

describe("drops", () => {
  test("a browser drop inserts at the drop point, not the caret", async () => {
    saveAttachment.mockResolvedValue({ relative_path: "attachments/d.png" });
    const view = makeView("0123456789", 10);
    vi.spyOn(view, "posAtCoords").mockReturnValue(4);
    const event = fire(view, "drop", {
      dataTransfer: { files: [png("d.png")], items: [], getData: () => "" },
      clientX: 10,
      clientY: 20,
    });
    expect(event.defaultPrevented).toBe(true);
    await flushPromises();
    expect(saveAttachment.mock.calls[0][1]).toBe("d.png");
    expect(view.state.doc.toString()).toBe("0123![[attachments/d.png]]456789");
  });

  test("non-image files are not image sources (the editor keeps its default behaviour)", () => {
    expect(imageFilesOf([new File(["t"], "n.txt", { type: "text/plain" })])).toEqual([]);
    expect(imageFilesOf([new File(["t"], "n.pdf", { type: "application/pdf" })])).toEqual([]);
    expect(imageFilesOf([png("a.png"), new File(["t"], "n.txt")])).toHaveLength(1);
  });

  test("Finder: image paths are copied by path at the pointer, other files ignored", async () => {
    importAttachmentFile.mockResolvedValue({ relative_path: "attachments/F.png" });
    const view = makeView("0123456789", 0);
    const posAtCoords = vi.spyOn(view, "posAtCoords").mockReturnValue(6);
    document.elementFromPoint = () => view.dom;
    const handle = createOsImageDropHandler(() => 2);
    handle({
      type: "enter",
      paths: ["/Users/me/F.png", "/Users/me/n.txt"],
      position: { x: 40, y: 80 },
    } as never);
    handle({
      type: "drop",
      paths: ["/Users/me/F.png", "/Users/me/n.txt"],
      position: { x: 40, y: 80 },
    } as never);
    await flushPromises();

    expect(importAttachmentFile).toHaveBeenCalledTimes(1);
    expect(importAttachmentFile).toHaveBeenCalledWith(NOTE, "/Users/me/F.png");
    expect(saveAttachment).not.toHaveBeenCalled();
    // Physical pixels become CSS pixels.
    expect(posAtCoords).toHaveBeenCalledWith({ x: 20, y: 40 }, false);
    expect(view.state.doc.toString()).toBe("012345![[attachments/F.png]]6789");
  });

  test("Finder: a drop with no image does nothing", async () => {
    const view = makeView("x");
    document.elementFromPoint = () => view.dom;
    createOsImageDropHandler(() => 1)({
      type: "drop",
      paths: ["/Users/me/doc.pdf"],
      position: { x: 1, y: 1 },
    } as never);
    await flushPromises();
    expect(importAttachmentFile).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("x");
  });

  test("sidebar: a vault image is linked, never copied", async () => {
    const view = makeView("0123456789", 0);
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    document.elementFromPoint = () => view.dom;
    const sources = vaultImageSources([
      { path: "/vault/attachments/logo.png", is_dir: false },
      { path: "/vault/notes/a.md", is_dir: false },
      { path: "/vault/attachments", is_dir: true },
    ]);
    expect(sources).toHaveLength(1);
    expect(dropImagesAt(5, 5, sources)).toBe(true);
    await flushPromises();
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(importAttachmentFile).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("01![[attachments/logo.png]]23456789");
  });

  test("sidebar: an image beside the note is linked by bare name; none over the editor is a miss", async () => {
    const view = makeView("", 0);
    document.elementFromPoint = () => view.dom;
    await insertImages(view, [{ kind: "vault", path: "/vault/notes/pic.png" }]);
    expect(view.state.doc.toString()).toBe("![[pic.png]]");
    document.elementFromPoint = () => document.body;
    expect(dropImagesAt(1, 1, [{ kind: "vault", path: "/vault/x.png" }])).toBe(false);
  });
});
