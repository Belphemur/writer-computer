// What a PDF link and a PDF embed ask for: `#page=N` and `#height=N`, one grammar for the tab, the
// embed and link activation.
import { describe, expect, it } from "vite-plus/test";
import { linkAnchor, parseWikiLink } from "@/lib/wiki-links";
import { PDF_EMBED_MAX_HEIGHT, PDF_EMBED_MIN_HEIGHT, parsePdfAnchor } from "@/lib/pdf-anchor";
import {
  PDF_EMBED_DEFAULT_HEIGHT,
  parsePdfEmbedLine,
  parsePdfEmbedTarget,
} from "../web/lib/embeds";

describe("pdf anchor", () => {
  it("reads page and height, in either order and with a leading #", () => {
    expect(parsePdfAnchor("page=3")).toEqual({ page: 3, height: null });
    expect(parsePdfAnchor("#page=3&height=600")).toEqual({ page: 3, height: 600 });
    expect(parsePdfAnchor("height=600&page=2")).toEqual({ page: 2, height: 600 });
    expect(parsePdfAnchor("PAGE=7")).toEqual({ page: 7, height: null });
  });

  it("ignores what it does not know and what is not a positive whole number", () => {
    expect(parsePdfAnchor("page=0")).toEqual({ page: null, height: null });
    expect(parsePdfAnchor("page=-2")).toEqual({ page: null, height: null });
    expect(parsePdfAnchor("page=x")).toEqual({ page: null, height: null });
    expect(parsePdfAnchor("page=2.5")).toEqual({ page: null, height: null });
    expect(parsePdfAnchor("selection=1,2,3,4&page=5")).toEqual({ page: 5, height: null });
    expect(parsePdfAnchor("Intro")).toEqual({ page: null, height: null });
    expect(parsePdfAnchor(null)).toEqual({ page: null, height: null });
    expect(parsePdfAnchor("")).toEqual({ page: null, height: null });
  });

  it("keeps an embed's height inside a sane range", () => {
    expect(parsePdfAnchor("height=5").height).toBe(PDF_EMBED_MIN_HEIGHT);
    expect(parsePdfAnchor("height=999999").height).toBe(PDF_EMBED_MAX_HEIGHT);
  });
});

describe("link anchors of a PDF", () => {
  it("a wiki link to a PDF keeps `page=N` as the anchor, and nothing else", () => {
    expect(linkAnchor("paper.pdf", "page=3")).toBe("page=3");
    expect(linkAnchor("papers/Paper.PDF", "page=3&height=9")).toBe("page=3&height=9");
    expect(linkAnchor("paper.pdf", "height=600")).toBeNull();
    expect(linkAnchor("paper.pdf", "Intro")).toBeNull();
    expect(linkAnchor("paper.pdf", null)).toBeNull();
  });

  it("notes still anchor by heading slug and bases by view name", () => {
    expect(linkAnchor("note", "Some Heading")).toBe("some-heading");
    expect(linkAnchor("tasks.base", "Open")).toBe("Open");
  });

  it("the wiki link parser leaves the PDF extension on the path", () => {
    const l = parseWikiLink("paper.pdf#page=3");
    expect(l.path).toBe("paper.pdf");
    expect(l.fragment).toBe("page=3");
  });
});

describe("pdf embeds", () => {
  it("![[x.pdf]] is an embed of the first page at the default height", () => {
    expect(parsePdfEmbedLine("![[paper.pdf]]")).toEqual({
      target: "paper.pdf",
      page: 1,
      height: PDF_EMBED_DEFAULT_HEIGHT,
    });
    expect(PDF_EMBED_DEFAULT_HEIGHT).toBe(480);
  });

  it("opens at #page=N and is as tall as #height=N", () => {
    expect(parsePdfEmbedLine("![[papers/paper.pdf#page=3]]")).toEqual({
      target: "papers/paper.pdf",
      page: 3,
      height: 480,
    });
    expect(parsePdfEmbedLine("![[paper.pdf#height=600]]")!.height).toBe(600);
    expect(parsePdfEmbedLine("![[paper.pdf#page=2&height=700]]")).toMatchObject({
      page: 2,
      height: 700,
    });
  });

  it("allows surrounding blanks and ignores an alias", () => {
    expect(parsePdfEmbedLine("  ![[Paper.PDF|my paper]]  ")?.target).toBe("Paper.PDF");
    expect(parsePdfEmbedTarget("paper.pdf#page=4|x")?.page).toBe(4);
  });

  it("is not an embed unless the line is exactly one embed of a PDF", () => {
    for (const line of [
      "[[paper.pdf]]",
      "text ![[paper.pdf]]",
      "![[paper.pdf]] text",
      "![[note]]",
      "![[image.png]]",
      "![[a.pdf]] ![[b.pdf]]",
      "",
    ]) {
      expect(parsePdfEmbedLine(line), line).toBeNull();
    }
  });
});
