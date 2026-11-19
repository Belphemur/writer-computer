// The TypeScript codec of drawing files against the shared fixtures (`shared/excalidraw-fixtures`,
// the Rust twin `features/excalidraw/rust/excalidraw_md.rs` reads the same files): both encodings read,
// an unchanged drawing writes back byte for byte, a changed one keeps the front matter, unknown
// sections and the encoding, regenerates `## Text Elements` and extends `## Embedded Files`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import LZString from "lz-string";
import { describe, expect, it } from "vite-plus/test";
import {
  newDrawingText,
  parseDrawing,
  serializeDrawing,
  shortenTextIds,
  type ParsedDrawing,
  type SceneElement,
} from "../web/lib/excalidraw-md";

const DIR = resolve(import.meta.dirname, "../../../shared/excalidraw-fixtures");
const read = (name: string) => readFileSync(resolve(DIR, name), "utf8");
const expected = JSON.parse(read("expected.json"));
const MD = Object.keys(expected.files) as string[];

const textElement = (id: string, text: string): SceneElement => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  text,
  originalText: text,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
});

function withElement(parsed: ParsedDrawing, el: SceneElement) {
  return {
    scene: { ...parsed.scene, elements: [...parsed.scene.elements, el] },
    embedded: parsed.embedded,
  };
}

describe("reading the fixtures", () => {
  for (const name of MD) {
    it(`${name} parses to the expected drawing`, () => {
      const parsed = parseDrawing(read(name), "md");
      expect(parsed.encoding).toBe(expected.files[name].encoding);
      const ids = parsed.scene.elements.map((e) => e.id);
      expect(ids).toEqual(name.startsWith("empty") ? [] : expected.elementIds);
      expect(parsed.embedded).toEqual(expected.files[name].embedded ? expected.embeddedFiles : {});
      expect(parsed.scene.files).toEqual({});
    });
  }

  it("a plain .excalidraw keeps its inline images", () => {
    const parsed = parseDrawing(read("scene.excalidraw"), "plain");
    expect(parsed.scene.elements.map((e) => e.id)).toEqual(expected.elementIds);
    expect(Object.keys(parsed.scene.files)).toEqual(
      expected.plain["scene.excalidraw"].inlineFileIds,
    );
    expect(parsed.embedded).toEqual({});
  });

  it("the lz-string vectors the Rust port is held to decode here too", () => {
    const { vectors } = JSON.parse(read("lz-vectors.json")) as {
      vectors: { text: string; base64: string }[];
    };
    for (const v of vectors) {
      expect(LZString.compressToBase64(v.text)).toBe(v.base64);
      if (v.text) expect(LZString.decompressFromBase64(v.base64)).toBe(v.text);
    }
  });

  it("reads text a tool stripped from the elements out of ## Text Elements", () => {
    const parsed = parseDrawing(read("plain-json.excalidraw.md"), "md");
    const stripped = JSON.parse(JSON.stringify(parsed.scene));
    for (const e of stripped.elements) if (e.type === "text") e.text = e.originalText = "";
    const body = JSON.stringify(stripped, null, "\t");
    const text = read("plain-json.excalidraw.md").replace(
      /```json\n[\s\S]*\n```/,
      `\`\`\`json\n${body}\n\`\`\``,
    );
    const again = parseDrawing(text, "md");
    const texts = again.scene.elements.filter((e) => e.type === "text").map((e) => e.text);
    expect(texts).toEqual(["Hello world", "See [[Meeting notes]]\nsecond line"]);
  });

  it("refuses a file without a drawing block or with data it cannot read", () => {
    expect(() => parseDrawing("# just a note\n", "md")).toThrow("no ## Drawing block");
    expect(() => parseDrawing("%%\n## Drawing\n```json\n[]\n```\n%%\n", "md")).toThrow(
      "no elements",
    );
    expect(() => parseDrawing("%%\n## Drawing\n```compressed-json\n!!!\n```\n%%\n", "md")).toThrow(
      "could not be read",
    );
    expect(() => parseDrawing("not json", "plain")).toThrow("not a drawing");
  });
});

describe("writing", () => {
  for (const name of [...MD, "scene.excalidraw"]) {
    it(`${name} unchanged is written back byte for byte`, () => {
      const text = read(name);
      const format = name.endsWith(".md") ? "md" : "plain";
      const parsed = parseDrawing(text, format);
      expect(serializeDrawing(parsed, { scene: parsed.scene, embedded: parsed.embedded })).toBe(
        text,
      );
    });
  }

  it("a change regenerates only the text elements and the drawing block", () => {
    const text = read("unknown-sections.excalidraw.md");
    const parsed = parseDrawing(text, "md");
    const out = serializeDrawing(parsed, withElement(parsed, textElement("newTEXT1", "Fresh")));

    // everything before the text section is the same bytes: user notes, banner, front matter
    const head = (t: string) => t.slice(0, t.indexOf("## Text Elements"));
    expect(head(out)).toBe(head(text));
    // the unknown section and the embedded files are untouched, trailing spaces included
    const middle = (t: string) =>
      t.slice(t.indexOf("## Reviewer comments"), t.indexOf("%%\n## Drawing"));
    expect(middle(out)).toBe(middle(text));
    expect(out).toContain("Keep this line exactly, with trailing spaces:   \n");
    // the text section lists every text element, the new one last
    expect(out).toContain(
      `## Text Elements\n${expected.textElements}Fresh ^newTEXT1\n\n## Reviewer comments`,
    );
    // the encoding and the fence tag stay
    expect(out).toContain("```compressed-json\n");
    // and it reads back with the new element
    const again = parseDrawing(out, "md");
    expect(again.scene.elements.map((e) => e.id)).toEqual([...expected.elementIds, "newTEXT1"]);
  });

  it("keeps the json encoding of a json drawing", () => {
    const parsed = parseDrawing(read("plain-json.excalidraw.md"), "md");
    const out = serializeDrawing(parsed, withElement(parsed, textElement("newTEXT1", "Fresh")));
    expect(out).toContain("```json\n{");
    expect(parseDrawing(out, "md").encoding).toBe("json");
  });

  it("wraps the compressed block at 256 characters, a blank line between rows", () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const out = serializeDrawing(
      parsed,
      withElement(parsed, textElement("newTEXT1", "x".repeat(900))),
    );
    const block = out.split("```compressed-json\n")[1]!.split("\n```")[0]!.split("\n\n");
    expect(block.length).toBeGreaterThan(2);
    for (const row of block.slice(0, -1)) expect(row).toHaveLength(256);
    expect(block.at(-1)!.length).toBeLessThanOrEqual(256);
  });

  it("drops deleted elements and their text", () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const scene = {
      ...parsed.scene,
      elements: parsed.scene.elements.map((e) =>
        e.id === "textDDDD" ? { ...e, isDeleted: true } : e,
      ),
    };
    const out = serializeDrawing(parsed, { scene, embedded: parsed.embedded });
    expect(out).not.toContain("Meeting notes");
    expect(parseDrawing(out, "md").scene.elements.map((e) => e.id)).not.toContain("textDDDD");
  });

  it("adds an image reference to ## Embedded Files, keeping the ones there", () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const file = { id: "newFILE1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" };
    const image = { id: "imgNEW", type: "image", fileId: "newFILE1", isDeleted: false };
    const out = serializeDrawing(parsed, {
      scene: {
        ...parsed.scene,
        elements: [...parsed.scene.elements, image],
        files: { newFILE1: file },
      },
      embedded: { ...parsed.embedded, newFILE1: "attachments/new image.png" },
    });
    expect(out).toContain(
      "## Embedded Files\nf1e2d3c4b5a6978877665544: [[attachments/pic.png]]\n\nnewFILE1: [[attachments/new image.png]]\n\n%%",
    );
    const again = parseDrawing(out, "md");
    expect(again.embedded).toEqual({
      ...expected.embeddedFiles,
      newFILE1: "attachments/new image.png",
    });
    // the image's data is not inline: it is the vault file
    expect(again.scene.files).toEqual({});
  });

  it("creates the section when the drawing had none", () => {
    const parsed = parseDrawing(read("empty.excalidraw.md"), "md");
    const out = serializeDrawing(parsed, {
      scene: parsed.scene,
      embedded: { fileA: "attachments/a.png" },
    });
    expect(out).toContain("## Embedded Files\nfileA: [[attachments/a.png]]\n\n%%\n## Drawing");
    expect(parseDrawing(out, "md").embedded).toEqual({ fileA: "attachments/a.png" });
  });

  it("refuses to write an image that is neither inline nor a vault file", () => {
    const parsed = parseDrawing(read("empty.excalidraw.md"), "md");
    const file = { id: "lost", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" };
    expect(() =>
      serializeDrawing(parsed, {
        scene: {
          ...parsed.scene,
          elements: [{ id: "i", type: "image", fileId: "lost" }],
          files: { lost: file },
        },
        embedded: {},
      }),
    ).toThrow("not saved as a vault file");
  });

  it("a plain .excalidraw keeps images inline, as the standard says", () => {
    const parsed = parseDrawing(read("scene.excalidraw"), "plain");
    const out = serializeDrawing(parsed, withElement(parsed, textElement("newTEXT1", "Fresh")));
    const again = parseDrawing(out, "plain");
    expect(Object.keys(again.scene.files)).toEqual(["f1e2d3c4b5a6978877665544"]);
    expect(again.scene.files["f1e2d3c4b5a6978877665544"]!.dataURL).toMatch(/^data:image\/png/);
    expect(out).not.toContain("## ");
    expect(out).toContain('\n  "elements"');
  });

  it("keeps CRLF line endings", () => {
    const crlf = read("unknown-sections.excalidraw.md").replace(/\n/g, "\r\n");
    const parsed = parseDrawing(crlf, "md");
    expect(parsed.scene.elements).toHaveLength(5);
    expect(serializeDrawing(parsed, { scene: parsed.scene, embedded: parsed.embedded })).toBe(crlf);
    const out = serializeDrawing(parsed, withElement(parsed, textElement("newTEXT1", "Fresh")));
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseDrawing(out, "md").scene.elements).toHaveLength(6);
  });

  it("gives a long text id the eight characters the plugin looks for, and every reference follows", () => {
    const parsed = parseDrawing(read("compressed.excalidraw.md"), "md");
    const longId = "abcdefghijklmnopqrstu";
    const box = {
      id: "boxONE01",
      type: "rectangle",
      boundElements: [{ id: longId, type: "text" }],
    };
    const label = { ...textElement(longId, "Long id"), containerId: "boxONE01" };
    const out = serializeDrawing(parsed, {
      scene: { ...parsed.scene, elements: [...parsed.scene.elements, box, label] },
      embedded: parsed.embedded,
    });
    expect(out).toContain("Long id ^abcdefgh\n");
    expect(out).not.toContain(longId);
    const again = parseDrawing(out, "md").scene.elements;
    expect(again.find((e) => e.id === "abcdefgh")!.containerId).toBe("boxONE01");
    expect(again.find((e) => e.id === "boxONE01")!.boundElements).toEqual([
      { id: "abcdefgh", type: "text" },
    ]);
    expect(shortenTextIds(parsed.scene.elements)).toEqual(parsed.scene.elements);
  });

  it("element links are listed under ## Element Links with eight-character ids, in step with the Rust codec", () => {
    const parsed = parseDrawing(read("empty.excalidraw.md"), "md");
    const longId = "abcdefghijklmnopqrstu";
    const box = (id: string, link: string | null): SceneElement => ({
      id,
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      link,
    });
    const scene = (elements: SceneElement[]) => ({
      scene: { ...parsed.scene, elements },
      embedded: parsed.embedded,
    });
    const out = serializeDrawing(
      parsed,
      scene([box(longId, "[[Plan]]"), box("plain001", null), box("shortid1", "[[Other]]")]),
    );
    // the linked element took the short id, the unlinked one kept its own
    expect(out).toContain("## Element Links\nabcdefgh: [[Plan]]\n\nshortid1: [[Other]]\n\n%%\n");
    const again = parseDrawing(out, "md");
    expect(again.scene.elements.map((e) => e.id)).toEqual(["abcdefgh", "plain001", "shortid1"]);
    expect(again.scene.elements[0]!.link).toBe("[[Plan]]");
    // unchanged: byte for byte; a changed link regenerates the section; no link removes it
    expect(serializeDrawing(again, { scene: again.scene, embedded: again.embedded })).toBe(out);
    const relinked = serializeDrawing(
      again,
      scene([box("abcdefgh", "[[Plan B]]"), box("plain001", null), box("shortid1", null)]),
    );
    expect(relinked).toContain("## Element Links\nabcdefgh: [[Plan B]]\n\n%%\n");
    expect(relinked).not.toContain("shortid1:");
    const none = serializeDrawing(
      parseDrawing(relinked, "md"),
      scene([box("abcdefgh", null), box("plain001", null)]),
    );
    expect(none).not.toContain("Element Links");
    expect(parseDrawing(none, "md").scene.elements).toHaveLength(2);
  });

  it("a new drawing is an empty .excalidraw.md in the plugin's shape", () => {
    const text = newDrawingText();
    expect(text.startsWith("---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n")).toBe(
      true,
    );
    expect(text).toContain(
      "# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n```compressed-json\n",
    );
    const parsed = parseDrawing(text, "md");
    expect(parsed.scene.elements).toEqual([]);
    expect(serializeDrawing(parsed, { scene: parsed.scene, embedded: {} })).toBe(text);
    expect(parseDrawing(newDrawingText("plain"), "plain").scene.elements).toEqual([]);
  });
});
