import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  defaultHideExtensions,
  hideExtension,
  prosemarkMarkdownSyntaxExtensions,
} from "../src/lib/prosemark-core/main";
import {
  BUILTIN_CALLOUTS,
  defaultCalloutTitle,
  isKnownCalloutType,
  parseCalloutHeader,
  resolveCalloutType,
} from "../src/lib/callouts/syntax";
import { CALLOUT_ICON_PATHS, parseCustomIconValue } from "../src/lib/callouts/icons";
import { scanCallouts } from "../src/lib/callouts/tree";
import { withFullParse } from "./helpers/parsed-state";

describe("type table", () => {
  test("every public alias resolves to its canonical type", () => {
    const expected: Record<string, string> = {
      summary: "abstract",
      tldr: "abstract",
      hint: "tip",
      important: "tip",
      check: "success",
      done: "success",
      help: "question",
      faq: "question",
      caution: "warning",
      attention: "warning",
      fail: "failure",
      missing: "failure",
      error: "danger",
      cite: "quote",
    };
    for (const [alias, kind] of Object.entries(expected)) {
      expect(resolveCalloutType(alias)).toBe(kind);
    }
    for (const kind of Object.keys(BUILTIN_CALLOUTS)) expect(resolveCalloutType(kind)).toBe(kind);
  });

  test("case-insensitive, unknown falls back to note", () => {
    expect(resolveCalloutType("WARNING")).toBe("warning");
    expect(resolveCalloutType("TlDr")).toBe("abstract");
    expect(resolveCalloutType("my-custom")).toBe("note");
    expect(isKnownCalloutType("Info")).toBe(true);
    expect(isKnownCalloutType("my-custom")).toBe(false);
  });

  test("default title is the typed name, capitalised", () => {
    expect(defaultCalloutTitle("note")).toBe("Note");
    expect(defaultCalloutTitle("tldr")).toBe("Tldr");
    expect(defaultCalloutTitle("my-custom")).toBe("My-custom");
  });

  test("there is an icon for each of the 13 built-in types", () => {
    expect(Object.keys(CALLOUT_ICON_PATHS).sort()).toEqual(Object.keys(BUILTIN_CALLOUTS).sort());
    expect(Object.keys(BUILTIN_CALLOUTS)).toHaveLength(13);
  });

  test("callouts.css has a colour rule for every type and alias", () => {
    const css = readFileSync(new URL("../src/lib/callouts/callouts.css", import.meta.url), "utf8");
    for (const [kind, aliases] of Object.entries(BUILTIN_CALLOUTS)) {
      for (const name of [kind, ...aliases]) expect(css).toContain(`[data-callout="${name}"]`);
    }
  });
});

describe("parseCalloutHeader", () => {
  test("type only", () => {
    expect(parseCalloutHeader("[!note]")).toEqual({
      type: "note",
      kind: "note",
      metadata: "",
      fold: "",
      title: "",
      titleOffset: 7,
    });
  });

  test("title, with the offset where it starts", () => {
    const h = parseCalloutHeader("[!info]   Heads up  ");
    expect(h).toMatchObject({ type: "info", title: "Heads up", fold: "" });
    expect("[!info]   Heads up  ".slice(h!.titleOffset)).toBe("Heads up  ");
  });

  test("fold markers", () => {
    expect(parseCalloutHeader("[!faq]- Collapsed")).toMatchObject({
      type: "faq",
      kind: "question",
      fold: "-",
      title: "Collapsed",
    });
    expect(parseCalloutHeader("[!tip]+")).toMatchObject({ fold: "+", title: "" });
    expect(parseCalloutHeader("[!tip]+ Open")).toMatchObject({ fold: "+", title: "Open" });
  });

  test("type is lowercased for data-callout, kept for unknown types", () => {
    expect(parseCalloutHeader("[!WARNING] x")).toMatchObject({ type: "warning", kind: "warning" });
    expect(parseCalloutHeader("[!custom-question-type]")).toMatchObject({
      type: "custom-question-type",
      kind: "note",
    });
  });

  test("metadata after a pipe", () => {
    expect(parseCalloutHeader("[!note|nomargin] T")).toMatchObject({
      type: "note",
      metadata: "nomargin",
      title: "T",
    });
  });

  test("markdown stays in the title text", () => {
    expect(parseCalloutHeader("[!note] **bold** and [[Link]] `code`")?.title).toBe(
      "**bold** and [[Link]] `code`",
    );
  });

  test("malformed headers are not callouts", () => {
    expect(parseCalloutHeader("[!]")).toBeNull();
    expect(parseCalloutHeader("[!] x")).toBeNull();
    expect(parseCalloutHeader("[! note]")).toBeNull();
    expect(parseCalloutHeader("[!note")).toBeNull();
    expect(parseCalloutHeader("[!note]Title")).toBeNull();
    expect(parseCalloutHeader("[!note](https://example.com)")).toBeNull();
    expect(parseCalloutHeader("\\[!note] x")).toBeNull();
    expect(parseCalloutHeader("[note]")).toBeNull();
    expect(parseCalloutHeader("note")).toBeNull();
  });
});

describe("parseCustomIconValue", () => {
  test("built-in ids with or without the lucide- prefix", () => {
    expect(parseCustomIconValue("lucide-flame")).toEqual({ kind: "builtin", icon: "tip" });
    expect(parseCustomIconValue(" bug ")).toEqual({ kind: "builtin", icon: "bug" });
    expect(parseCustomIconValue("lucide-alert-circle")).toBeNull();
    expect(parseCustomIconValue("")).toBeNull();
  });

  test("a quoted svg string", () => {
    const v = `'<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>'`;
    expect(parseCustomIconValue(v)).toEqual({
      kind: "svg",
      svg: `<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>`,
    });
    expect(parseCustomIconValue("<img src=x onerror=alert(1)>")).toBeNull();
  });
});

function parse(doc: string): EditorState {
  return withFullParse(
    EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
        defaultHideExtensions,
      ],
    }),
  );
}

describe("scanCallouts", () => {
  test("header, title range, last line and index", () => {
    const doc = "intro\n\n> [!info] Heads **up**\n> line one\n> line two\n\nafter";
    const [c, ...rest] = scanCallouts(parse(doc));
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ index: 0, inList: false });
    expect(c!.header.kind).toBe("info");
    expect(doc.slice(c!.nodeFrom, c!.titleFrom)).toBe("> [!info] ");
    expect(doc.slice(c!.titleFrom, c!.titleTo)).toBe("Heads **up**");
    expect(doc.slice(c!.headerLineFrom, c!.headerLineTo)).toBe("> [!info] Heads **up**");
    expect(doc.slice(c!.headerLineTo, c!.lastLineTo)).toBe("\n> line one\n> line two");
  });

  test("a callout with no body, and no space after `>`", () => {
    const [a] = scanCallouts(parse("> [!note]"));
    expect(a!.lastLineTo).toBe(a!.headerLineTo);
    const [b] = scanCallouts(parse(">[!tip] x"));
    expect(b!.header.kind).toBe("tip");
    expect(">[!tip] x".slice(b!.titleFrom, b!.titleTo)).toBe("x");
  });

  test("plain quotes, malformed headers and escapes are not callouts", () => {
    for (const doc of [
      "> just a quote",
      "> [!]\n> x",
      "> \\[!note] x\n> y",
      "> [!note]Title",
      "> text\n> [!note] later",
      ">\n> [!note] second line",
      "[!note] not quoted",
    ]) {
      expect(scanCallouts(parse(doc)), doc).toEqual([]);
    }
  });

  test("nested callouts and a nested plain quote", () => {
    const doc = "> [!question] Outer\n> > [!todo] Inner\n> > body\n> > > plain\n>\n> tail";
    const found = scanCallouts(parse(doc));
    expect(found.map((c) => [c.index, c.header.type])).toEqual([
      [0, "question"],
      [1, "todo"],
    ]);
    // The inner callout's `>` is its own, after the outer mark.
    expect(doc.slice(found[1]!.nodeFrom, found[1]!.titleFrom)).toBe("> [!todo] ");
    expect(found[1]!.lastLineTo).toBeLessThan(found[0]!.lastLineTo);
  });

  test("a callout inside a list item is found and flagged", () => {
    const [c] = scanCallouts(parse("- item\n  > [!note] In a list\n  > body"));
    expect(c).toMatchObject({ inList: true });
    expect(c!.header.title).toBe("In a list");
  });

  test("callouts are numbered in reading order", () => {
    const found = scanCallouts(parse("> [!note] a\n\n> [!tip] b\n\n> [!bug] c"));
    expect(found.map((c) => c.header.type)).toEqual(["note", "tip", "bug"]);
    expect(found.map((c) => c.index)).toEqual([0, 1, 2]);
  });
});

describe("marker stays raw in the hide extension", () => {
  function hiddenText(doc: string): string[] {
    const state = parse(doc);
    const out: string[] = [];
    state.field(hideExtension).between(0, doc.length, (from, to, deco) => {
      const cls = (deco.spec as { class?: string }).class;
      if (cls === "cm-hidden-token" || cls === "cm-rendered-link") out.push(doc.slice(from, to));
    });
    return out;
  }

  test("`[!note]` brackets are not hidden or styled as a link", () => {
    expect(hiddenText("> [!note] x\n> y")).toEqual([]);
  });

  test("a real link in the title still renders", () => {
    expect(hiddenText("> [!note] see [a](http://x.y)\n> y")).toContain("[a](http://x.y)");
  });
});
