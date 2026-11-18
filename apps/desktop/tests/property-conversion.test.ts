// Converting a note's value when its property type changes: every cell of the table in
// `lib/property-conversion.ts`, the refusal states (the value is never changed) and the YAML
// guarantees of the write path (comments, key order, CRLF). Fixtures are synthetic.
import { describe, expect, test } from "vite-plus/test";
import { parseProperties, type PropertyRow } from "../src/lib/frontmatter-properties";
import {
  convertProperty,
  plainLinkCandidates,
  parseDate,
  parseDatetime,
  splitList,
} from "../src/lib/property-conversion";
import type { PropertyType } from "../src/lib/property-types";

function row(fm: string, key: string): PropertyRow {
  const p = parseProperties(fm);
  if (!p.ok) throw new Error(p.message);
  const r = p.rows.find((x) => x.key === key);
  if (!r) throw new Error(`no ${key}`);
  return r;
}
function convert(fm: string, key: string, to: PropertyType): string {
  const r = convertProperty(fm, row(fm, key), to);
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.text;
}
function toLinks(fm: string, key: string, names: Record<string, string> = {}): string {
  const r = convertProperty(fm, row(fm, key), "relationships", names);
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.text;
}
function refused(fm: string, key: string, to: PropertyType): string {
  const r = convertProperty(fm, row(fm, key), to);
  if (r.ok) throw new Error(`converted to ${r.text}`);
  return r.error;
}

describe("to text", () => {
  test("number, checkbox and list become text values", () => {
    expect(convert("n: 3.5", "n", "text")).toBe('n: "3.5"');
    expect(convert("c: true", "c", "text")).toBe('c: "true"');
    expect(convert("l:\n  - a\n  - b", "l", "text")).toBe("l: a, b");
    expect(convert("l: []", "l", "text")).toBe("l:");
  });
  test("a date or link is already text", () => {
    expect(convert("d: 2026-01-02", "d", "text")).toBe("d: 2026-01-02");
    expect(convert('k: "[[A]]"', "k", "text")).toBe('k: "[[A]]"');
  });
});

describe("to list", () => {
  test("text splits on commas, outside wikilinks", () => {
    expect(convert("a: x, y ,, z", "a", "multitext")).toBe("a:\n  - x\n  - y\n  - z");
    expect(convert('a: "[[A, B]], c"', "a", "multitext")).toBe('a:\n  - "[[A, B]]"\n  - c');
    expect(splitList("")).toEqual([]);
  });
  test("tags drop a leading #; a tag string becomes a list", () => {
    expect(convert("a: '#x, #y'", "a", "tags")).toBe("a:\n  - x\n  - y");
    expect(convert("tags: a b", "tags", "multitext")).toBe("tags:\n  - a\n  - b");
  });
  test("a scalar of another kind is one item; empty becomes []", () => {
    expect(convert("n: 3", "n", "multitext")).toBe('n:\n  - "3"');
    expect(convert("e:", "e", "aliases")).toBe("e: []");
    expect(convert('k: "[[A]]"', "k", "multitext")).toBe('k:\n  - "[[A]]"');
  });
  test("list to tags or aliases is already a list", () => {
    expect(convert("l: [a]", "l", "tags")).toBe("l: [a]");
  });
});

describe("to number", () => {
  test("parseable text converts", () => {
    expect(convert("a: '42'", "a", "number")).toBe("a: 42");
    expect(convert("a: ' -1.5 '", "a", "number")).toBe("a: -1.5");
  });
  test("anything else is refused and left alone", () => {
    expect(refused("a: abc", "a", "number")).toBe("Not a number");
    expect(refused("a: 1,5", "a", "number")).toBe("Not a number");
    expect(refused("a: true", "a", "number")).toBe("Not a number");
    expect(refused("l: [1]", "l", "number")).toBe("Not a number");
  });
});

describe("to checkbox", () => {
  test("true/false/yes/no in any case", () => {
    expect(convert("a: Yes", "a", "checkbox")).toBe("a: true");
    expect(convert("a: 'FALSE'", "a", "checkbox")).toBe("a: false");
    expect(convert("a: no", "a", "checkbox")).toBe("a: false");
  });
  test("other text and numbers are refused", () => {
    expect(refused("a: maybe", "a", "checkbox")).toBe("Not true or false");
    expect(refused("a: 1", "a", "checkbox")).toBe("Not true or false");
  });
});

describe("to date and date & time", () => {
  test("common unambiguous formats become ISO", () => {
    expect(parseDate("2026/03/05")).toBe("2026-03-05");
    expect(parseDate("March 5, 2026")).toBe("2026-03-05");
    expect(parseDate("5th Mar 2026")).toBe("2026-03-05");
    expect(parseDate("25/12/2026")).toBe("2026-12-25");
    expect(parseDate("12/25/2026")).toBe("2026-12-25");
    expect(parseDate("2026-03-05 10:30")).toBe("2026-03-05");
  });
  test("ambiguous or invalid dates are refused", () => {
    expect(parseDate("03/04/2026")).toBeNull();
    expect(parseDate("2026-02-31")).toBeNull();
    expect(parseDate("tomorrow")).toBeNull();
    expect(parseDatetime("2026-03-05 25:00")).toBeNull();
  });
  test("text to date / datetime", () => {
    expect(convert("a: 'March 5, 2026'", "a", "date")).toBe("a: 2026-03-05");
    expect(convert("a: '2026-03-05 9:05:33'", "a", "datetime")).toBe("a: 2026-03-05T09:05");
    expect(convert("a: 2026-03-05", "a", "datetime")).toBe("a: 2026-03-05T00:00");
    expect(convert("a: 2026-03-05T10:30", "a", "date")).toBe("a: 2026-03-05");
  });
  test("refusals keep the value", () => {
    expect(refused("a: soon", "a", "date")).toBe("Not a date");
    expect(refused("a: soon", "a", "datetime")).toBe("Not a date and time");
    expect(refused("a: 5", "a", "date")).toBe("Not a date");
  });
});

describe("write-path guarantees", () => {
  test("only the converted property changes; comments, order and CRLF stay", () => {
    const fm = "# top\r\nz: 1\r\na: '7'  # note\r\nb: keep\r\n";
    const out = convert(fm, "a", "number");
    expect(out).toBe("# top\r\nz: 1\r\na: 7  # note\r\nb: keep\r\n");
  });
  test("an unfit already-typed value is a no-op", () => {
    expect(convert("a: 3", "a", "number")).toBe("a: 3");
    expect(convert("e:", "e", "number")).toBe("e:");
  });
  test("values the panel cannot edit are refused", () => {
    expect(refused("m:\n  k: v", "m", "text")).toMatch(/Source/);
    expect(refused("d: {{date}}", "d", "text")).toMatch(/Source/);
  });
});

describe("to relationships", () => {
  test("a link or a list of links already fits and is untouched, shape kept", () => {
    expect(toLinks('a: "[[A]]"', "a")).toBe('a: "[[A]]"');
    expect(toLinks('a:\n  - "[[A|x]]"\n  - "[[f/B#H]]"', "a")).toBe(
      'a:\n  - "[[A|x]]"\n  - "[[f/B#H]]"',
    );
    expect(toLinks("a: []", "a")).toBe("a: []");
    expect(toLinks("a:", "a")).toBe("a:");
  });
  test("text: one [[x]] stays single, [[a]], [[b]] splits into a list", () => {
    expect(toLinks('a: "[[A]], [[B|b]]"', "a")).toBe('a:\n  - "[[A]]"\n  - "[[B|b]]"');
  });
  test("plain text converts only when it resolves by file name, using the file name", () => {
    expect(plainLinkCandidates(row("a: daniel", "a"))).toEqual(["daniel"]);
    expect(toLinks("a: daniel", "a", { daniel: "Daniel Wierdsma" })).toBe(
      'a: "[[Daniel Wierdsma]]"',
    );
    expect(toLinks("a: daniel, [[B]]", "a", { daniel: "Daniel Wierdsma" })).toBe(
      'a:\n  - "[[Daniel Wierdsma]]"\n  - "[[B]]"',
    );
    expect(refused("a: Daniel", "a", "relationships")).toBe("Not a link");
    expect(refused("a: Daniel, [[B]]", "a", "relationships")).toBe("Not a link");
  });
  test("list: every item must be or resolve to a link, and it stays a list", () => {
    expect(toLinks("a:\n  - '[[A]]'\n  - bob", "a", { bob: "Bob" })).toBe(
      'a:\n  - "[[A]]"\n  - "[[Bob]]"',
    );
    expect(toLinks("a:\n  - bob", "a", { bob: "Bob" })).toBe('a:\n  - "[[Bob]]"');
    expect(refused("a:\n  - '[[A]]'\n  - bob", "a", "relationships")).toBe("Not a link");
  });
  test("numbers, checkboxes and dates are refused and left alone", () => {
    for (const fm of ["a: 3", "a: true", "a: 2026-01-01", "a: 2026-01-01T10:00"])
      expect(refused(fm, "a", "relationships")).toBe("Not a link");
  });
  test("comments and key order stay (list writes use the write path's line endings)", () => {
    const fm = '# c\nz: 1\na: "[[A]], [[B]]"  # who\ny: 2';
    expect(toLinks(fm, "a")).toBe('# c\nz: 1\na:\n  - "[[A]]"\n  - "[[B]]"\ny: 2');
  });
});

describe("from relationships", () => {
  test("to text: a list is joined, a single link is already text", () => {
    expect(convert('a:\n  - "[[A]]"\n  - "[[B|b]]"', "a", "text")).toBe('a: "[[A]], [[B|b]]"');
    expect(convert('a: "[[A]]"', "a", "text")).toBe('a: "[[A]]"');
  });
  test("to list: items stay quoted link strings; a single link becomes one item", () => {
    expect(convert('a: "[[A]]"', "a", "multitext")).toBe('a:\n  - "[[A]]"');
    expect(convert('a:\n  - "[[A]]"', "a", "multitext")).toBe('a:\n  - "[[A]]"');
  });
});

describe("object", () => {
  const meta = "metadata:\n  version: 1";
  test("a map is already an object (a flow map too)", () => {
    expect(convert(meta, "metadata", "object")).toBe(meta);
    expect(convert("m: {a: 1}", "m", "object")).toBe("m: {a: 1}");
  });
  test("a map converts to nothing else: edit it in Source", () => {
    for (const to of ["text", "multitext", "number", "relationships"] as const)
      expect(refused(meta, "metadata", to)).toBe(
        "This value cannot be converted here; edit it in Source.",
      );
    expect(refused("m: {a: 1}", "m", "text")).toContain("edit it in Source");
  });
  test("a scalar or list cannot become an object", () => {
    for (const fm of ["a: x", "a: 3", "a: true", "a: [x]"])
      expect(refused(fm, "a", "object")).toBe(
        "This value cannot be converted here; edit it in Source.",
      );
  });
  test("an empty value is unchanged", () => {
    expect(convert("a:", "a", "object")).toBe("a:");
  });
});
