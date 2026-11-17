import { describe, expect, it } from "vite-plus/test";
import {
  applyCandidate,
  callAt,
  complete,
  completionContext,
  inferType,
  isBareIdentifier,
  matchScore,
  quote,
  signatureHelp,
  signatureParams,
  tokenize,
} from "../web/lib/completion";
import { completionEnv } from "./helpers/bases-functions";

const env = completionEnv();

/** Text with `|` marking the caret. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  return { text: marked.replace("|", ""), caret };
}
const ctx = (marked: string, force = false) => {
  const { text, caret } = at(marked);
  return completionContext(text, caret, force);
};
const labels = (marked: string, force = false) => {
  const { text, caret } = at(marked);
  return complete(text, caret, env, { force }).candidates.map((c) => c.label);
};
const apply = (marked: string, label: string, kind?: string) => {
  const { text, caret } = at(marked);
  const c = complete(text, caret, env, { force: true }).candidates.find(
    (x) => x.label === label && (!kind || x.kind === kind),
  );
  if (!c) throw new Error(`no candidate ${label} in ${labels(marked, true).join(",")}`);
  const r = applyCandidate(text, c);
  return `${r.text.slice(0, r.caret)}|${r.text.slice(r.caret)}`;
};

describe("tokenize", () => {
  it("splits identifiers, numbers, strings, punctuation", () => {
    expect(tokenize('a.b("x", 1.5)[0]').map((t) => t.text)).toEqual([
      "a",
      ".",
      "b",
      "(",
      '"x"',
      ",",
      "1.5",
      ")",
      "[",
      "0",
      "]",
    ]);
  });
  it("flags unterminated strings and honours escapes and both quote kinds", () => {
    expect(tokenize('"abc').at(-1)).toMatchObject({ kind: "str", open: true });
    expect(tokenize('"a\\"b"').at(-1)).toMatchObject({ kind: "str", open: false });
    expect(tokenize("'x'").at(-1)).toMatchObject({ kind: "str", open: false });
  });
  it("reads a slash as a regexp only where a value cannot precede", () => {
    expect(tokenize("a / b").map((t) => t.kind)).toEqual(["ident", "op", "ident"]);
    expect(tokenize('x.replace(/a"b/g, "")').some((t) => t.kind === "regex")).toBe(true);
    expect(tokenize("/abc").at(-1)).toMatchObject({ kind: "regex", open: true });
  });
  it("accepts non-ASCII identifiers", () => {
    expect(tokenize("café.é")[0]).toMatchObject({ kind: "ident", text: "café" });
  });
});

describe("completionContext", () => {
  it("is empty for no input unless forced", () => {
    expect(ctx("|")).toEqual({ kind: "none" });
    expect(ctx("a == |")).toEqual({ kind: "none" });
    expect(ctx("|", true)).toMatchObject({ kind: "global", prefix: "" });
  });
  it("completes a bare name", () => {
    expect(ctx("sta|")).toMatchObject({ kind: "global", prefix: "sta", from: 0, to: 3 });
    expect(ctx("x == sta|")).toMatchObject({ kind: "global", prefix: "sta", from: 5 });
  });
  it("completes after a dot with the receiver text", () => {
    expect(ctx("file.na|")).toMatchObject({
      kind: "member",
      prefix: "na",
      receiver: "file",
      receiverFrom: 0,
      from: 5,
    });
    expect(ctx("file.|")).toMatchObject({ kind: "member", prefix: "" });
    expect(ctx("a && status.lo|")).toMatchObject({
      kind: "member",
      receiver: "status",
      receiverFrom: 5,
    });
  });
  it("takes the whole postfix chain as the receiver", () => {
    expect(ctx("file.name.lower().tr|")).toMatchObject({ receiver: "file.name.lower()" });
    expect(ctx('note["a b"].lo|')).toMatchObject({ receiver: 'note["a b"]' });
    expect(ctx("tags[0].|")).toMatchObject({ receiver: "tags[0]" });
    expect(ctx("x + list(1, 2).jo|")).toMatchObject({ receiver: "list(1, 2)", receiverFrom: 4 });
    expect(ctx("(a + b).fo|")).toMatchObject({ receiver: "(a + b)" });
    expect(ctx('"text".up|')).toMatchObject({ receiver: '"text"' });
  });
  it("does not treat a decimal point or a number as a member access", () => {
    expect(ctx("1.|")).toEqual({ kind: "none" });
    expect(ctx("12|")).toEqual({ kind: "none" });
    expect(ctx("1.5|")).toEqual({ kind: "none" });
  });
  it("returns none for a dot after nothing usable", () => {
    expect(ctx("..|")).toEqual({ kind: "none" });
    expect(ctx("+.fo|")).toEqual({ kind: "none" });
  });
  it("does not complete inside strings or regexps", () => {
    expect(ctx('status == "op|')).toEqual({ kind: "none" });
    expect(ctx("status == 'op|")).toEqual({ kind: "none" });
    expect(ctx("x.replace(/ab|")).toEqual({ kind: "none" });
    // a closed string followed by a name completes again
    expect(ctx('"a" + sta|')).toMatchObject({ kind: "global", prefix: "sta" });
  });
  it('completes property names inside note["', () => {
    expect(ctx('note["cr|')).toMatchObject({
      kind: "bracket",
      namespace: "note",
      prefix: "cr",
      from: 5,
    });
    expect(ctx('note["|"]')).toMatchObject({ kind: "bracket", prefix: "", from: 5, to: 8 });
    expect(ctx("note['x|")).toMatchObject({ kind: "bracket" });
    // other brackets and formula[ are not property lookups
    expect(ctx('list["a|')).toEqual({ kind: "none" });
    expect(ctx('formula["a|')).toEqual({ kind: "none" });
  });
});

describe("inferType", () => {
  const t = (s: string) => inferType(s, env);
  it("literals", () => {
    expect(t('"x"')).toBe("string");
    expect(t("'x'")).toBe("string");
    expect(t("42")).toBe("number");
    expect(t("true")).toBe("boolean");
    expect(t("null")).toBe("any");
    expect(t("[1, 2]")).toBe("list");
    expect(t("/a/g")).toBe("regexp");
    expect(t('"open')).toBe("any");
  });
  it("properties by vault type", () => {
    expect(t("status")).toBe("string");
    expect(t("note.due")).toBe("date");
    expect(t("tags")).toBe("list");
    expect(t("priority")).toBe("number");
    expect(t("done")).toBe("boolean");
    expect(t("owner")).toBe("link");
    expect(t("mixed")).toBe("any");
    expect(t("unknown")).toBe("any");
    expect(t('note["creation date"]')).toBe("date");
  });
  it("file fields and methods", () => {
    expect(t("file")).toBe("file");
    expect(t("this")).toBe("file");
    expect(t("file.name")).toBe("string");
    expect(t("file.size")).toBe("number");
    expect(t("file.ctime")).toBe("date");
    expect(t("file.tags")).toBe("list");
    expect(t("file.properties")).toBe("object");
    expect(t("file.nope")).toBe("any");
    expect(t('file.hasTag("a")')).toBe("boolean");
    expect(t("this.file.name")).toBe("string");
    expect(t("this.note.due")).toBe("date");
    expect(t("this.size")).toBe("number");
    expect(t("this.status")).toBe("string");
  });
  it("calls follow the registry return type", () => {
    expect(t("today()")).toBe("date");
    expect(t('date("2024-01-01")')).toBe("date");
    expect(t("file.name.lower()")).toBe("string");
    expect(t('file.name.split("-")')).toBe("list");
    expect(t('file.name.split("-").join(",")')).toBe("string");
    expect(t("now().format('YYYY')")).toBe("string");
    expect(t("status.toString()")).toBe("string");
    expect(t("list(1)")).toBe("list");
    expect(t("if(a, 1, 2)")).toBe("any");
    expect(t("unknownFn()")).toBe("any");
    expect(t("status.nope()")).toBe("any");
  });
  it("same method name on several types: the receiver decides, unknown stays unless unanimous", () => {
    expect(t("status.slice(1)")).toBe("string");
    expect(t("tags.slice(1)")).toBe("list");
    expect(t("mixed.slice(1)")).toBe("any");
    expect(t("mixed.isEmpty()")).toBe("boolean");
  });
  it("fields of values and formulas", () => {
    expect(t("file.name.length")).toBe("number");
    expect(t("due.year")).toBe("number");
    expect(t("formula.age")).toBe("number");
    expect(t("formula.title")).toBe("string");
    expect(t("formula.due_text")).toBe("string");
    expect(t("formula.missing")).toBe("any");
    expect(t('formula["odd name"]')).toBe("number");
  });
  it("is any for anything that is not a plain chain, and terminates on formula cycles", () => {
    expect(t("a + b")).toBe("any");
    expect(t("(a)")).toBe("any");
    expect(t("")).toBe("any");
    expect(t("formula.loop_a")).toBe("any");
    expect(t("status.")).toBe("any");
    expect(t("tags[0]")).toBe("any");
  });
});

describe("matchScore", () => {
  it("orders exact, case-insensitive, prefix, hump, substring, subsequence", () => {
    expect(matchScore("name", "name")).toBe(0);
    expect(matchScore("NAME", "name")).toBe(1);
    expect(matchScore("na", "name")).toBe(2);
    expect(matchScore("NA", "name")).toBe(3);
    expect(matchScore("tag", "hasTag")).toBe(4);
    expect(matchScore("tag", "file_tags")).toBe(4);
    expect(matchScore("ame", "name")).toBe(5);
    expect(matchScore("nme", "name")).toBe(6);
    expect(matchScore("zz", "name")).toBeNull();
    expect(matchScore("", "anything")).toBe(0);
  });
});

describe("identifier helpers", () => {
  it("bare identifiers exclude spaces, hyphens, digits first, and reserved names", () => {
    for (const ok of ["status", "_x", "$y", "due_date", "café", "a1"])
      expect(isBareIdentifier(ok)).toBe(true);
    for (const bad of [
      "my prop",
      "a-b",
      "1a",
      "",
      "file",
      "note",
      "this",
      "formula",
      "true",
      "null",
      "a.b",
    ])
      expect(isBareIdentifier(bad)).toBe(false);
  });
  it("quotes with escapes", () => {
    expect(quote("a b")).toBe('"a b"');
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(quote("a\\b")).toBe('"a\\\\b"');
  });
});

describe("candidates after a dot", () => {
  it("lists file fields and methods after file.", () => {
    const l = labels("file.|");
    expect(l).toEqual(
      expect.arrayContaining(["name", "mtime", "backlinks", "hasTag", "inFolder", "asLink"]),
    );
    expect(l).toContain("toString"); // any-value methods apply to a file too
    expect(l).not.toContain("lower");
    expect(l).not.toContain("format");
  });
  it("filters by the inferred type of the receiver", () => {
    const str = labels("status.|");
    expect(str).toEqual(
      expect.arrayContaining([
        "lower",
        "slice",
        "split",
        "contains",
        "length",
        "toString",
        "isEmpty",
      ]),
    );
    expect(str).not.toContain("format");
    expect(str).not.toContain("map");
    const date = labels("due.|");
    expect(date).toEqual(expect.arrayContaining(["format", "relative", "year", "isEmpty"]));
    expect(date).not.toContain("lower");
    const list = labels("tags.|");
    expect(list).toEqual(expect.arrayContaining(["map", "filter", "join", "contains", "length"]));
    expect(list).not.toContain("trim");
    const num = labels("priority.|");
    expect(num).toEqual(expect.arrayContaining(["round", "toFixed"]));
    expect(labels("owner.|")).toContain("asFile");
    expect(labels("file.properties.|")).toContain("keys");
  });
  it("offers every method when the type is unknown", () => {
    const l = labels("mystery.|");
    expect(l).toEqual(
      expect.arrayContaining(["lower", "format", "map", "hasTag", "asFile", "keys", "toString"]),
    );
  });
  it("puts the receiver's own methods before the any-value methods, and groups them", () => {
    const { text, caret } = at("status.|");
    const { candidates } = complete(text, caret, env);
    const groups = [...new Set(candidates.map((c) => c.group))];
    expect(groups.indexOf("String methods")).toBeLessThan(groups.indexOf("Any value"));
    expect(candidates.find((c) => c.label === "slice")!.detail).toBe(
      "string.slice(start, end?): string",
    );
    expect(candidates.find((c) => c.label === "slice")!.doc).toBe("Part of a string.");
  });
  it("filters and ranks by the typed prefix", () => {
    expect(labels("status.tr|")[0]).toBe("trim");
    expect(labels("status.SL|")[0]).toBe("slice");
    expect(labels("file.nam|")[0]).toBe("name");
    expect(labels("status.zzzz|")).toEqual([]);
  });
  it("completes members of a chain and of formulas", () => {
    expect(labels("file.name.lower().|")).toContain("trim");
    expect(labels("formula.title.|")).toContain("trim");
    expect(labels("formula.age.|")).toContain("round");
    expect(labels('"x".|')).toContain("lower");
    expect(labels("[1, 2].|")).toContain("map");
  });
  it("lists note properties after note. and formulas after formula.", () => {
    expect(labels("note.|")).toEqual(
      expect.arrayContaining(["status", "due", "tags", "priority", "creation date"]),
    );
    expect(labels("note.sta|")[0]).toBe("status");
    const f = labels("formula.|");
    expect(f).toEqual(expect.arrayContaining(["age", "title", "due_text", "odd name"]));
    expect(f).not.toContain("status");
    expect(labels("formula.ag|")).toEqual(["age"]);
  });
  it("lists this.file, this.note, file fields and properties after this.", () => {
    const l = labels("this.|");
    expect(l).toEqual(expect.arrayContaining(["file", "note", "name", "hasTag", "status"]));
    expect(l).not.toContain("creation date"); // not a bare identifier: cannot be written this.x
  });
});

describe("candidates without a dot", () => {
  it("offers namespaces, properties, formulas, functions and keywords by prefix", () => {
    expect(labels("fi|")).toEqual(expect.arrayContaining(["file"]));
    expect(labels("for|")).toContain("formula");
    expect(labels("th|")).toContain("this");
    expect(labels("no|")).toEqual(expect.arrayContaining(["note", "now"]));
    expect(labels("stat|")).toContain("status");
    expect(labels("da|")).toEqual(expect.arrayContaining(["date"]));
    expect(labels("tr|")).toContain("true");
    expect(labels("nu|")).toContain("null");
    expect(labels("fa|")).toContain("false");
    expect(labels("if|")).toContain("if");
  });
  it("offers formulas as formula.name and matches the bare name too", () => {
    expect(labels("ag|")).toContain("formula.age");
  });
  it("ranks properties before functions on equal match quality", () => {
    const { text, caret } = at("d|");
    const kinds = complete(text, caret, env).candidates.map((c) => c.kind);
    expect(kinds.indexOf("property")).toBeLessThan(kinds.indexOf("function"));
  });
  it("lists everything on Ctrl+Space with no prefix, capped", () => {
    const { text, caret } = at("|");
    const all = complete(text, caret, env, { force: true });
    expect(all.candidates.length).toBeGreaterThan(20);
    expect(all.candidates.length).toBeLessThanOrEqual(60);
    expect(complete(text, caret, env, { force: true, limit: 5 }).candidates).toHaveLength(5);
    expect(complete(text, caret, env).candidates).toEqual([]);
  });
  it('lists property names inside note["', () => {
    expect(labels('note["cre|')).toEqual(["creation date"]);
    expect(labels('note["|')).toContain("status");
  });
  it("gives every candidate a unique id", () => {
    const { text, caret } = at("|");
    const ids = complete(text, caret, env, { force: true }).candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("applying a candidate", () => {
  it("completes a zero-argument method with () and the caret after it", () => {
    expect(apply("status.tr|", "trim")).toBe("status.trim()|");
  });
  it("completes a method with arguments with the caret between the parentheses", () => {
    expect(apply("status.sl|", "slice")).toBe("status.slice(|)");
    expect(apply("x + dat|", "date", "function")).toBe("x + date(|)");
    expect(apply("now|", "now")).toBe("now()|");
  });
  it("completes only the name when a call already follows", () => {
    const { text, caret } = at("status.sl|(1)");
    const c = complete(text, caret, env).candidates.find((x) => x.label === "slice")!;
    expect(applyCandidate(text, c)).toEqual({ text: "status.slice(1)", caret: 12 });
  });
  it("replaces the typed prefix only", () => {
    expect(apply("file.na| == 1", "name")).toBe("file.name| == 1");
  });
  it("inserts a namespace with its dot and asks for the next completion", () => {
    const { text, caret } = at("fi|");
    const c = complete(text, caret, env).candidates.find(
      (x) => x.label === "file" && x.kind === "namespace",
    )!;
    expect(c.retrigger).toBe(true);
    expect(applyCandidate(text, c)).toEqual({ text: "file.", caret: 5 });
  });
  it("writes a bare property name when it is an identifier", () => {
    expect(apply("sta|", "status")).toBe("status|");
    expect(apply("note.sta|", "status")).toBe("note.status|");
  });
  it("writes bracket syntax for names with spaces, replacing the namespace", () => {
    expect(apply("cre|", "creation date")).toBe('note["creation date"]|');
    expect(apply("1 + note.cre|", "creation date")).toBe('1 + note["creation date"]|');
    expect(apply('note["cre|', "creation date")).toBe('note["creation date"]|');
    expect(apply('note["cre|"]', "creation date")).toBe('note["creation date"]|');
    expect(apply('note["cre|"] == 1', "creation date")).toBe('note["creation date"]| == 1');
  });
  it("writes note[...] for a property named like a namespace", () => {
    expect(apply("fil|", "file", "property")).toBe('note["file"]|');
  });
  it("writes formula names, with bracket syntax when needed", () => {
    expect(apply("formula.ag|", "age")).toBe("formula.age|");
    expect(apply("ag|", "formula.age")).toBe("formula.age|");
    expect(apply("formula.od|", "odd name")).toBe('formula["odd name"]|');
    expect(apply("od|", "odd name")).toBe('formula["odd name"]|');
  });
  it("escapes quotes in property names", () => {
    const e2 = completionEnv({ properties: [{ key: 'a"b', count: 1, types: { text: 1 } }] });
    const { text, caret } = at("a|");
    const c = complete(text, caret, e2).candidates.find((x) => x.label === 'a"b')!;
    expect(applyCandidate(text, c).text).toBe('note["a\\"b"]');
  });
});

describe("call context and signature help", () => {
  const call = (marked: string) => {
    const { text, caret } = at(marked);
    return callAt(text, caret);
  };
  it("finds the innermost call and the argument index", () => {
    expect(call("date(|")).toEqual({ name: "date", receiver: null, argIndex: 0 });
    expect(call("if(a, |")).toEqual({ name: "if", receiver: null, argIndex: 1 });
    expect(call("if(a, b, |")).toEqual({ name: "if", receiver: null, argIndex: 2 });
    expect(call("status.slice(1, |")).toEqual({ name: "slice", receiver: "status", argIndex: 1 });
    expect(call("file.name.lower().slice(|")).toEqual({
      name: "slice",
      receiver: "file.name.lower()",
      argIndex: 0,
    });
  });
  it("ignores commas in nested brackets, strings and finished calls", () => {
    expect(call("if(a, list(1, 2), |")).toEqual({ name: "if", receiver: null, argIndex: 2 });
    expect(call('if(a, "x,y", |')).toEqual({ name: "if", receiver: null, argIndex: 2 });
    expect(call("if(a, (1 + 2), |")).toEqual({ name: "if", receiver: null, argIndex: 2 });
    expect(call("if(f(1), |")).toEqual({ name: "if", receiver: null, argIndex: 1 });
  });
  it("is null outside a call, after it closes, or inside a list literal", () => {
    expect(call("date|")).toBeNull();
    expect(call("date(x)|")).toBeNull();
    expect(call("(a, |")).toBeNull();
    expect(call("if(a, [1, |")).toBeNull();
  });
  it("splits signature parameters", () => {
    expect(signatureParams("string.slice(start, end?): string").map((p) => p.text)).toEqual([
      "start",
      "end?",
    ]);
    expect(signatureParams("now(): date")).toEqual([]);
    expect(signatureParams("max(...numbers): number").map((p) => p.text)).toEqual(["...numbers"]);
    expect(signatureParams("file(path | file | link): file").map((p) => p.text)).toEqual([
      "path | file | link",
    ]);
    expect(signatureParams("no parens")).toEqual([]);
  });
  it("emphasizes the current argument", () => {
    const help = (marked: string) => {
      const { text, caret } = at(marked);
      return signatureHelp(text, caret, env);
    };
    const h = help("status.slice(1, |")!;
    expect(h.signature).toBe("string.slice(start, end?): string");
    expect(h.activeParam).toBe(1);
    expect(h.segments.find((s) => s.active)!.text).toBe("end?");
    expect(h.segments.map((s) => s.text).join("")).toBe(h.signature);
    expect(help("status.slice(|")!.activeParam).toBe(0);
    // more arguments than parameters: stay on the last
    expect(help("status.slice(1, 2, 3, |")!.activeParam).toBe(1);
    // variadic: every further argument is the variadic one
    expect(help("max(1, 2, 3, |")!.activeParam).toBe(0);
    expect(help("now(|")!.activeParam).toBe(-1);
    expect(help("if(a, |")!.doc).toBe("Conditional.");
  });
  it("picks the overload of the receiver's type", () => {
    const help = (marked: string) => {
      const { text, caret } = at(marked);
      return signatureHelp(text, caret, env)?.signature;
    };
    expect(help("tags.slice(|")).toBe("list.slice(start, end?): list");
    expect(help("status.contains(|")).toBe("string.contains(value): boolean");
    expect(help("mystery.contains(|")).toMatch(/contains\(value\): boolean$/);
  });
  it("is null for unknown functions and outside calls", () => {
    const help = (marked: string) => {
      const { text, caret } = at(marked);
      return signatureHelp(text, caret, env);
    };
    expect(help("nope(|")).toBeNull();
    expect(help("status.nope(|")).toBeNull();
    expect(help("status|")).toBeNull();
    expect(help("status.lower(|")!.activeParam).toBe(-1);
  });
});
