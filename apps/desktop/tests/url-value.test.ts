// The `url` property type, pure parts: the one predicate pinned by the vectors both languages read
// (`shared/url-vectors.json`, Rust twin `src-tauri/src/url_value.rs`), the chip label, the
// single-or-list edits, the type rules (a row's own type, fit, the vault-inferred type) and the
// conversion. The panel, the Bases cell and the plugin shim have their own tests.
import { describe, expect, test, vi } from "vite-plus/test";
import vectors from "@shared/url-vectors.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { parseProperties, type PropertyRow } from "../src/lib/frontmatter-properties";
import { convertProperty } from "../src/lib/property-conversion";
import {
  effectiveType,
  PROPERTY_TYPES,
  rowFitsType,
  typeOfRow,
  type PropertyTypeInfo,
} from "../src/lib/property-types";
import { addUrl, isUrlRow, removeUrl, urlItems } from "../src/lib/url-property";
import { isUrl, urlHref, urlLabel } from "../src/lib/url-value";

function row(fm: string, key: string): PropertyRow {
  const p = parseProperties(fm);
  if (!p.ok) throw new Error(p.message);
  return p.rows.find((r) => r.key === key)!;
}

describe("the URL predicate", () => {
  test.each(vectors.valid)("$value is a URL opened as $href", ({ value, href }) => {
    expect(urlHref(value)).toBe(href);
    expect(isUrl(value)).toBe(true);
  });
  test.each(vectors.invalid)("%j is not a URL", (value) => {
    expect(urlHref(value)).toBeNull();
    expect(isUrl(value)).toBe(false);
  });
  test("the vectors cover javascript:, ftp:, spaces and a bare domain", () => {
    const bad = vectors.invalid.join("\n");
    expect(bad).toMatch(/javascript:/i);
    expect(bad).toContain("ftp://");
    expect(vectors.invalid.some((v) => /\s/.test(v) && v.trim() !== "")).toBe(true);
    expect(vectors.valid.some((v) => v.href === `https://${v.value}`)).toBe(true);
  });
});

describe("file names are not URLs", () => {
  test("a bare name.ext of a vault file is text, so inference and the row type keep Text", () => {
    for (const name of [
      "notes.md",
      "Paper.pdf",
      "diagram.svg",
      "x.base",
      "board.canvas",
      "photo.png",
    ]) {
      expect(isUrl(name), name).toBe(false);
      expect(typeOfRow(row(`a: ${name}`, "a")), name).toBe("text");
    }
    expect(typeOfRow(row("a:\n  - notes.md\n  - photo.png", "a"))).toBe("multitext");
    expect(typeOfRow(row("a: example.com/docs", "a"))).toBe("url");
    expect(isUrl("example.com/notes.md")).toBe(true);
  });
});

describe("the chip label", () => {
  test("host and path without the scheme and www.", () => {
    expect(urlLabel("https://www.example.com/a/b?x=1")).toBe("example.com/a/b?x=1");
    expect(urlLabel("http://example.com/")).toBe("example.com");
    expect(urlLabel("www.example.com/docs")).toBe("example.com/docs");
    expect(urlLabel("example.com")).toBe("example.com");
    expect(urlLabel("mailto:a@b.co")).toBe("a@b.co");
  });
  test("a value that is not a URL is shown as written", () => {
    expect(urlLabel("not a url")).toBe("not a url");
  });
});

describe("single-or-list edits", () => {
  test("items of a row: the single value, the list, or none", () => {
    expect(urlItems(row("a: x.com", "a"))).toEqual(["x.com"]);
    expect(urlItems(row("a: https://x.com", "a"))).toEqual(["https://x.com"]);
    expect(urlItems(row("a:\n  - x.com\n  - y.org", "a"))).toEqual(["x.com", "y.org"]);
    expect(urlItems(row("a:", "a"))).toEqual([]);
    expect(urlItems(row('a: ""', "a"))).toEqual([]);
  });
  test("which rows the URL field edits: text, list, empty; not a number or a link", () => {
    expect(isUrlRow(row("a: x", "a"))).toBe(true);
    expect(isUrlRow(row("a: [x]", "a"))).toBe(true);
    expect(isUrlRow(row("a:", "a"))).toBe(true);
    expect(isUrlRow(row("a: 3", "a"))).toBe(false);
    expect(isUrlRow(row('a: "[[N]]"', "a"))).toBe(false);
  });
  test("the first URL is a single value, a second makes a list, a list gains an item", () => {
    const apply = (fm: string, url: string) => {
      const r = addUrl(fm, row(fm, "a"), url);
      if (!r.ok) throw new Error(r.error);
      return r.text;
    };
    expect(apply("a:", "example.com")).toBe("a: example.com");
    expect(apply('a: ""', "example.com")).toBe("a: example.com");
    expect(apply("a: example.com", "https://b.org/x")).toBe(
      "a:\n  - example.com\n  - https://b.org/x",
    );
    expect(apply("a:\n  - one.com", "two.com")).toBe("a:\n  - one.com\n  - two.com");
    // text that is no URL is added as typed: marked later, never refused or rewritten
    expect(apply("a:", "just words")).toBe("a: just words");
    const refused = addUrl("a: 3", row("a: 3", "a"), "x.com");
    expect(refused.ok).toBe(false);
  });
  test("removing the only URL empties the property, removing from a list keeps the others", () => {
    const apply = (fm: string, i: number) => {
      const r = removeUrl(fm, row(fm, "a"), i);
      if (!r.ok) throw new Error(r.error);
      return r.text;
    };
    expect(apply("a: example.com", 0)).toBe("a:");
    expect(apply("a:\n  - one.com\n  - two.com", 0)).toBe("a:\n  - two.com");
  });
});

describe("type rules", () => {
  const r = (fm: string, key = "a") => row(fm, key);
  test("a row's own type is url when every value is a URL", () => {
    expect(typeOfRow(r("a: https://x.com"))).toBe("url");
    expect(typeOfRow(r("a: example.com"))).toBe("url");
    expect(typeOfRow(r("a:\n  - x.com\n  - mailto:me@y.org"))).toBe("url");
    expect(typeOfRow(r("a: hello"))).toBe("text");
    expect(typeOfRow(r("a:\n  - x.com\n  - hello"))).toBe("multitext");
    expect(typeOfRow(r("a: []"))).toBe("multitext");
    expect(typeOfRow(r("a:"))).toBe("text");
    // tags and aliases are never url
    expect(typeOfRow(r("tags:\n  - x.com", "tags"))).toBe("tags");
    expect(typeOfRow(r("aliases:\n  - x.com", "aliases"))).toBe("aliases");
  });
  test("url fits a text or list; each value must be a URL", () => {
    expect(rowFitsType(r("a: x.com"), "url")).toBe(true);
    expect(rowFitsType(r("a: https://x.com"), "url")).toBe(true);
    expect(rowFitsType(r("a:\n  - x.com\n  - y.org"), "url")).toBe(true);
    expect(rowFitsType(r("a:"), "url")).toBe(true);
    expect(rowFitsType(r("a: hello"), "url")).toBe(false);
    expect(rowFitsType(r("a:\n  - x.com\n  - hello"), "url")).toBe(false);
    expect(rowFitsType(r("a: 3"), "url")).toBe(false);
    expect(rowFitsType(r('a: "[[N]]"'), "url")).toBe(false);
    expect(rowFitsType(r("a: x.com"), "text")).toBe(true);
  });
  test("the registry entry: label, icon, warning, writer-only", () => {
    expect(PROPERTY_TYPES.url).toMatchObject({
      label: "URL",
      warning: "Not a URL",
      pickable: true,
      writerOnly: true,
    });
    expect(PROPERTY_TYPES.url.icon).not.toBe(PROPERTY_TYPES.relationships.icon);
  });
  const inferred = (type: string): PropertyTypeInfo =>
    ({
      key: "a",
      count: 3,
      types: {},
      type,
      source: "inferred",
      mismatched: 0,
      obsidianType: "text",
      values: [],
      icons: {},
    }) as PropertyTypeInfo;
  test("a vault-inferred url is vault-wide: a lone address among prose stays text", () => {
    expect(effectiveType(r("a: x.com"), inferred("url")).type).toBe("url");
    expect(effectiveType(r("a:"), inferred("url")).type).toBe("url");
    expect(effectiveType(r("a: x.com"), inferred("text")).type).toBe("text");
    expect(effectiveType(r("a:\n  - x.com"), inferred("multitext")).type).toBe("multitext");
    // no index: the row decides
    expect(effectiveType(r("a: x.com"), undefined).type).toBe("url");
    // a recorded type always wins
    expect(effectiveType(r("a: x.com"), { ...inferred("text"), source: "writer" }).type).toBe(
      "text",
    );
  });
});

describe("converting to and from url", () => {
  const to = (fm: string, type: "url" | "text" | "multitext") => {
    const res = convertProperty(fm, row(fm, "a"), type);
    if (!res.ok) throw new Error(res.error);
    return res.text;
  };
  test("to url keeps every value as written, valid or not", () => {
    for (const fm of [
      "a: example.com",
      "a: hello world",
      "a: 3",
      "a:\n  - x.com\n  - hello",
      "a: 2026-01-01",
    ]) {
      expect(to(fm, "url")).toBe(fm);
    }
  });
  test("away from url keeps the text", () => {
    expect(to("a: https://x.com/p", "text")).toBe("a: https://x.com/p");
    expect(to("a:\n  - x.com\n  - y.org", "text")).toBe("a: x.com, y.org");
    expect(to("a: x.com", "multitext")).toBe("a:\n  - x.com");
  });
});
