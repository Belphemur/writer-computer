// Nested property edits (a key inside a property's map): the TS panel splicer pinned to the same
// vectors as the Rust patcher (`src-tauri/src/index/patch/nested.rs`), plus the row model.
import { describe, expect, test } from "vite-plus/test";
import vectors from "@shared/nested-property-vectors.json";
import {
  addNested,
  removeNested,
  renameNested,
  setNested,
  type NestedValue,
} from "../src/lib/frontmatter-nested";
import { parseProperties, type PropertyRow } from "../src/lib/frontmatter-properties";

interface Vector {
  name: string;
  frontmatter: string;
  op: "set" | "add" | "remove" | "rename-key";
  path: string[];
  value?: unknown;
  to?: string;
  expected: string | null;
}

function run(v: Vector) {
  const value = v.value as NestedValue;
  switch (v.op) {
    case "set":
      return setNested(v.frontmatter, v.path, value);
    case "add":
      return addNested(v.frontmatter, v.path, value);
    case "remove":
      return removeNested(v.frontmatter, v.path);
    case "rename-key":
      return renameNested(v.frontmatter, v.path, v.to ?? "");
  }
}

describe("shared nested-property vectors", () => {
  const cases = vectors.cases as Vector[];
  test("the vectors are there", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  for (const v of cases) {
    test(v.name, () => {
      const got = run(v);
      if (v.expected === null) expect(got.ok).toBe(false);
      else expect(got).toEqual({ ok: true, text: v.expected });
    });
  }
});

function rows(text: string): PropertyRow[] {
  const parsed = parseProperties(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.rows;
}

describe("object rows", () => {
  const skill = [
    "name: demo",
    "metadata:",
    "  author: ada",
    "  version: 2",
    "  beta: true",
    "  released: 2026-01-02",
    "  tags: [a, b]",
    "  empty:",
    "  flags:",
    "    on: true",
    "    deep:",
    "      x: 1",
  ].join("\n");

  test("a block map is an editable object row whose keys are rows", () => {
    const meta = rows(skill)[1];
    expect(meta).toMatchObject({ key: "metadata", kind: "object", editable: true });
    expect(meta.entries.map((e) => [e.key, e.kind, e.editable])).toEqual([
      ["author", "text", true],
      ["version", "number", true],
      ["beta", "checkbox", true],
      ["released", "date", true],
      ["tags", "list", true],
      ["empty", "empty", true],
      ["flags", "object", true],
    ]);
    expect(meta.entries[4].items).toEqual(["a", "b"]);
  });

  test("a level-2 map is editable, a map inside it is read-only with its source", () => {
    const flags = rows(skill)[1].entries[6];
    expect(flags.entries.map((e) => [e.key, e.kind, e.editable])).toEqual([
      ["on", "checkbox", true],
      ["deep", "object", false],
    ]);
    expect(flags.entries[1]).toMatchObject({ entries: [], source: "x: 1" });
  });

  test("a key called tags inside a map is a plain list, not tags", () => {
    expect(rows("m:\n  tags: [a]")[0].entries[0].kind).toBe("list");
  });

  test("{} is an editable empty object; a flow map is a read-only object", () => {
    expect(rows("m: {}")[0]).toMatchObject({ kind: "object", editable: true, entries: [] });
    expect(rows("m: {a: 1}")[0]).toMatchObject({
      kind: "object",
      editable: false,
      source: "{a: 1}",
    });
  });

  test("an anchored map and a map with a duplicate key are read-only", () => {
    expect(rows("m: &a\n  x: 1")[0].editable).toBe(false);
    expect(rows("m:\n  x: 1\n  x: 2")[0].editable).toBe(false);
  });

  test("an unquoted placeholder stays a raw row", () => {
    expect(rows("d: {{date}}")[0]).toMatchObject({ kind: "raw", editable: false });
  });
});
