// The grouping behind the footer popover: unique issues, counts, order, case and apostrophes.
import { describe, expect, it } from "vite-plus/test";
import {
  countByKind,
  groupFindings,
  issueKey,
  keyFromSource,
  matchCase,
  encodeSource,
  summarize,
} from "../web/lib/issue-groups";
import type { Finding } from "../web/ipc";

const at = (text: string, word: string, over: Partial<Finding> = {}, from = 0): Finding => {
  const start = text.indexOf(word, from);
  return {
    start,
    end: start + word.length,
    kind: "spelling",
    message: "m",
    replacements: ["a", "b", "c", "d"],
    ruleId: "SpellCheck",
    provider: "harper",
    ...over,
  };
};

describe("groupFindings", () => {
  it("folds case, counts occurrences and keeps up to 3 suggestions", () => {
    const text = "Teh cat and teh dog and TEH bird";
    const groups = groupFindings([at(text, "Teh"), at(text, "teh"), at(text, "TEH")], text);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ text: "Teh", count: 3, replacements: ["a", "b", "c"] });
  });

  it("treats curly and straight apostrophes as one word", () => {
    expect(issueKey("spelling", "x", "Don’t")).toBe(issueKey("spelling", "y", "don't"));
  });

  it("groups grammar by rule and text, and keeps other rules apart", () => {
    const text = "should of and should of and could of";
    const g = (word: string, ruleId: string, from = 0) =>
      at(text, word, { kind: "grammar", ruleId }, from);
    const groups = groupFindings(
      [g("should of", "ShouldOf"), g("should of", "ShouldOf", 5), g("could of", "ShouldOf")],
      text,
    );
    expect(groups.map((x) => [x.text, x.count])).toEqual([
      ["should of", 2],
      ["could of", 1],
    ]);
    expect(groupFindings([g("should of", "ShouldOf"), g("should of", "Other")], text)).toHaveLength(
      2,
    );
  });

  it("orders spelling, grammar, style, then most frequent first", () => {
    const text = "aa bb bb cc dd";
    const groups = groupFindings(
      [
        at(text, "dd", { kind: "style", ruleId: "S" }),
        at(text, "cc", { kind: "grammar", ruleId: "G" }),
        at(text, "aa"),
        at(text, "bb"),
        at(text, "bb", {}, 4),
      ],
      text,
    );
    expect(groups.map((x) => x.text)).toEqual(["bb", "aa", "cc", "dd"]);
    expect(countByKind(groups)).toEqual({ spelling: 3, grammar: 1, style: 1 });
    expect(summarize(groups)).toBe("3 spelling, 1 grammar, 1 style");
  });

  it("recovers the key from a diagnostic source and live text", () => {
    expect(keyFromSource(encodeSource("spelling", "SpellCheck"), "TEH")).toBe(
      issueKey("spelling", "", "teh"),
    );
    expect(keyFromSource("spelling", "x")).toBeNull();
  });
});

describe("matchCase", () => {
  it("follows the case of the original", () => {
    expect(matchCase("teh", "the")).toBe("the");
    expect(matchCase("Teh", "the")).toBe("The");
    expect(matchCase("TEH", "the")).toBe("THE");
    expect(matchCase("tEh", "the")).toBe("the");
    expect(matchCase("A", "an")).toBe("An");
    expect(matchCase("teh", "")).toBe("");
  });
});
