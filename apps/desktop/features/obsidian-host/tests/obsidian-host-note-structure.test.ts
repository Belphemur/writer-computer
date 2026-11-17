// The metadata cache's block structure (`sections`, `listItems`, `frontmatterLinks`) and the
// property registry built over it. Invented notes only.
import { describe, expect, it } from "vite-plus/test";
import { parseNoteMetadata } from "../web/host/api/vault";

const NOTE = [
  "---",
  "status: active",
  "related: '[[Beta]]'",
  "---",
  "# Title",
  "",
  "Intro paragraph",
  "continues here.",
  "",
  "- [ ] open task",
  "- [x] done task ^abc123",
  "  - nested bullet",
  "    continuation",
  "- plain",
  "",
  "```js",
  "- not a list",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "> [!note] Callout",
  "> - [ ] quoted task",
].join("\n");

describe("parseNoteMetadata structure", () => {
  const meta = parseNoteMetadata(NOTE);

  it("reports one section per top-level block with line positions", () => {
    expect(meta.sections?.map((s) => [s.type, s.position.start.line, s.position.end.line])).toEqual(
      [
        ["yaml", 0, 3],
        ["heading", 4, 4],
        ["paragraph", 6, 7],
        ["list", 9, 13],
        ["code", 15, 17],
        ["table", 19, 21],
        ["callout", 23, 24],
      ],
    );
  });

  it("reports list items with task character, block id, parent and continuation lines", () => {
    const items = meta.listItems ?? [];
    expect(
      items.map((i) => [i.position.start.line, i.position.end.line, i.task, i.id, i.parent]),
    ).toEqual([
      [9, 9, " ", undefined, -9],
      [10, 10, "x", "abc123", -9],
      [11, 12, undefined, undefined, 10],
      [13, 13, undefined, undefined, -9],
      [24, 24, " ", undefined, -24],
    ]);
  });

  it("does not read list items inside fenced code", () => {
    expect((meta.listItems ?? []).some((i) => i.position.start.line === 16)).toBe(false);
  });

  it("collects wiki links from frontmatter values", () => {
    expect(meta.frontmatterLinks).toEqual([
      { key: "related", link: "Beta", original: "[[Beta]]", displayText: "Beta" },
    ]);
  });

  it("positions agree with the text offsets", () => {
    const task = (meta.listItems ?? [])[1];
    expect(NOTE.slice(task.position.start.offset, task.position.end.offset)).toBe(
      "- [x] done task ^abc123",
    );
  });
});
