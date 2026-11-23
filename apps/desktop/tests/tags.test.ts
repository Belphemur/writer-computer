// The body-tag recogniser against the shared vectors (`src-tauri/src/index/markdown.rs` reads
// the same file), plus the pieces only the editor and the properties panel use.
import { describe, expect, it } from "vite-plus/test";
import vectors from "@shared/tag-vectors.json";
import { normalizeTag, scanLineTags, scanTags, tagsNotIn } from "../src/lib/tags";

describe("tag vectors", () => {
  for (const { raw, tag } of vectors.normalize) {
    it(`normalizes ${JSON.stringify(raw)}`, () => expect(normalizeTag(raw)).toBe(tag));
  }
  for (const { why, body, tags } of vectors.scan) {
    it(`scans: ${why}`, () => expect(scanTags(body)).toEqual(tags));
  }
});

describe("scanLineTags", () => {
  it("gives the span of each tag, from the # to the end of its text", () => {
    expect(scanLineTags("a #One, (#two/x/) end")).toEqual([
      { from: 2, to: 6, tag: "one" },
      { from: 9, to: 15, tag: "two/x" },
    ]);
  });

  it("keeps offsets after code spans and wiki links", () => {
    const line = "`x` [[a#b]] #t";
    const [t] = scanLineTags(line);
    expect(line.slice(t!.from, t!.to)).toBe("#t");
  });

  it("counts UTF-16 units, so an astral character before the tag does not shift it", () => {
    const line = "😀 #t";
    const [t] = scanLineTags(line);
    expect(line.slice(t!.from, t!.to)).toBe("#t");
  });
});

describe("tagsNotIn", () => {
  it("drops the written tags (any spelling) and repeats, keeping the order", () => {
    expect(tagsNotIn(scanTags("#a #b #B #c"), ["A", "#c"])).toEqual(["b"]);
  });

  it("is empty for a body without tags", () => {
    expect(tagsNotIn(scanTags("nothing here"), ["a"])).toEqual([]);
  });
});
