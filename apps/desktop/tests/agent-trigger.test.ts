import { describe, expect, it } from "vite-plus/test";
import { applyTrigger, findTrigger } from "../src/lib/agent/trigger";

const at = (text: string, caret = text.length, composing = false) =>
  findTrigger(text, caret, composing);

describe("findTrigger", () => {
  it("opens at the start, after spaces and after a newline", () => {
    expect(at("/")).toMatchObject({ char: "/", start: 0, query: "", atStart: true });
    expect(at("/wri")).toMatchObject({ query: "wri", atStart: true });
    expect(at("   /wri")).toMatchObject({ start: 3, atStart: true });
    expect(at("hello\n/x")).toMatchObject({ char: "/", start: 6, query: "x", atStart: false });
    expect(at("see @pl")).toMatchObject({ char: "@", start: 4, query: "pl", atStart: false });
  });

  it("opens in the middle of a sentence and for each trigger in turn", () => {
    const text = "compare @Notes/A.md with @Notes/B and run /sum";
    expect(at(text)).toMatchObject({ char: "/", query: "sum", atStart: false });
    expect(at(text, text.indexOf(" and"))).toMatchObject({ char: "@", query: "Notes/B" });
    expect(at(text, "compare @No".length)).toMatchObject({ char: "@", start: 8, query: "No" });
  });

  it("opens after an opening bracket or quote", () => {
    expect(at("(@pl")).toMatchObject({ char: "@", start: 1, query: "pl" });
    expect(at('say "/co')).toMatchObject({ char: "/", start: 5, query: "co" });
  });

  it("does not open for paths, URLs, emails or and/or", () => {
    expect(at("src/lib/foo")).toBeNull();
    expect(at("see https://x.dev/a/b")).toBeNull();
    expect(at("mail a@b.c")).toBeNull();
    expect(at("this and/or that")).toBeNull();
    expect(at("/usr/bin/env")).toBeNull();
    expect(at("plain text")).toBeNull();
    expect(at("a @@b")).toBeNull();
  });

  it("with the caret inside a token, filters on the text before it and replaces the whole token", () => {
    const text = "x @planning y";
    const t = at(text, "x @pla".length)!;
    expect(t).toMatchObject({ start: 2, end: 11, query: "pla" });
    expect(applyTrigger(text, t, "@Notes/Plan.md")).toEqual({
      text: "x @Notes/Plan.md y",
      caret: "x @Notes/Plan.md ".length,
    });
  });

  it("is not open while an IME composition is running, nor with the caret before the trigger", () => {
    expect(at("/wri", 4, true)).toBeNull();
    expect(at("hi @pl", 2)).toBeNull();
    expect(at("hi @pl", 3)).toBeNull(); // caret right before the `@`
  });
});

describe("applyTrigger", () => {
  it("replaces only the token, adds one trailing space and puts the caret after it", () => {
    const text = "first /su then @no";
    const t = findTrigger(text, "first /su".length)!;
    const r = applyTrigger(text, t, "/summarize-note");
    expect(r.text).toBe("first /summarize-note then @no");
    expect(r.caret).toBe("first /summarize-note ".length);
    const end = applyTrigger("go /s", findTrigger("go /s", 5)!, "/summarize");
    expect(end).toEqual({ text: "go /summarize ", caret: 14 });
  });
});
