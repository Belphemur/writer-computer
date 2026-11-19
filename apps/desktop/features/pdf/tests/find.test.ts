// Find in a PDF: the page text with its map to the text items, the query pattern, matches (also
// across items and lines), stepping, and marking a rendered text layer.
// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { matchesInPage, pageText, queryPattern, stepIndex, type TextItem } from "../web/lib/find";
import { applyMarks, clearMarks } from "../web/lib/find-marks";
import type { TextLayerHandle } from "../web/lib/pdf-lib";

const items = (...strs: [string, boolean?][]): TextItem[] =>
  strs.map(([str, eol]) => ({ str, hasEOL: !!eol }));

describe("page text", () => {
  it("joins the items and puts a space where a line ends", () => {
    const t = pageText(items(["Hello", true], ["world", false]));
    expect(t.text).toBe("Hello world");
    expect(t.owner).toEqual([0, 0, 0, 0, 0, -1, 1, 1, 1, 1, 1]);
    expect(t.offset.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("adds no space after text that already ends in one", () => {
    expect(pageText(items(["a ", true], ["b"])).text).toBe("a b");
  });
});

describe("query pattern", () => {
  it("is null for a blank query", () => {
    expect(queryPattern("")).toBeNull();
    expect(queryPattern("   ")).toBeNull();
  });

  it("matches case-blind and escapes regular expression characters", () => {
    const p = queryPattern("a.b (c)")!;
    expect("A.B (C) axb (c)".match(p)).toEqual(["A.B (C)"]);
  });

  it("lets any run of white space match any other, a line break included", () => {
    expect("one   two\nthree".match(queryPattern("one two three")!)).toBeTruthy();
  });
});

describe("matches", () => {
  const text = pageText(
    items(["The cat sat. ", false], ["The ", false], ["Cat", true], ["ran", false]),
  );

  it("finds every match in reading order with the characters it covers per item", () => {
    const found = matchesInPage(2, text, queryPattern("cat")!);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ page: 2, spans: [{ item: 0, from: 4, to: 7 }] });
    expect(found[1]).toEqual({ page: 2, spans: [{ item: 2, from: 0, to: 3 }] });
  });

  it("spans items and skips the inserted space", () => {
    const found = matchesInPage(1, text, queryPattern("cat ran")!);
    expect(found).toEqual([
      {
        page: 1,
        spans: [
          { item: 2, from: 0, to: 3 },
          { item: 3, from: 0, to: 3 },
        ],
      },
    ]);
    const across = matchesInPage(1, text, queryPattern("sat. the")!);
    expect(across[0]!.spans.map((s) => s.item)).toEqual([0, 1]);
  });

  it("finds nothing for text that is not there, and is reusable between pages", () => {
    const p = queryPattern("cat")!;
    expect(matchesInPage(1, text, queryPattern("dog")!)).toEqual([]);
    expect(matchesInPage(1, text, p)).toHaveLength(2);
    expect(matchesInPage(2, text, p)).toHaveLength(2);
  });
});

describe("stepping", () => {
  it("goes round, starting at the ends from nothing", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("marking a text layer", () => {
  const layer = (): TextLayerHandle => {
    const strs = ["alpha beta", "gamma"];
    const divs = strs.map((s) => {
      const d = document.createElement("span");
      d.textContent = s;
      return d;
    });
    document.body.replaceChildren(...divs);
    return { items: strs, divs };
  };

  it("wraps the matched characters in marks, the current one flagged", () => {
    const l = layer();
    const first = applyMarks(
      l,
      [
        { page: 1, spans: [{ item: 0, from: 0, to: 5 }] },
        {
          page: 1,
          spans: [
            { item: 0, from: 6, to: 10 },
            { item: 1, from: 0, to: 2 },
          ],
        },
      ],
      1,
    );
    expect(l.divs[0]!.innerHTML).toBe(
      '<mark class="pdf-hit">alpha</mark> <mark class="pdf-hit" data-current="">beta</mark>',
    );
    expect(l.divs[1]!.innerHTML).toBe('<mark class="pdf-hit" data-current="">ga</mark>mma');
    expect(first).toBe(l.divs[0]!.querySelectorAll("mark")[1]);
    // the text is unchanged
    expect(l.divs.map((d) => d.textContent)).toEqual(l.items);
  });

  it("starts from the plain text each time and can clear", () => {
    const l = layer();
    applyMarks(l, [{ page: 1, spans: [{ item: 0, from: 0, to: 5 }] }], 0);
    applyMarks(l, [{ page: 1, spans: [{ item: 1, from: 0, to: 5 }] }], -1);
    expect(l.divs[0]!.querySelector("mark")).toBeNull();
    expect(l.divs[1]!.querySelectorAll("mark")).toHaveLength(1);
    expect(l.divs[1]!.querySelector("[data-current]")).toBeNull();
    clearMarks(l);
    expect(document.querySelector("mark")).toBeNull();
    expect(l.divs.map((d) => d.textContent)).toEqual(l.items);
  });
});
