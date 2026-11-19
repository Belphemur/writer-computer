import { describe, expect, test, vi } from "vite-plus/test";
import {
  attachmentLinkTarget,
  embedLine,
  embedText,
  imageUrlsFromTransfer,
  markdownImage,
  relativeVaultPath,
  extensionForMime,
  isGenericClipboardName,
  isDocumentName,
  isImportableImageName,
  pastedImageName,
  vaultRelative,
} from "../src/lib/attachments";
import shared from "../shared/attachments.json";
import { RENDERABLE_IMAGE_EXTENSIONS } from "../src/lib/attachments";
import { parseWikiImageEmbedTarget } from "../src/lib/wiki-links";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("pasted image names", () => {
  test("follow Obsidian's Pasted image YYYYMMDDHHmmss convention in local time", () => {
    expect(pastedImageName("png", new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "Pasted image 20260102030405.png",
    );
    expect(pastedImageName("jpg", new Date(2026, 10, 17, 23, 59, 9))).toBe(
      "Pasted image 20261117235909.jpg",
    );
  });

  test("a browser's generic blob name is not worth keeping", () => {
    for (const name of ["", "image.png", "Image.JPG"])
      expect(isGenericClipboardName(name)).toBe(true);
    for (const name of ["Holiday.png", "image 2.png", "my-image.png"]) {
      expect(isGenericClipboardName(name)).toBe(false);
    }
  });
});

describe("document types", () => {
  test("documentExtensions is the one list of PDFs, recognised by name case-blind", () => {
    expect(shared.documentExtensions).toEqual(["pdf"]);
    for (const ext of shared.documentExtensions) {
      expect(isDocumentName(`a.${ext}`)).toBe(true);
      expect(isDocumentName(`A.${ext.toUpperCase()}`)).toBe(true);
    }
    for (const name of ["a.png", "pdf", ".pdf", "a.pdf.txt", "a.md"]) {
      expect(isDocumentName(name)).toBe(false);
    }
  });

  test("a PDF is not an image: the two lists never overlap", () => {
    for (const ext of shared.documentExtensions) {
      expect(shared.renderExtensions).not.toContain(ext);
      expect(shared.importExtensions).not.toContain(ext);
      expect(isImportableImageName(`a.${ext}`)).toBe(false);
    }
  });
});

describe("image types", () => {
  test("every importable type is recognised by name, others are not", () => {
    for (const ext of shared.importExtensions) expect(isImportableImageName(`a.${ext}`)).toBe(true);
    expect(isImportableImageName("A.PNG")).toBe(true);
    for (const name of ["a.pdf", "a.txt", "png", ".png", "a.md"]) {
      expect(isImportableImageName(name)).toBe(false);
    }
  });

  test("MIME types map to an extension", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("image/x-icon")).toBe("ico");
    expect(extensionForMime("image/tiff")).toBe("tif");
    expect(extensionForMime("text/plain")).toBeNull();
  });

  test("wiki embeds render exactly the renderable list (one list for the viewer, the sidebar and inline images)", () => {
    for (const ext of shared.renderExtensions) {
      expect(parseWikiImageEmbedTarget(`pic.${ext}`)).toBe(`pic.${ext}`);
    }
    expect(RENDERABLE_IMAGE_EXTENSIONS).toEqual(new Set(shared.renderExtensions));
    expect(parseWikiImageEmbedTarget("pic.pdf")).toBeNull();
  });
});

describe("link text", () => {
  test("bare name next to the note or at the vault root, else the vault path", () => {
    expect(attachmentLinkTarget("notes/a.png", "notes")).toBe("a.png");
    expect(attachmentLinkTarget("a.png", "notes/deep")).toBe("a.png");
    expect(attachmentLinkTarget("attachments/a.png", "notes")).toBe("attachments/a.png");
    expect(attachmentLinkTarget("notes/attachments/a.png", "notes")).toBe(
      "notes/attachments/a.png",
    );
  });

  test("standalone windows use the note-relative path as is", () => {
    expect(attachmentLinkTarget("note-assets/a.png", null)).toBe("note-assets/a.png");
  });

  test("one embed per line", () => {
    expect(embedText(["a.png"])).toBe("![[a.png]]");
    expect(embedText(["a.png", "x/b.jpg"])).toBe("![[a.png]]\n![[x/b.jpg]]");
  });

  test("vault-relative paths", () => {
    expect(vaultRelative("/v/notes/a.png", "/v")).toBe("notes/a.png");
    expect(vaultRelative("/v", "/v/")).toBe("");
  });
});

describe("embedLine", () => {
  test("a plain name is a wikilink embed", () => {
    expect(embedLine("notes/a.png", "notes")).toBe("![[a.png]]");
    expect(embedLine("attachments/a b.png", "notes")).toBe("![[attachments/a b.png]]");
  });

  test.each(["[", "]", "|", "#", "^"])(
    "a name holding %s becomes a markdown image with an encoded relative path",
    (ch) => {
      const name = `a${ch}b.png`;
      expect(embedLine(`notes/${name}`, "notes")).toBe(`![](${encodeURIComponent(name)})`);
    },
  );

  test("the path is relative to the note and encoded per segment", () => {
    expect(embedLine("assets/my pics/x#1.png", "notes/deep")).toBe(
      "![](../../assets/my%20pics/x%231.png)",
    );
    expect(embedLine("a#1.png", null)).toBe("![](a%231.png)");
  });

  test("relativeVaultPath", () => {
    expect(relativeVaultPath("", "a/b.png")).toBe("a/b.png");
    expect(relativeVaultPath("a", "a/b.png")).toBe("b.png");
    expect(relativeVaultPath("a/c", "a/b.png")).toBe("../b.png");
    expect(relativeVaultPath("a", "b.png")).toBe("../b.png");
  });

  test("markdownImage encodes spaces and parentheses", () => {
    expect(markdownImage("a b(1).png")).toBe("![](a%20b%281%29.png)");
  });
});

describe("imageUrlsFromTransfer", () => {
  test("an <img> with no text of its own", () => {
    expect(
      imageUrlsFromTransfer(
        "<meta charset='utf-8'><img src='https://x.test/a.png?w=1&amp;h=2'>",
        "",
      ),
    ).toEqual(["https://x.test/a.png?w=1&h=2"]);
  });

  test("html with text is a text paste, not an image", () => {
    expect(imageUrlsFromTransfer("<p>hi</p><img src='https://x.test/a.png'>", "")).toEqual([]);
  });

  test("a uri-list link counts only when it looks like an image; other schemes never", () => {
    const list =
      "# c\r\nhttps://x.test/a.JPG\r\nhttps://x.test/page\r\nfile:///a.png\r\ndata:image/png;base64,AA\r\nhttp://x.test/b.webp";
    expect(imageUrlsFromTransfer("", list)).toEqual([
      "https://x.test/a.JPG",
      "http://x.test/b.webp",
    ]);
  });

  test("the same URL in both formats is listed once", () => {
    expect(
      imageUrlsFromTransfer('<img src="https://x.test/a.png">', "https://x.test/a.png"),
    ).toEqual(["https://x.test/a.png"]);
  });
});
