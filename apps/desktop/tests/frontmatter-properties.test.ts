// The properties model: typed rows from frontmatter text and byte-minimal edits. Every fixture is
// synthetic, shaped after aggregate real-world frontmatter (SPECs/properties-panel-spec.md).
import { describe, expect, test } from "vite-plus/test";
import {
  addProperty,
  appendListItem,
  newTypeFromIndex,
  parseProperties,
  propertyStats,
  removeListItem,
  removeProperty,
  renameProperty,
  resolveCollapsed,
  setScalar,
  setTagString,
  summaryTags,
  type PropertyRow,
} from "../src/lib/frontmatter-properties";

function rows(text: string): PropertyRow[] {
  const parsed = parseProperties(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.rows;
}
function text(result: ReturnType<typeof setScalar>): string {
  if (!result.ok) throw new Error(result.error);
  return result.text;
}
const kinds = (t: string) => Object.fromEntries(rows(t).map((r) => [r.key, r.kind]));

describe("parseProperties kinds", () => {
  test("classifies the common shapes", () => {
    const t = [
      "title: Hello",
      'owner: "[[Some Page]]"',
      "url: https://example.com/a",
      "due: 2026-01-02",
      "when: 2026-01-02T10:30",
      "n: 3",
      "done: true",
      "empty:",
      "tags:",
      "  - a",
      "  - b/c",
      "related: [x, y]",
    ].join("\n");
    expect(kinds(t)).toEqual({
      title: "text",
      owner: "link",
      url: "url",
      due: "date",
      when: "datetime",
      n: "number",
      done: "checkbox",
      empty: "empty",
      tags: "tags",
      related: "list",
    });
  });

  test("space-separated and comma tags strings are tag chips", () => {
    expect(rows("tags: a b/c d")[0]).toMatchObject({ kind: "tagString", items: ["a", "b/c", "d"] });
    expect(rows("tags: a, b")[0]).toMatchObject({ kind: "tagString", items: ["a", "b"] });
  });

  test("an unquoted templater placeholder is a read-only raw row", () => {
    const [row] = rows("date: {{date}}\ntitle: <% tp.file.title %>");
    expect(row).toMatchObject({
      kind: "raw",
      editable: false,
      source: "{{date}}",
      placeholder: true,
    });
    expect(rows("date: {{date}}\ntitle: <% tp.file.title %>")[1]).toMatchObject({
      kind: "text",
      placeholder: true,
    });
  });

  test("nested maps, multi-line strings, unquoted wikilink lists are read-only", () => {
    const t = "meta:\n  a: 1\n  b: two\nnote: |\n  l1\n  l2\nrel: [[Page]]";
    const r = rows(t);
    expect(r[0]).toMatchObject({ kind: "map", editable: false });
    expect(r[0]?.nested).toEqual([
      { key: "a", text: "1" },
      { key: "b", text: "two" },
    ]);
    expect(r[1]).toMatchObject({ kind: "multiline", editable: false });
    expect(r[2]).toMatchObject({ kind: "raw", editable: false });
  });

  test("an empty block and a comment-only block have no rows", () => {
    expect(parseProperties("")).toEqual({ ok: true, rows: [], count: 0 });
    expect(parseProperties("# nothing")).toMatchObject({ ok: true, count: 0 });
  });
});

describe("parseProperties refusals", () => {
  test("unparsable yaml", () => {
    const p = parseProperties("a: [unclosed\nb: 1");
    expect(p).toMatchObject({ ok: false, reason: "unparsable" });
  });
  test("tab indentation is unparsable, not guessed", () => {
    expect(parseProperties("a:\n\t- x")).toMatchObject({ ok: false, reason: "unparsable" });
  });
  test("duplicate keys", () => {
    expect(parseProperties("a: 1\na: 2")).toMatchObject({ ok: false, reason: "duplicate-keys" });
  });
  test("flow mapping root and non-map roots", () => {
    expect(parseProperties("{a: 1}")).toMatchObject({ ok: false, reason: "flow-root" });
    expect(parseProperties("- a\n- b")).toMatchObject({ ok: false, reason: "not-a-map" });
    expect(parseProperties("just text")).toMatchObject({ ok: false, reason: "not-a-map" });
  });
  test("edits on a refused block are refused", () => {
    expect(setScalar("a: 1\na: 2", "a", 3).ok).toBe(false);
    expect(addProperty("a: [unclosed", "b", "x").ok).toBe(false);
  });
});

describe("byte-minimal edits", () => {
  const doc = [
    "# header comment",
    'title: "Hi there" # keep me',
    "status:   draft",
    "",
    "# before tags",
    "tags:",
    "  - x",
    "  - y # note",
    "flow: [a, b]",
    "n: 12",
    "last: yes please",
  ].join("\n");

  test("a scalar edit changes only the value token", () => {
    expect(text(setScalar(doc, "status", "done"))).toBe(doc.replace("draft", "done"));
    expect(text(setScalar(doc, "title", "New"))).toBe(doc.replace('"Hi there"', '"New"'));
    expect(text(setScalar(doc, "n", 13))).toBe(doc.replace("n: 12", "n: 13"));
  });

  test("strings that look like other types are quoted", () => {
    expect(text(setScalar(doc, "status", "true"))).toContain('status:   "true"');
    expect(text(setScalar(doc, "status", "a: b"))).toContain('status:   "a: b"');
  });

  test("an unchanged value returns the text itself", () => {
    expect(text(setScalar(doc, "n", 12))).toBe(doc);
  });

  test("clearing a value leaves `key:` and the comment", () => {
    expect(text(setScalar(doc, "title", null))).toContain("title: # keep me");
  });

  test("filling an empty value inserts after the colon", () => {
    expect(text(setScalar("a:\nb: 1", "a", "x"))).toBe("a: x\nb: 1");
    expect(text(setScalar("a: # c\nb: 1", "a", "x"))).toBe("a: x # c\nb: 1");
  });

  test("a type change replaces only that property's lines", () => {
    expect(text(setScalar(doc, "tags", "solo"))).toBe(
      doc.replace("tags:\n  - x\n  - y # note", "tags: solo"),
    );
  });

  test("add appends one line and removes nothing", () => {
    expect(text(addProperty(doc, "extra", 1))).toBe(`${doc}\nextra: 1`);
    expect(text(addProperty("", "a", "b"))).toBe("a: b");
    expect(text(addProperty("a: 1", "my key", true))).toBe("a: 1\nmy key: true");
    expect(text(addProperty("a: 1", "t", []))).toBe("a: 1\nt: []");
  });

  test("add refuses duplicates and bad names", () => {
    expect(addProperty(doc, "n", 1).ok).toBe(false);
    expect(addProperty(doc, "  ", 1).ok).toBe(false);
    expect(addProperty(doc, "a\nb", 1).ok).toBe(false);
  });

  test("remove drops the property's lines and keeps neighbours and comments", () => {
    expect(text(removeProperty(doc, "status"))).toBe(doc.replace("status:   draft\n", ""));
    expect(text(removeProperty(doc, "tags"))).toBe(doc.replace("tags:\n  - x\n  - y # note\n", ""));
    expect(text(removeProperty(doc, "last"))).toBe(doc.replace("\nlast: yes please", ""));
    expect(text(removeProperty("a: 1", "a"))).toBe("");
  });

  test("rename replaces the key token only", () => {
    expect(text(renameProperty(doc, "status", "state"))).toBe(doc.replace("status:", "state:"));
    expect(renameProperty(doc, "status", "n").ok).toBe(false);
  });

  test("block list append and remove touch one line", () => {
    expect(text(appendListItem(doc, "tags", "z"))).toBe(
      doc.replace("  - y # note", "  - y # note\n  - z"),
    );
    expect(text(removeListItem(doc, "tags", 0))).toBe(doc.replace("  - x\n", ""));
    expect(text(removeListItem(doc, "tags", 1))).toBe(doc.replace("  - y # note\n", ""));
  });

  test("flow list append and remove rewrite only the brackets", () => {
    expect(text(appendListItem(doc, "flow", "c"))).toBe(doc.replace("[a, b]", "[a, b, c]"));
    expect(text(removeListItem(doc, "flow", 0))).toBe(doc.replace("[a, b]", "[b]"));
  });

  test("an empty list or empty value becomes a block list on append", () => {
    expect(text(appendListItem("a: []\nb: 1", "a", "x"))).toBe("a:\n  - x\nb: 1");
    expect(text(appendListItem("a:\nb: 1", "a", "x"))).toBe("a:\n  - x\nb: 1");
  });

  test("a numeric-looking item stays a string", () => {
    expect(text(appendListItem("a:\n  - x", "a", "123"))).toBe('a:\n  - x\n  - "123"');
  });

  test("tags written as one string keep their separator", () => {
    expect(text(setTagString("tags: a b", "tags", ["a", "b", "c"]))).toBe("tags: a b c");
    expect(text(setTagString("tags: a, b", "tags", ["a"]))).toBe("tags: a");
  });

  test("CRLF-free blocks only: a trailing comment on the last item survives a remove", () => {
    expect(text(removeListItem("l:\n  - a # c1\n  - b # c2", "l", 1))).toBe("l:\n  - a # c1");
  });

  test("other properties with placeholders survive edits untouched", () => {
    const t = "date: {{date}}\ntitle: x\nup: <% tp.x %>";
    expect(text(setScalar(t, "title", "y"))).toBe("date: {{date}}\ntitle: y\nup: <% tp.x %>");
    expect(text(removeProperty(t, "title"))).toBe("date: {{date}}\nup: <% tp.x %>");
  });

  test("edit results are idempotent re-parse of the same shape", () => {
    const a = text(addProperty(doc, "extra", "v"));
    const b = text(setScalar(a, "extra", "w"));
    expect(rows(b).find((r) => r.key === "extra")?.value).toBe("w");
    expect(rows(b)).toHaveLength(rows(a).length);
  });
});

describe("collapsed state", () => {
  const stats = (count: number, lines: number) => ({ count, lines });
  test("the user's toggle wins", () => {
    expect(resolveCollapsed(false, "collapsed", stats(50, 50))).toBe(false);
    expect(resolveCollapsed(true, "expanded", stats(1, 1))).toBe(true);
  });
  test("the setting decides when there is no toggle", () => {
    expect(resolveCollapsed(undefined, "collapsed", stats(1, 1))).toBe(true);
    expect(resolveCollapsed(undefined, "expanded", stats(50, 50))).toBe(false);
  });
  test("auto collapses past 6 properties or 8 lines", () => {
    expect(resolveCollapsed(undefined, "auto", stats(6, 8))).toBe(false);
    expect(resolveCollapsed(undefined, "auto", stats(7, 7))).toBe(true);
    expect(resolveCollapsed(undefined, "auto", stats(3, 9))).toBe(true);
  });
  test("stats and summary tags", () => {
    expect(propertyStats("a: 1\nt:\n  - x\n  - y")).toEqual({ count: 2, lines: 4 });
    expect(propertyStats("")).toEqual({ count: 0, lines: 0 });
    expect(summaryTags(rows("t: 1\ntags: [x, y]"))).toEqual(["x", "y"]);
  });
  test("new-property type follows the vault's dominant type", () => {
    expect(newTypeFromIndex({ date: 5, text: 1 }, "when")).toBe("date");
    expect(newTypeFromIndex({}, "Tags")).toBe("tags");
    expect(newTypeFromIndex({ checkbox: 2 }, "x")).toBe("checkbox");
    expect(newTypeFromIndex({ link: 2 }, "x")).toBe("text");
  });
});
