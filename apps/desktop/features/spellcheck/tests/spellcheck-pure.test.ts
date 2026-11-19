// The pure parts of the web half: diagnostics, the language property edit, language names and the
// settings readers (including which checker runs next to LanguageTool).
// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setRunningCommunityPlugins } from "@/lib/community-plugins";
import { toDiagnostics, MAX_REPLACEMENTS } from "../web/editor/diagnostics";
import { languagePropertyChange } from "../web/lib/lang-property";
import { blockAt, languageName } from "../web/lib/languages";
import {
  anyKindEnabled,
  checkSignature,
  ignoredRules,
  KEYS,
  LANGUAGETOOL_PLUGIN_ID,
  languageToolChoice,
  writerCheckerActive,
} from "../web/lib/settings";
import type { Finding } from "../web/ipc";

const finding = (over: Partial<Finding> = {}): Finding => ({
  start: 0,
  end: 4,
  kind: "spelling",
  message: "Possible misspelling",
  replacements: ["a", "b", "c", "d", "e", "f"],
  ruleId: "SpellCheck",
  provider: "harper",
  ...over,
});

describe("diagnostics", () => {
  const handlers = { addWord: vi.fn(), ignoreRule: vi.fn() };

  it("maps severity, caps replacements and clamps offsets", () => {
    const [d, s] = toDiagnostics(
      [finding(), finding({ kind: "style", ruleId: "Wordy", start: 2, end: 99 })],
      10,
      handlers,
    );
    expect(d!.severity).toBe("warning");
    expect(s).toMatchObject({ severity: "info", from: 2, to: 10 });
    // replacements plus "Add to dictionary" for a word rule; "Ignore rule" for the others
    expect(d!.actions).toHaveLength(MAX_REPLACEMENTS + 1);
    expect(d!.actions!.at(-1)!.name).toBe("Add to dictionary");
    expect(s!.actions!.at(-1)!.name).toBe("Ignore rule");
  });

  it("drops a finding that fell past the end of the document", () => {
    expect(toDiagnostics([finding({ start: 20, end: 25 })], 10, handlers)).toEqual([]);
  });

  it("replace edits the text, add-word and ignore-rule call the handlers", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "teh cat" }) });
    const [d] = toDiagnostics([finding({ end: 3, replacements: ["the"] })], 7, handlers);
    d!.actions![0]!.apply(view, 0, 3);
    expect(view.state.doc.toString()).toBe("the cat");
    d!.actions![1]!.apply(view, 4, 7);
    expect(handlers.addWord).toHaveBeenCalledWith("cat");
    const [g] = toDiagnostics([finding({ ruleId: "ShouldOf", kind: "grammar" })], 7, handlers);
    g!.actions!.at(-1)!.apply(view, 0, 3);
    expect(handlers.ignoreRule).toHaveBeenCalledWith("ShouldOf");
    view.destroy();
  });
});

describe("languagePropertyChange", () => {
  const apply = (text: string, tag: string) => {
    const c = languagePropertyChange(text, tag);
    return text.slice(0, c.from) + c.insert + text.slice(c.to);
  };

  it("creates, extends and replaces front matter", () => {
    expect(apply("Hello", "fr")).toBe("---\nlang: fr\n---\n\nHello");
    expect(apply("---\ntitle: x\n---\nHi", "fr")).toBe("---\ntitle: x\nlang: fr\n---\nHi");
    expect(apply("---\nlanguage: de\ntitle: x\n---\nHi", "fr")).toBe(
      "---\nlang: fr\ntitle: x\n---\nHi",
    );
  });

  it("keeps CRLF and ignores an unclosed block", () => {
    expect(apply("---\r\ntitle: x\r\n---\r\nHi", "fr")).toBe(
      "---\r\ntitle: x\r\nlang: fr\r\n---\r\nHi",
    );
    expect(apply("---\nnot closed", "fr").startsWith("---\nlang: fr\n---\n\n---")).toBe(true);
  });
});

describe("languages", () => {
  it("names tags and falls back to the tag", () => {
    expect(languageName("fr")).toBe("French");
    expect(languageName("not a tag!")).toBe("not a tag!");
  });

  it("finds the block at the cursor, the closest before it, or the first", () => {
    const b = (start: number, end: number, lang: string) =>
      ({ start, end, lang, source: "default" }) as never;
    const blocks = [b(5, 10, "en"), b(20, 30, "fr")];
    expect(blockAt(blocks, 22)).toMatchObject({ lang: "fr" });
    expect(blockAt(blocks, 15)).toMatchObject({ lang: "en" });
    expect(blockAt(blocks, 0)).toMatchObject({ lang: "en" });
    expect(blockAt([], 0)).toBeNull();
    expect(blockAt(undefined, 0)).toBeNull();
  });
});

describe("settings readers", () => {
  beforeEach(() => setRunningCommunityPlugins([]));

  it("reads the defaults and the stored values", () => {
    expect(anyKindEnabled({})).toBe(true);
    expect(anyKindEnabled({ [KEYS.spelling]: false, [KEYS.grammar]: false })).toBe(false);
    expect(
      anyKindEnabled({ [KEYS.spelling]: false, [KEYS.grammar]: false, [KEYS.style]: true }),
    ).toBe(true);
    expect(languageToolChoice({})).toBe("ask");
    expect(languageToolChoice({ [KEYS.languageTool]: "both" })).toBe("both");
    expect(languageToolChoice({ [KEYS.languageTool]: "nonsense" })).toBe("ask");
    expect(ignoredRules({ [KEYS.ignoredRules]: ["A", 3] })).toEqual(["A"]);
    expect(checkSignature({})).not.toBe(checkSignature({ [KEYS.style]: true }));
  });

  it("yields to LanguageTool only when chosen and the plugin runs", () => {
    const chosen = { [KEYS.languageTool]: "languagetool" };
    expect(writerCheckerActive(chosen)).toBe(true);
    setRunningCommunityPlugins([LANGUAGETOOL_PLUGIN_ID]);
    expect(writerCheckerActive(chosen)).toBe(false);
    expect(writerCheckerActive({})).toBe(true);
    expect(writerCheckerActive({ [KEYS.languageTool]: "both" })).toBe(true);
  });
});
